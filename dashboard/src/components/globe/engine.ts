// Imperative globe engine: owns the canvas, the view state, input handling
// and an on-demand render loop (rAF runs only while something moves).

import { geoOrthographic, type GeoProjection } from 'd3-geo';
import { normalizeAlpha2 } from './country-codes';
import { type CountryShape, countryCentroid, countrySpread, findCountryAt, getWorld, type LonLat, shapesForCode, type World } from './geo';
import { type LandDots, loadLandDots, peekLandDots } from './land-dots';
import { type GlobePalette, paletteKey, readPalette, rgba } from './palette';
import { PingTracker, type PingInput } from './pings';
import { drawGlobe, type Marker, TINT_BUCKETS } from './render';
import {
  clamp,
  clampZoom,
  createIntensityScale,
  easeInOutCubic,
  easeOutCubic,
  intensityBucket,
  jitterOffset,
  MAX_ZOOM,
  MIN_ZOOM,
  markerRadius,
  wrapLon,
} from './scales';
import {
  applyDrag,
  decayVelocity,
  globeRadius,
  INERTIA_EPSILON,
  invertPoint,
  lonDelta,
  MAX_TILT,
  makeProjection,
  pinchZoom,
  projectLonLat,
  type View,
  type Viewport,
  viewTrig,
  wheelZoomFactor,
} from './view';

export interface HoverInfo {
  code: string;
  value: number;
  /** share of the total (0..1) */
  share: number;
  /** pointer position relative to the container (CSS px) */
  x: number;
  y: number;
  /** accent colour (CSS rgba) for the tooltip swatch */
  color: string;
}

export interface GlobeEngineOptions {
  autoRotate: boolean;
  scrollZoom: boolean;
  accentColor?: string;
  initialCenter: LonLat;
  onHover?: (hover: HoverInfo | null) => void;
  onZoom?: (zoom: number) => void;
}

interface Tween {
  from: View;
  to: View;
  start: number;
  duration: number;
}

interface PointerInfo {
  x: number;
  y: number;
  type: string;
}

/** Auto-rotation speed (degrees per ms) and resume delay after interaction. */
const AUTO_SPEED = 0.0045;
const AUTO_RESUME_MS = 3000;
const DOTS_FADE_MS = 700;

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function mediaMatches(query: string): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

export class GlobeEngine {
  private readonly container: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private opts: GlobeEngineOptions;

  private vp: Viewport = { width: 0, height: 0 };
  private dpr = 1;
  private view: View;
  private readonly projection: GeoProjection = geoOrthographic();
  private palette: GlobePalette;
  private paletteSig = '';

  private world: World | null = null;
  private dots: LandDots | null = null;
  private dotsLoadedAt = 0;

  // data
  private values = new Map<string, number>();
  private total = 0;
  private markers: Marker[] = [];
  private shapeBuckets: Uint8Array | null = null;
  private readonly pings = new PingTracker({ duration: 2500, maxSeen: 1000, maxActive: 64 });

  // motion
  private vLon = 0;
  private vLat = 0;
  private tween: Tween | null = null;
  private autoSpeed = 0;
  private lastInteraction = -Infinity;
  private pointers = new Map<number, PointerInfo>();
  private dragLast: { x: number; y: number; t: number } | null = null;
  private dragStart: { x: number; y: number; t: number } | null = null;
  private pinch: { distance: number; zoom: number } | null = null;
  private mouseHover = false;
  private pointerPos: { x: number; y: number; type: string } | null = null;
  private hover: HoverInfo | null = null;
  private hoverShapes: readonly CountryShape[] = [];
  private stickyHover = false;

  // loop
  private raf = 0;
  private lastFrame = 0;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private onScreen = true;
  private pageVisible = true;
  private reducedMotion = false;
  private destroyed = false;
  private readonly cleanups: (() => void)[] = [];
  private lastZoomReported = 1;

