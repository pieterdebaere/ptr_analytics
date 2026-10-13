// View maths: orthographic projection matching d3.geoOrthographic, drag /
// inertia / wheel / pinch helpers. All pure, no DOM.

import { geoOrthographic, type GeoProjection } from 'd3-geo';
import { clamp, clampZoom, wrapLon } from './scales';

const RAD = Math.PI / 180;

export interface View {
  /** longitude at the centre of the disc (degrees) */
  lon: number;
  /** latitude at the centre of the disc (degrees) */
  lat: number;
  /** zoom factor, 1 = globe fits the box */
  zoom: number;
}

export interface Viewport {
  width: number;
  height: number;
}

/** Latitude limit so the user can not flip the globe upside down. */
export const MAX_TILT = 80;

/** Globe radius at zoom 1 relative to half of the smaller side (room for the glow). */
export const FIT = 0.86;

export function globeRadius(vp: Viewport, zoom: number): number {
  return (Math.max(0, Math.min(vp.width, vp.height)) / 2) * FIT * zoom;
}

/** d3 projection for a view (used for paths and invert). */
export function makeProjection(view: View, vp: Viewport, projection: GeoProjection = geoOrthographic()): GeoProjection {
  return projection
    .scale(globeRadius(vp, view.zoom))
    .translate([vp.width / 2, vp.height / 2])
    .rotate([-view.lon, -view.lat, 0])
    .clipAngle(90)
    .precision(1.5);
}

/** Pre-computed trig for the view centre, reused for every dot in a frame. */
export interface ViewTrig {
  lambda0: number;
  sinPhi0: number;
  cosPhi0: number;
  cx: number;
  cy: number;
  r: number;
}

export function viewTrig(view: View, vp: Viewport): ViewTrig {
  const phi0 = view.lat * RAD;
  return {
    lambda0: view.lon * RAD,
    sinPhi0: Math.sin(phi0),
    cosPhi0: Math.cos(phi0),
    cx: vp.width / 2,
    cy: vp.height / 2,
    r: globeRadius(vp, view.zoom),
  };
}

export interface ProjectedPoint {
  x: number;
  y: number;
  /** cosine of the angular distance to the view centre: > 0 on the visible hemisphere */
  z: number;
}

/** Orthographic projection of a point given lambda (rad) and sin/cos of phi. */
export function projectTrig(t: ViewTrig, lambda: number, sinPhi: number, cosPhi: number, out: ProjectedPoint): ProjectedPoint {
  const dl = lambda - t.lambda0;
  const cosDl = Math.cos(dl);
  out.x = t.cx + t.r * cosPhi * Math.sin(dl);
  out.y = t.cy - t.r * (t.cosPhi0 * sinPhi - t.sinPhi0 * cosPhi * cosDl);
  out.z = t.sinPhi0 * sinPhi + t.cosPhi0 * cosPhi * cosDl;
  return out;
}

export function projectLonLat(t: ViewTrig, lon: number, lat: number, out: ProjectedPoint = { x: 0, y: 0, z: 0 }): ProjectedPoint {
  const phi = lat * RAD;
  return projectTrig(t, lon * RAD, Math.sin(phi), Math.cos(phi), out);
}

/** Degrees of rotation per dragged pixel so the grabbed point follows the pointer. */
export function degreesPerPixel(radius: number): number {
  return radius > 0 ? 1 / (radius * RAD) : 0;
}

/** Applies a drag of (dx, dy) CSS pixels to the view centre. */
export function applyDrag(view: View, dx: number, dy: number, radius: number): View {
  const k = degreesPerPixel(radius);
  return { ...view, lon: wrapLon(view.lon - dx * k), lat: clamp(view.lat + dy * k, -MAX_TILT, MAX_TILT) };
}

/** Exponential velocity decay; returns the remaining velocity after `dt` ms. */
export function decayVelocity(v: number, dt: number, tau = 320): number {
  return v * Math.exp(-Math.max(0, dt) / tau);
}

/** Velocity below which inertia stops (degrees / ms ~ 0.6°/s). */
export const INERTIA_EPSILON = 0.0006;

/**
 * Zoom multiplier for a wheel event. Trackpad pinch arrives as ctrl+wheel with
 * small deltas, mouse wheels as larger line/pixel deltas.
 */
export function wheelZoomFactor(e: { deltaY: number; deltaMode: number; ctrlKey: boolean }): number {
  let dy = e.deltaY;
  if (e.deltaMode === 1) dy *= 16;
  else if (e.deltaMode === 2) dy *= 400;
  if (!Number.isFinite(dy)) return 1;
  const k = e.ctrlKey ? 0.01 : 0.0018;
  return Math.exp(clamp(-dy * k, -0.5, 0.5));
}

/** Zoom after a two-finger pinch from `startDistance` to `distance`. */
export function pinchZoom(startZoom: number, startDistance: number, distance: number): number {
  if (!(startDistance > 0) || !(distance > 0)) return clampZoom(startZoom);
  return clampZoom(startZoom * (distance / startDistance));
}

/** Shortest signed longitude difference b - a in degrees. */
export function lonDelta(a: number, b: number): number {
  return wrapLon(b - a);
}

/** Point under the screen position, or null when outside the sphere. */
export function invertPoint(projection: GeoProjection, vp: Viewport, zoom: number, x: number, y: number): [number, number] | null {
  const r = globeRadius(vp, zoom);
  const dx = x - vp.width / 2;
  const dy = y - vp.height / 2;
  if (dx * dx + dy * dy > r * r) return null;
  const p = projection.invert?.([x, y]);
  if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return null;
  return [p[0], p[1]];
}
