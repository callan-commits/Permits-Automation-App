/** Plane geometry helpers in projected (grid) metres. */
import type { CadFeature, XY } from '../cad/types';

/** Rectangle from a baseline p1->p2 and a signed width to its left (+) or right (-). */
export function rectangleFromBaseline(p1: XY, p2: XY, width: number): XY[] {
  const dx = p2[0] - p1[0];
  const dy = p2[1] - p1[1];
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * width;
  const ny = (dx / len) * width;
  return [p1, p2, [p2[0] + nx, p2[1] + ny], [p1[0] + nx, p1[1] + ny], p1];
}

/** Signed perpendicular distance of p from the line a->b (+ve to the left). */
export function signedOffset(a: XY, b: XY, p: XY): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  return (dx * (p[1] - a[1]) - dy * (p[0] - a[0])) / len;
}

export interface BoxDimensions {
  /** Longer side, m */
  length: number;
  /** Shorter side, m */
  width: number;
  area: number;
  /** Grid bearing of the long side, degrees 0-180 clockwise from grid north. */
  bearing: number;
  centre: XY;
}

export function boxDimensions(ring: XY[]): BoxDimensions {
  const [a, b, c] = ring;
  const s1 = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const s2 = Math.hypot(c[0] - b[0], c[1] - b[1]);
  const [p, q] = s1 >= s2 ? [a, b] : [b, c];
  let bearing = (Math.atan2(q[0] - p[0], q[1] - p[1]) * 180) / Math.PI;
  bearing = ((bearing % 180) + 180) % 180;
  const pts = ring.slice(0, 4);
  const centre: XY = [pts.reduce((s, v) => s + v[0], 0) / pts.length, pts.reduce((s, v) => s + v[1], 0) / pts.length];
  return { length: Math.max(s1, s2), width: Math.min(s1, s2), area: s1 * s2, bearing, centre };
}

export function pointInPolygon(p: XY, ring: XY[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pointSegmentDistance(p: XY, a: XY, b: XY): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function segmentsIntersect(a: XY, b: XY, c: XY, d: XY): boolean {
  const o = (p: XY, q: XY, r: XY) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a);
  const d2 = o(c, d, b);
  const d3 = o(a, b, c);
  const d4 = o(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function segmentSegmentDistance(a: XY, b: XY, c: XY, d: XY): number {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d), pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b));
}

/** Shortest distance (m) from a closed polygon ring to a polyline; 0 if they touch or the line is inside. */
export function polygonToLineDistance(ring: XY[], line: XY[]): number {
  if (line.some((p) => pointInPolygon(p, ring))) return 0;
  let best = Infinity;
  for (let i = 0; i < line.length - 1 || (line.length === 1 && i === 0); i++) {
    const a = line[i];
    const b = line[i + 1] ?? a;
    for (let j = 0; j < ring.length - 1; j++) {
      const dist = segmentSegmentDistance(a, b, ring[j], ring[j + 1]);
      if (dist < best) best = dist;
      if (best === 0) return 0;
    }
  }
  return best;
}

export function featureDistance(ring: XY[], f: CadFeature): number {
  switch (f.kind) {
    case 'line':
      return polygonToLineDistance(ring, f.coords);
    case 'polygon':
      if (f.rings.some((r) => r.some((p) => pointInPolygon(p, ring))) || ring.some((p) => pointInPolygon(p, f.rings[0]))) return 0;
      return Math.min(...f.rings.map((r) => polygonToLineDistance(ring, r)));
    default:
      return polygonToLineDistance(ring, [f.coord]);
  }
}

export interface NearbyLayer {
  layer: string;
  color: string;
  /** Minimum distance from the box edge, m (0 = within or crossing the box). */
  minDistance: number;
  featureCount: number;
}

/**
 * Utilities (non-text features) within `radius` metres of the box, grouped by layer.
 * Preliminary: the permit rules will replace this with per-owner offset checks.
 */
export function nearbyByLayer(ring: XY[], features: CadFeature[], radius: number, ignoreLayers: Set<string> = new Set()): NearbyLayer[] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of ring) {
    minX = Math.min(minX, x - radius);
    minY = Math.min(minY, y - radius);
    maxX = Math.max(maxX, x + radius);
    maxY = Math.max(maxY, y + radius);
  }
  const bboxHit = (pts: XY[]) => {
    let fx0 = Infinity;
    let fy0 = Infinity;
    let fx1 = -Infinity;
    let fy1 = -Infinity;
    for (const [x, y] of pts) {
      if (x < fx0) fx0 = x;
      if (y < fy0) fy0 = y;
      if (x > fx1) fx1 = x;
      if (y > fy1) fy1 = y;
    }
    return fx1 >= minX && fx0 <= maxX && fy1 >= minY && fy0 <= maxY;
  };
  const byLayer = new Map<string, NearbyLayer>();
  for (const f of features) {
    if (f.kind === 'text' || ignoreLayers.has(f.layer)) continue;
    const pts = f.kind === 'line' ? f.coords : f.kind === 'polygon' ? f.rings.flat() : [f.coord];
    if (!bboxHit(pts)) continue;
    const d = featureDistance(ring, f);
    if (d > radius) continue;
    const cur = byLayer.get(f.layer);
    if (cur) {
      cur.minDistance = Math.min(cur.minDistance, d);
      cur.featureCount++;
    } else byLayer.set(f.layer, { layer: f.layer, color: f.color, minDistance: d, featureCount: 1 });
  }
  return [...byLayer.values()].sort((a, b) => a.minDistance - b.minDistance || a.layer.localeCompare(b.layer));
}
