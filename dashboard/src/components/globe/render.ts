// Canvas renderer: sphere + atmosphere, graticule, dot-matrix land tinted by
// value, country markers, hover outline and live ping ripples.

import { geoGraticule10, geoPath, type GeoProjection } from 'd3-geo';
import type { CountryShape, World } from './geo';
import type { LandDots } from './land-dots';
import { type GlobePalette, mix, type RGBA, rgba } from './palette';
import type { ActivePing } from './pings';
import { clamp, easeOutCubic } from './scales';
import { projectLonLat, projectTrig, type ProjectedPoint, type View, type Viewport, viewTrig } from './view';

export const TINT_BUCKETS = 5;
const DEPTH_LEVELS = 4;
const DEPTH_ALPHA = [0.18, 0.45, 0.75, 1] as const;
const DEPTH_RADIUS = [0.55, 0.72, 0.88, 1] as const;

export interface Marker {
  code: string;
  lon: number;
  lat: number;
  value: number;
  intensity: number;
  radius: number;
}

export interface RenderScene {
  ctx: CanvasRenderingContext2D;
  dpr: number;
  vp: Viewport;
  view: View;
  projection: GeoProjection;
  palette: GlobePalette;
  world: World | null;
  dots: LandDots | null;
  /** 0..1 fade-in of the land dots after they finished computing */
  dotsOpacity: number;
  /** per shape index: tint bucket 0..TINT_BUCKETS */
  shapeBuckets: Uint8Array | null;
  markers: readonly Marker[];
  hovered: readonly CountryShape[];
  hoveredCode: string | null;
  pings: readonly ActivePing[];
  pingProgress: (p: ActivePing) => number;
  reducedMotion: boolean;
}

const graticule = geoGraticule10();
const spriteCache = new Map<string, HTMLCanvasElement>();