  constructor(container: HTMLElement, canvas: HTMLCanvasElement, opts: GlobeEngineOptions) {
    this.container = container;
    this.canvas = canvas;
    this.opts = opts;
    this.view = { lon: wrapLon(opts.initialCenter[0]), lat: clamp(opts.initialCenter[1], -MAX_TILT, MAX_TILT), zoom: 1 };
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas.getContext('2d');
    } catch {
      ctx = null;
    }
    this.ctx = ctx;
    this.palette = readPalette(container, opts.accentColor);
    this.paletteSig = paletteKey(this.palette);
    this.reducedMotion = mediaMatches('(prefers-reduced-motion: reduce)');
    this.pageVisible = typeof document === 'undefined' || document.visibilityState !== 'hidden';
    this.attach();
    this.measure();
    this.loadGeometry();
    this.invalidate();
  }

  // ---------------------------------------------------------------- public

  setOptions(opts: Partial<GlobeEngineOptions>): void {
    const accentChanged = opts.accentColor !== undefined && opts.accentColor !== this.opts.accentColor;
    this.opts = { ...this.opts, ...opts };
    if (accentChanged || ('accentColor' in opts && opts.accentColor === undefined)) this.refreshPalette();
    this.invalidate();
  }

  setCountries(list: readonly { country: string; value: number }[] | undefined | null): void {
    const values = new Map<string, number>();
    for (const item of list ?? []) {
      if (!item) continue;
      const code = normalizeAlpha2(item.country);
      const v = Number(item.value);
      if (!code || !Number.isFinite(v) || v <= 0) continue;
      values.set(code, (values.get(code) ?? 0) + v);
    }
    this.values = values;
    this.rebuildData();
    this.updateHoverValue();
    this.invalidate();
  }

  setPings(list: readonly PingInput[] | undefined | null): void {
    const added = this.pings.ingest(list, now(), (p) => this.locatePing(p));
    if (added > 0) this.invalidate();
  }

  zoomBy(factor: number): void {
    const base = this.tween ? this.tween.to : this.view;
    this.animateTo({ ...base, zoom: clampZoom(base.zoom * factor) }, 420);
  }

  resetView(): void {
    const [lon, lat] = this.opts.initialCenter;
    this.animateTo({ lon: wrapLon(lon), lat: clamp(lat, -MAX_TILT, MAX_TILT), zoom: 1 }, 900);
  }

  get zoom(): number {
    return this.view.zoom;
  }

  /** Re-reads the CSS variables (theme switch). */
  refreshPalette(): void {
    const next = readPalette(this.container, this.opts.accentColor);
    const sig = paletteKey(next);
    if (sig === this.paletteSig) return;
    this.palette = next;
    this.paletteSig = sig;
    if (this.hover) this.setHover({ ...this.hover, color: rgba(next.accent) });
    this.invalidate();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    for (const fn of this.cleanups.splice(0)) fn();
  }

  // ---------------------------------------------------------------- data

  private loadGeometry(): void {
    const ready = peekLandDots();
    if (ready) {
      this.world = getWorld();
      this.dots = ready;
      this.dotsLoadedAt = -Infinity;
      this.rebuildData();
      return;
    }
    loadLandDots()
      .then((dots) => {
        if (this.destroyed) return;
        this.world = getWorld();
        this.dots = dots;
        this.dotsLoadedAt = this.reducedMotion ? -Infinity : now();
        this.rebuildData();
        this.invalidate();
      })
      .catch(() => {
        /* geometry unavailable: the globe still renders sphere + graticule */
      });
  }

  private rebuildData(): void {
    const scale = createIntensityScale(this.values.values());
    let total = 0;
    let max = 0;
    for (const v of this.values.values()) if (v > max) max = v;
    const markers: Marker[] = [];
    for (const [code, value] of this.values) {
      total += value;
      const c = countryCentroid(code);
      if (!c) continue; // unknown country: ignored
      const intensity = scale(value);
      markers.push({ code, lon: c[0], lat: c[1], value, intensity, radius: markerRadius(max > 0 ? value / max : 0) });
    }
    markers.sort((a, b) => a.value - b.value);
    this.markers = markers;
    this.total = total;
    if (this.world) {
      const buckets = new Uint8Array(this.world.shapes.length);
      for (const shape of this.world.shapes) {
        if (!shape.code) continue;
        const v = this.values.get(shape.code);
        if (v) buckets[shape.index] = intensityBucket(scale(v), TINT_BUCKETS);
      }
      this.shapeBuckets = buckets;
    }
  }

  private locatePing(p: PingInput): LonLat | null {
    const c = countryCentroid(p.country);
    if (!c) return null;
    const [dx, dy] = jitterOffset(p.id, countrySpread(p.country));
    return [c[0] + dx, clamp(c[1] + dy, -89, 89)];
  }

  // ---------------------------------------------------------------- DOM wiring

  private listen<K extends keyof HTMLElementEventMap>(
    el: HTMLElement,
    type: K,
    fn: (e: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): void {
    el.addEventListener(type, fn as EventListener, options);
    this.cleanups.push(() => el.removeEventListener(type, fn as EventListener, options));
  }

  private attach(): void {
    const { canvas, container } = this;
    this.listen(canvas, 'pointerdown', (e) => this.onPointerDown(e));
    this.listen(canvas, 'pointermove', (e) => this.onPointerMove(e));
    this.listen(canvas, 'pointerup', (e) => this.onPointerUp(e));
    this.listen(canvas, 'pointercancel', (e) => this.onPointerUp(e));
    this.listen(canvas, 'pointerleave', (e) => {
      if (!this.pointers.has(e.pointerId) && e.pointerType !== 'touch') {
        this.pointerPos = null;
        this.setHover(null);
      }
    });
    this.listen(canvas, 'wheel', (e) => this.onWheel(e), { passive: false });
    this.listen(container, 'pointerenter', (e) => {
      if (e.pointerType !== 'touch') {
        this.mouseHover = true;
        this.autoSpeed = 0;
      }
    });
    this.listen(container, 'pointerleave', (e) => {
      if (e.pointerType !== 'touch') {
        this.mouseHover = false;
        this.lastInteraction = now() - AUTO_RESUME_MS * 0.6; // resume a little sooner after leaving
        this.invalidate();
      }
    });
    this.listen(container, 'keydown', (e) => this.onKey(e));

    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => {
        this.measure();
        this.invalidate();
      });
      ro.observe(container);
      this.cleanups.push(() => ro.disconnect());
    }
    if (typeof IntersectionObserver !== 'undefined') {
      const io = new IntersectionObserver((entries) => {
        const entry = entries[entries.length - 1];
        if (!entry) return;
        this.onScreen = entry.isIntersecting;
        if (this.onScreen) this.invalidate();
      });
      io.observe(container);
      this.cleanups.push(() => io.disconnect());
    }
    if (typeof document !== 'undefined') {
      const onVis = () => {
        this.pageVisible = document.visibilityState !== 'hidden';
        if (this.pageVisible) this.invalidate();
      };
      document.addEventListener('visibilitychange', onVis);
      this.cleanups.push(() => document.removeEventListener('visibilitychange', onVis));
      // Theme switches toggle a class / data attribute on <html>.
      if (typeof MutationObserver !== 'undefined') {
        const mo = new MutationObserver(() => this.refreshPalette());
        mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
        this.cleanups.push(() => mo.disconnect());
      }
    }
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      const watch = (query: string, fn: (matches: boolean) => void) => {
        try {
          const mq = window.matchMedia(query);
          const handler = () => fn(mq.matches);
          mq.addEventListener?.('change', handler);
          this.cleanups.push(() => mq.removeEventListener?.('change', handler));
        } catch {
          /* ignore */
        }
      };
      watch('(prefers-reduced-motion: reduce)', (m) => {
        this.reducedMotion = m;
        this.invalidate();
      });
      watch('(prefers-color-scheme: dark)', () => this.refreshPalette());
    }
  }

  private measure(): void {
    const rect = this.container.getBoundingClientRect();
    const width = Math.max(0, Math.round(rect.width));
    const height = Math.max(0, Math.round(rect.height));
    const dpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2);
    this.vp = { width, height };
    this.dpr = dpr;
    const bw = Math.max(1, Math.round(width * dpr));
    const bh = Math.max(1, Math.round(height * dpr));
    if (this.canvas.width !== bw) this.canvas.width = bw;
    if (this.canvas.height !== bh) this.canvas.height = bh;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
  }

  private localPoint(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  // ---------------------------------------------------------------- input

  private markInteraction(): void {
    this.lastInteraction = now();
    this.autoSpeed = 0;
  }

  private pointerCentroid(): { x: number; y: number; distance: number } {
    let x = 0;
    let y = 0;
    const pts = [...this.pointers.values()];
    for (const p of pts) {
      x += p.x;
      y += p.y;
    }
    const n = Math.max(1, pts.length);
    const a = pts[0];
    const b = pts[1];
    const distance = a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
    return { x: x / n, y: y / n, distance };
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const pt = this.localPoint(e);
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    this.pointers.set(e.pointerId, { ...pt, type: e.pointerType });
    this.tween = null;
    this.vLon = 0;
    this.vLat = 0;
    this.markInteraction();
    const c = this.pointerCentroid();
    const t = now();
    this.dragLast = { x: c.x, y: c.y, t };
    if (this.pointers.size === 1) this.dragStart = { x: pt.x, y: pt.y, t };
    else this.dragStart = null;
    this.pinch = this.pointers.size >= 2 ? { distance: c.distance, zoom: this.view.zoom } : null;
    this.stickyHover = false;
    if (this.pointers.size > 1 || e.pointerType === 'touch') this.setHover(null);
    this.canvas.style.cursor = 'grabbing';
  }

  private onPointerMove(e: PointerEvent): void {
    const pt = this.localPoint(e);
    const tracked = this.pointers.get(e.pointerId);
    if (!tracked) {
      if (e.pointerType !== 'touch') {
        this.pointerPos = { ...pt, type: e.pointerType };
        this.updateHover();
      }
      return;
    }
    tracked.x = pt.x;
    tracked.y = pt.y;
    const c = this.pointerCentroid();
    const last = this.dragLast;
    const t = now();
    if (this.pinch && this.pointers.size >= 2 && c.distance > 0) {
      this.view = { ...this.view, zoom: pinchZoom(this.pinch.zoom, this.pinch.distance, c.distance) };
    }
    if (last) {
      const dx = c.x - last.x;
      const dy = c.y - last.y;
      const r = globeRadius(this.vp, this.view.zoom);
      const next = applyDrag(this.view, dx, dy, r);
      const dt = Math.max(1, t - last.t);
      const instLon = lonDelta(this.view.lon, next.lon) / dt;
      const instLat = (next.lat - this.view.lat) / dt;
      this.vLon = this.vLon * 0.25 + instLon * 0.75;
      this.vLat = this.vLat * 0.25 + instLat * 0.75;
      this.view = next;
    }
    this.dragLast = { x: c.x, y: c.y, t };
    this.markInteraction();
    if (this.hover && !this.stickyHover) this.setHover(null);
    this.invalidate();
  }

  private onPointerUp(e: PointerEvent): void {
    if (!this.pointers.has(e.pointerId)) return;
    const pt = this.localPoint(e);
    this.pointers.delete(e.pointerId);
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const t = now();
    if (this.pointers.size === 0) {
      const start = this.dragStart;
      const isTap = start && Math.hypot(pt.x - start.x, pt.y - start.y) < 6 && t - start.t < 350;
      if (isTap) {
        // Tap / click: show the tooltip for the touched country (sticky until the next drag).
        this.vLon = 0;
        this.vLat = 0;
        this.pointerPos = { ...pt, type: e.pointerType };
        this.updateHover();
        this.stickyHover = e.pointerType === 'touch' && this.hover !== null;
      } else if (this.reducedMotion || !this.dragLast || t - this.dragLast.t > 80 || e.type === 'pointercancel') {
        this.vLon = 0;
        this.vLat = 0;
      }
      this.dragLast = null;
      this.dragStart = null;
      this.pinch = null;
      this.canvas.style.cursor = 'grab';
    } else {
      // One finger left the pinch: continue dragging with the remaining one.
      const c = this.pointerCentroid();
      this.dragLast = { x: c.x, y: c.y, t };
      this.pinch = this.pointers.size >= 2 ? { distance: c.distance, zoom: this.view.zoom } : null;
    }
    this.markInteraction();
    this.invalidate();
  }

  private onWheel(e: WheelEvent): void {
    if (!this.opts.scrollZoom) return;
    const factor = wheelZoomFactor(e);
    const from = this.tween ? this.tween.to.zoom : this.view.zoom;
    const zoom = clampZoom(from * factor);
    // At a zoom limit let the page scroll instead of swallowing the wheel.
    if (Math.abs(zoom - this.view.zoom) < 1e-4) return;
    e.preventDefault();
    const pt = this.localPoint(e);
    this.tween = null;
    // Keep the point under the cursor roughly in place while zooming.
    const before = invertPoint(makeProjection(this.view, this.vp, this.projection), this.vp, this.view.zoom, pt.x, pt.y);
    const zoomed: View = { ...this.view, zoom };
    const after = invertPoint(makeProjection(zoomed, this.vp, this.projection), this.vp, zoom, pt.x, pt.y);
    if (before && after) {
      zoomed.lon = wrapLon(zoomed.lon + lonDelta(after[0], before[0]));
      zoomed.lat = clamp(zoomed.lat + (before[1] - after[1]), -MAX_TILT, MAX_TILT);
    }
    this.view = zoomed;
    this.vLon = 0;
    this.vLat = 0;
    this.markInteraction();
    this.invalidate();
  }

  private onKey(e: KeyboardEvent): void {
    if (e.target !== this.container || e.altKey || e.metaKey || e.ctrlKey) return;
    const base = this.tween ? this.tween.to : this.view;
    const step = 20 / Math.sqrt(base.zoom);
    let handled = true;
    switch (e.key) {
      case 'ArrowLeft':
        this.animateTo({ ...base, lon: base.lon - step }, 380);
        break;
      case 'ArrowRight':
        this.animateTo({ ...base, lon: base.lon + step }, 380);
        break;
      case 'ArrowUp':
        this.animateTo({ ...base, lat: clamp(base.lat + step * 0.6, -MAX_TILT, MAX_TILT) }, 380);
        break;
      case 'ArrowDown':
        this.animateTo({ ...base, lat: clamp(base.lat - step * 0.6, -MAX_TILT, MAX_TILT) }, 380);
        break;
      case '+':
      case '=':
        this.zoomBy(1.5);
        break;
      case '-':
      case '_':
        this.zoomBy(1 / 1.5);
        break;
      case '0':
        this.resetView();
        break;
      default:
        handled = false;
    }
    if (handled) e.preventDefault();
  }

  private animateTo(target: View, duration: number): void {
    this.markInteraction();
    this.vLon = 0;
    this.vLat = 0;
    const to: View = { lon: target.lon, lat: clamp(target.lat, -MAX_TILT, MAX_TILT), zoom: clampZoom(target.zoom) };
    if (this.reducedMotion) {
      this.view = { ...to, lon: wrapLon(to.lon) };
      this.tween = null;
    } else {
      this.tween = { from: { ...this.view }, to, start: now(), duration };
    }
    this.invalidate();
  }

  // ---------------------------------------------------------------- hover

  private hitTest(x: number, y: number): string | null {
    const t = viewTrig(this.view, this.vp);
    // Markers first: tiny countries are easier to hit through their dot.
    let best: string | null = null;
    let bestD = Infinity;
    for (const m of this.markers) {
      const p = projectLonLat(t, m.lon, m.lat);
      if (p.z <= 0.05) continue;
      const d = Math.hypot(p.x - x, p.y - y);
      if (d <= m.radius + 5 && d < bestD) {
        bestD = d;
        best = m.code;
      }
    }
    if (best) return best;
    if (!this.world) return null;
    const ll = invertPoint(makeProjection(this.view, this.vp, this.projection), this.vp, this.view.zoom, x, y);
    if (!ll) return null;
    return findCountryAt(ll[0], ll[1])?.code ?? null;
  }

  private updateHover(): void {
    const pos = this.pointerPos;
    if (!pos || this.pointers.size > 0) return;
    const code = this.hitTest(pos.x, pos.y);
    if (!code) {
      this.setHover(null);
      return;
    }
    const value = this.values.get(code) ?? 0;
    this.setHover({
      code,
      value,
      share: this.total > 0 ? value / this.total : 0,
      x: pos.x,
      y: pos.y,
      color: rgba(this.palette.accent),
    });
  }

  private updateHoverValue(): void {
    if (!this.hover) return;
    const value = this.values.get(this.hover.code) ?? 0;
    this.setHover({ ...this.hover, value, share: this.total > 0 ? value / this.total : 0 });
  }

  private setHover(next: HoverInfo | null): void {
    const prev = this.hover;
    if (
      prev === next ||
      (prev &&
        next &&
        prev.code === next.code &&
        prev.x === next.x &&
        prev.y === next.y &&
        prev.value === next.value &&
        prev.color === next.color)
    ) {
      return;
    }
    const codeChanged = (prev?.code ?? null) !== (next?.code ?? null);
    this.hover = next;
    if (!next) this.stickyHover = false;
    if (codeChanged) {
      this.hoverShapes = next ? shapesForCode(next.code) : [];
      this.invalidate();
    }
    this.opts.onHover?.(next);
  }

  // ---------------------------------------------------------------- loop

  private isShown(): boolean {
    return this.onScreen && this.pageVisible && !this.destroyed;
  }

  /** Schedules a frame (no-op while off-screen or already scheduled). */
  invalidate(): void {
    if (this.raf !== 0 || !this.isShown() || typeof requestAnimationFrame !== 'function') return;
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }
    this.raf = requestAnimationFrame(this.frame);
  }

  private autoRotateActive(t: number): boolean {
    return (
      this.opts.autoRotate &&
      !this.reducedMotion &&
      !this.mouseHover &&
      !this.stickyHover &&
      this.pointers.size === 0 &&
      this.tween === null &&
      this.vLon === 0 &&
      this.vLat === 0 &&
      t - this.lastInteraction >= AUTO_RESUME_MS
    );
  }

  /** Advances the simulation; returns true while another frame is needed. */
  private step(t: number, dt: number): boolean {
    let busy = false;
    const tw = this.tween;
    if (tw) {
      const k = clamp((t - tw.start) / tw.duration, 0, 1);
      const e = tw.to.zoom !== tw.from.zoom && tw.to.lon === tw.from.lon ? easeOutCubic(k) : easeInOutCubic(k);
      this.view = {
        lon: wrapLon(tw.from.lon + lonDelta(tw.from.lon, tw.to.lon) * e),
        lat: tw.from.lat + (tw.to.lat - tw.from.lat) * e,
        zoom: tw.from.zoom + (tw.to.zoom - tw.from.zoom) * e,
      };
      if (k >= 1) {
        this.tween = null;
        this.lastInteraction = t;
      } else busy = true;
    }
    if (this.pointers.size === 0 && (this.vLon !== 0 || this.vLat !== 0)) {
      this.view = {
        ...this.view,
        lon: wrapLon(this.view.lon + this.vLon * dt),
        lat: clamp(this.view.lat + this.vLat * dt, -MAX_TILT, MAX_TILT),
      };
      this.vLon = decayVelocity(this.vLon, dt);
      this.vLat = decayVelocity(this.vLat, dt);
      if (Math.hypot(this.vLon, this.vLat) < INERTIA_EPSILON) {
        this.vLon = 0;
        this.vLat = 0;
        this.lastInteraction = t;
      } else busy = true;
    }
    if (this.autoRotateActive(t)) {
      // ease into the spin instead of starting abruptly
      this.autoSpeed += (AUTO_SPEED - this.autoSpeed) * (1 - Math.exp(-dt / 900));
      this.view = { ...this.view, lon: wrapLon(this.view.lon - this.autoSpeed * dt) };
      busy = true;
    } else {
      this.autoSpeed = 0;
    }
    if (this.dots && this.dotsLoadedAt > 0 && t - this.dotsLoadedAt < DOTS_FADE_MS) busy = true;
    const active = this.pings.prune(t);
    if (active.length > 0 && !this.reducedMotion) busy = true;
    return busy;
  }

  private frame = (t: number): void => {
    this.raf = 0;
    if (this.destroyed) return;
    const dt = this.lastFrame > 0 ? Math.min(64, Math.max(0, t - this.lastFrame)) : 16;
    this.lastFrame = t;
    const before = this.view;
    const busy = this.step(t, dt);
    if (before !== this.view && this.pointerPos && this.pointers.size === 0 && !this.stickyHover) this.updateHover();
    this.draw(t);
    if (this.view.zoom !== this.lastZoomReported) {
      this.lastZoomReported = this.view.zoom;
      this.opts.onZoom?.(this.view.zoom);
    }
    if (busy) {
      this.invalidate();
    } else {
      this.lastFrame = 0;
      this.scheduleWake(t);
    }
  };

  /** While idle, wake up later for auto-rotation resume or static-ping expiry. */
  private scheduleWake(t: number): void {
    let wait: number | null = null;
    if (this.opts.autoRotate && !this.reducedMotion && !this.mouseHover && !this.stickyHover && this.pointers.size === 0) {
      wait = Math.max(16, this.lastInteraction + AUTO_RESUME_MS - t + 16);
    }
    const expiry = this.pings.nextExpiry(t);
    if (expiry !== null) wait = wait === null ? expiry + 16 : Math.min(wait, expiry + 16);
    if (wait === null) return;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      this.invalidate();
    }, wait);
  }

  private draw(t: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    let dotsOpacity = 0;
    if (this.dots) {
      dotsOpacity = this.dotsLoadedAt > 0 ? easeOutCubic((t - this.dotsLoadedAt) / DOTS_FADE_MS) : 1;
    }
    drawGlobe({
      ctx,
      dpr: this.dpr,
      vp: this.vp,
      view: this.view,
      projection: makeProjection(this.view, this.vp, this.projection),
      palette: this.palette,
      world: this.world,
      dots: this.dots,
      dotsOpacity,
      shapeBuckets: this.shapeBuckets,
      markers: this.markers,
      hovered: this.hoverShapes,
      hoveredCode: this.hover?.code ?? null,
      pings: this.pings.prune(t),
      pingProgress: (p) => this.pings.progress(p, t),
      reducedMotion: this.reducedMotion,
    });
  }
}

export { MAX_ZOOM, MIN_ZOOM };