/** Soft radial glow sprite, cached per colour (drawImage is far cheaper than per-marker gradients). */
function glowSprite(color: RGBA): HTMLCanvasElement | null {
  const key = rgba(color);
  const hit = spriteCache.get(key);
  if (hit) return hit;
  if (typeof document === 'undefined') return null;
  const size = 64;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d');
  if (!g) return null;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, rgba(color, 0.55));
  grad.addColorStop(0.35, rgba(color, 0.22));
  grad.addColorStop(1, rgba(color, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  if (spriteCache.size > 16) spriteCache.clear();
  spriteCache.set(key, c);
  return c;
}

/** Fade for points approaching the limb (z = cos of distance to the view centre). */
function limbFade(z: number): number {
  return clamp(z / 0.22, 0, 1);
}

// Re-used scratch buffers for the dot pass (x, y per dot, grouped by colour + depth).
let groupX: Float32Array[] = [];
let groupY: Float32Array[] = [];
let groupN: Int32Array = new Int32Array(0);
const scratch: ProjectedPoint = { x: 0, y: 0, z: 0 };

function ensureGroups(groups: number, capacity: number): void {
  if (groupX.length !== groups || (groupX[0]?.length ?? 0) < capacity) {
    groupX = Array.from({ length: groups }, () => new Float32Array(capacity));
    groupY = Array.from({ length: groups }, () => new Float32Array(capacity));
  }
  if (groupN.length !== groups) groupN = new Int32Array(groups);
  groupN.fill(0);
}

export function drawGlobe(s: RenderScene): void {
  const { ctx, dpr, vp, view, projection, palette: p } = s;
  const { width: w, height: h } = vp;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (w <= 0 || h <= 0) return;

  const t = viewTrig(view, vp);
  const { cx, cy, r } = t;
  const path = geoPath(projection, ctx);
  const dark = p.dark;

  // 1. Atmosphere halo behind the sphere.
  const haloR = r * 1.2;
  const halo = ctx.createRadialGradient(cx, cy, r * 0.94, cx, cy, haloR);
  halo.addColorStop(0, rgba(p.accent, dark ? 0.2 : 0.1));
  halo.addColorStop(0.35, rgba(p.accent, dark ? 0.07 : 0.035));
  halo.addColorStop(1, rgba(p.accent, 0));
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(cx, cy, haloR, 0, Math.PI * 2);
  ctx.fill();

  // 2. Sphere body: opaque page colour + soft light from the upper left.
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = rgba(p.background);
  ctx.fill();
  const body = ctx.createRadialGradient(cx - r * 0.4, cy - r * 0.45, r * 0.05, cx, cy, r * 1.05);
  body.addColorStop(0, rgba(p.foreground, dark ? 0.075 : 0.012));
  body.addColorStop(0.6, rgba(p.foreground, dark ? 0.035 : 0.022));
  body.addColorStop(1, rgba(p.foreground, dark ? 0.015 : 0.05));
  ctx.fillStyle = body;
  ctx.fill();

  // 3. Graticule.
  ctx.beginPath();
  path(graticule);
  ctx.lineWidth = 0.6;
  ctx.strokeStyle = rgba(p.border, dark ? 0.75 : 0.9);
  ctx.stroke();

  // 4. Land polygons (only once zoomed in, where the dots get sparse; polygon
  //    paths are the most expensive part of a frame) + tinted countries.
  const world = s.world;
  const zoomFill = clamp((view.zoom - 1.15) / 1.6, 0, 1);
  if (world && s.dotsOpacity > 0 && zoomFill > 0) {
    ctx.globalAlpha = s.dotsOpacity * zoomFill;
    ctx.beginPath();
    for (const shape of world.shapes) path(shape.feature);
    ctx.fillStyle = rgba(p.muted, dark ? 0.1 : 0.08);
    ctx.fill();
    ctx.lineWidth = 0.5;
    ctx.strokeStyle = rgba(p.muted, 0.28);
    ctx.stroke();
    const buckets = s.shapeBuckets;
    if (buckets) {
      for (let b = 1; b <= TINT_BUCKETS; b++) {
        let any = false;
        ctx.beginPath();
        for (const shape of world.shapes) {
          if (buckets[shape.index] === b) {
            path(shape.feature);
            any = true;
          }
        }
        if (any) {
          ctx.fillStyle = rgba(p.accent, (dark ? 0.05 : 0.04) + (b / TINT_BUCKETS) * (dark ? 0.13 : 0.1));
          ctx.fill();
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  // 5. Dot-matrix land.
  const dots = s.dots;
  if (dots && s.dotsOpacity > 0) {
    const groups = (TINT_BUCKETS + 1) * DEPTH_LEVELS;
    ensureGroups(groups, dots.count);
    const buckets = s.shapeBuckets;
    const margin = 4;
    for (let i = 0; i < dots.count; i++) {
      projectTrig(t, dots.lambda[i] ?? 0, dots.sinPhi[i] ?? 0, dots.cosPhi[i] ?? 1, scratch);
      const z = scratch.z;
      if (z <= 0.02) continue;
      const x = scratch.x;
      const y = scratch.y;
      if (x < -margin || y < -margin || x > w + margin || y > h + margin) continue;
      const depth = z < 0.15 ? 0 : z < 0.35 ? 1 : z < 0.6 ? 2 : 3;
      const bucket = buckets ? (buckets[dots.country[i] ?? 0] ?? 0) : 0;
      const g = bucket * DEPTH_LEVELS + depth;
      const n = groupN[g] ?? 0;
      const gx = groupX[g];
      const gy = groupY[g];
      if (!gx || !gy) continue;
      gx[n] = x;
      gy[n] = y;
      groupN[g] = n + 1;
    }
    const baseR = clamp(r * 0.0058, 0.8, 3.4);
    const baseAlpha = dark ? 0.5 : 0.55;
    for (let b = 0; b <= TINT_BUCKETS; b++) {
      const k = b / TINT_BUCKETS;
      const color = b === 0 ? p.muted : mix(p.muted, p.accent, 0.3 + 0.7 * k);
      const alpha = b === 0 ? baseAlpha : baseAlpha + (1 - baseAlpha) * (0.25 + 0.75 * k);
      const rScale = b === 0 ? 1 : 1.12 + 0.12 * k;
      for (let d = 0; d < DEPTH_LEVELS; d++) {
        const g = b * DEPTH_LEVELS + d;
        const n = groupN[g] ?? 0;
        const gx = groupX[g];
        const gy = groupY[g];
        if (n === 0 || !gx || !gy) continue;
        const rad = baseR * rScale * (DEPTH_RADIUS[d] ?? 1);
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const x = gx[i] ?? 0;
          const y = gy[i] ?? 0;
          ctx.moveTo(x + rad, y);
          ctx.arc(x, y, rad, 0, Math.PI * 2);
        }
        ctx.fillStyle = rgba(color, alpha * (DEPTH_ALPHA[d] ?? 1) * s.dotsOpacity);
        ctx.fill();
      }
    }
  }

  // 6. Hovered country.
  if (s.hovered.length > 0) {
    ctx.beginPath();
    for (const shape of s.hovered) path(shape.feature);
    ctx.fillStyle = rgba(p.accent, dark ? 0.16 : 0.1);
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = rgba(p.accent, 0.85);
    ctx.stroke();
  }

  // 7. Limb: crisp outline + inner atmospheric rim.
  const rim = ctx.createRadialGradient(cx, cy, r * 0.78, cx, cy, r);
  rim.addColorStop(0, rgba(p.accent, 0));
  rim.addColorStop(1, rgba(p.accent, dark ? 0.12 : 0.06));
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = rim;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = rgba(p.border, 1);
  ctx.stroke();

  // 8. Markers (largest last so they sit on top).
  const sprite = glowSprite(p.accent);
  for (const m of s.markers) {
    const pt = projectLonLat(t, m.lon, m.lat, scratch);
    if (pt.z <= 0) continue;
    const fade = limbFade(pt.z);
    const rad = m.radius * (0.65 + 0.35 * fade);
    if (sprite) {
      const gr = rad * (2.6 + m.intensity * 1.2);
      ctx.globalAlpha = fade * (0.3 + 0.45 * m.intensity);
      ctx.drawImage(sprite, pt.x - gr, pt.y - gr, gr * 2, gr * 2);
    }
    const hovered = s.hoveredCode === m.code;
    ctx.globalAlpha = fade;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, hovered ? rad + 1.5 : rad, 0, Math.PI * 2);
    ctx.fillStyle = rgba(p.accent, 0.92);
    ctx.fill();
    ctx.lineWidth = hovered ? 2 : 1.25;
    ctx.strokeStyle = rgba(p.background, 0.95);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // 9. Live pings.
  for (const ping of s.pings) {
    const pt = projectLonLat(t, ping.lon, ping.lat, scratch);
    if (pt.z <= 0) continue;
    const fade = limbFade(pt.z);
    const prog = clamp(s.pingProgress(ping), 0, 1);
    if (s.reducedMotion) {
      ctx.globalAlpha = fade;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 3, 0, Math.PI * 2);
      ctx.fillStyle = rgba(p.accent);
      ctx.fill();
      continue;
    }
    // two staggered ripple rings
    for (const delay of [0, 0.22]) {
      const q = clamp((prog - delay) / (1 - delay), 0, 1);
      if (q <= 0 || q >= 1) continue;
      const e = easeOutCubic(q);
      ctx.globalAlpha = fade * (1 - q) ** 1.6 * (delay === 0 ? 1 : 0.6);
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 3 + e * 24, 0, Math.PI * 2);
      ctx.lineWidth = 1.5 * (1 - e) + 0.5;
      ctx.strokeStyle = rgba(p.accent);
      ctx.stroke();
    }
    const pop = prog < 0.12 ? easeOutCubic(prog / 0.12) : 1;
    const life = prog < 0.12 ? 1 : 1 - easeOutCubic((prog - 0.12) / 0.88);
    if (sprite) {
      const gr = 14 * pop;
      ctx.globalAlpha = fade * life;
      ctx.drawImage(sprite, pt.x - gr, pt.y - gr, gr * 2, gr * 2);
    }
    ctx.globalAlpha = fade * life;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 2.6 * pop, 0, Math.PI * 2);
    ctx.fillStyle = rgba(mix(p.accent, dark ? p.foreground : p.accent, 0.35));
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}
