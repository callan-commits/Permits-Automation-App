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
  /** Length of the smallest rectangle enclosing the shape (longer side), m */
  length: number;
  /** Width of that rectangle (shorter side), m */
  width: number;
  /** True area of the shape, m² */
  area: number;
  /** Perimeter of the shape, m */
  perimeter: number;
  /** Grid bearing of the enclosing rectangle's long side, degrees 0-180 clockwise from grid north. */
  bearing: number;
  /** Area centroid. */
  centre: XY;
  vertexCount: number;
}

/** Open ring (closing point removed). */
const openRing = (ring: XY[]): XY[] => {
  const n = ring.length;
  return n > 1 && ring[0][0] === ring[n - 1][0] && ring[0][1] === ring[n - 1][1] ? ring.slice(0, -1) : ring.slice();
};

/** Signed area (+ve counter-clockwise). */
export function signedArea(ring: XY[]): number {
  const pts = openRing(ring);
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

function convexHull(points: XY[]): XY[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: XY, a: XY, b: XY) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: XY[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: XY[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** Dimensions of any closed shape (rectangles give their exact side lengths). */
export function boxDimensions(ring: XY[]): BoxDimensions {
  const pts = openRing(ring);
  const area2 = signedArea(pts) * 2;
  let cx = 0;
  let cy = 0;
  let perimeter = 0;
  // Centroid relative to the first vertex, to keep precision with large MGA coordinates.
  const [ox, oy] = pts[0];
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = [pts[i][0] - ox, pts[i][1] - oy];
    const [x1, y1] = [pts[(i + 1) % pts.length][0] - ox, pts[(i + 1) % pts.length][1] - oy];
    const f = x0 * y1 - x1 * y0;
    cx += (x0 + x1) * f;
    cy += (y0 + y1) * f;
    perimeter += Math.hypot(x1 - x0, y1 - y0);
  }
  const centre: XY = area2 ? [ox + cx / (3 * area2), oy + cy / (3 * area2)] : [ox, oy];
  // Minimum-area enclosing rectangle: one of its sides lies along a convex hull edge.
  const hull = convexHull(pts);
  let best = { area: Infinity, length: 0, width: 0, bearing: 0 };
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len === 0) continue;
    const ux = (b[0] - a[0]) / len;
    const uy = (b[1] - a[1]) / len;
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const p of hull) {
      const u = (p[0] - a[0]) * ux + (p[1] - a[1]) * uy;
      const v = -(p[0] - a[0]) * uy + (p[1] - a[1]) * ux;
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
    const du = maxU - minU;
    const dv = maxV - minV;
    if (du * dv < best.area - 1e-9) {
      // Bearing of the longer side.
      const [bx, by] = du >= dv ? [ux, uy] : [-uy, ux];
      let bearing = (Math.atan2(bx, by) * 180) / Math.PI;
      bearing = ((bearing % 180) + 180) % 180;
      best = { area: du * dv, length: Math.max(du, dv), width: Math.min(du, dv), bearing };
    }
  }
  return { length: best.length, width: best.width, area: Math.abs(area2) / 2, perimeter, bearing: best.bearing, centre, vertexCount: pts.length };
}

/** True if any two non-adjacent edges of the ring cross or touch. */
export function selfIntersects(ring: XY[]): boolean {
  const pts = openRing(ring);
  const n = pts.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // adjacent through the closing edge
      const c = pts[j];
      const d = pts[(j + 1) % n];
      if (segmentsIntersect(a, b, c, d) || pointSegmentDistance(c, a, b) < 1e-9 || pointSegmentDistance(a, c, d) < 1e-9) return true;
    }
  }
  return false;
}

/**
 * Clean up a drawn ring: drop repeated points, make it counter-clockwise,
 * start at the south-west-most vertex and close it.
 */
export function normaliseRing(ring: XY[]): XY[] {
  let pts: XY[] = [];
  for (const p of openRing(ring)) {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-6) pts.push([p[0], p[1]]);
  }
  while (pts.length > 1 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) <= 1e-6) pts.pop();
  if (signedArea(pts) < 0) pts = pts.reverse();
  let start = 0;
  pts.forEach((p, i) => {
    if (p[0] + p[1] < pts[start][0] + pts[start][1]) start = i;
  });
  pts = [...pts.slice(start), ...pts.slice(0, start)];
  return pts.length ? [...pts, pts[0]] : pts;
}

/** Reason a drawn shape can't be used as a work area, or null if it's fine. */
export function invalidShapeReason(ring: XY[]): string | null {
  const pts = openRing(ring);
  if (pts.length < 3) return 'it needs at least 3 corners';
  // Check crossings first: a bow-tie's signed area cancels out and would look "flat".
  if (selfIntersects(ring)) return 'its edges cross each other';
  const d = boxDimensions(ring);
  if (d.width < 0.05 || d.area < 0.01) return 'it has no width';
  return null;
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

export function pointSegmentDistance(p: XY, a: XY, b: XY): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

export function segmentsIntersect(a: XY, b: XY, c: XY, d: XY): boolean {
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

/** Shortest distance (m) from a point to a feature's geometry (0 inside a polygon). */
export function pointToFeatureDistance(p: XY, f: CadFeature): number {
  const lineDist = (pts: XY[]) => {
    let best = Infinity;
    if (pts.length === 1) return Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]);
    for (let i = 0; i < pts.length - 1; i++) best = Math.min(best, pointSegmentDistance(p, pts[i], pts[i + 1]));
    return best;
  };
  switch (f.kind) {
    case 'line':
      return lineDist(f.coords);
    case 'polygon':
      return pointInPolygon(p, f.rings[0]) ? 0 : Math.min(...f.rings.map(lineDist));
    default:
      return Math.hypot(p[0] - f.coord[0], p[1] - f.coord[1]);
  }
}

/** Bounding box of a feature's geometry. */
export function featureBBox(f: CadFeature): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (pts: XY[]) => {
    for (const [x, y] of pts) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  };
  if (f.kind === 'line') add(f.coords);
  else if (f.kind === 'polygon') f.rings.forEach(add);
  else add([f.coord]);
  return [minX, minY, maxX, maxY];
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

/** Intersection of segments a-b and c-d (including touching ends): parameter t along a-b and the point. */
export function segmentIntersection(a: XY, b: XY, c: XY, d: XY): { t: number; u: number; point: XY } | null {
  const r: XY = [b[0] - a[0], b[1] - a[1]];
  const s: XY = [d[0] - c[0], d[1] - c[1]];
  const denom = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(denom) < 1e-12) return null; // parallel or collinear: no single crossing point
  const qp: XY = [c[0] - a[0], c[1] - a[1]];
  const t = (qp[0] * s[1] - qp[1] * s[0]) / denom;
  const u = (qp[0] * r[1] - qp[1] * r[0]) / denom;
  const eps = 1e-9;
  if (t < -eps || t > 1 + eps || u < -eps || u > 1 + eps) return null;
  const tc = Math.min(1, Math.max(0, t));
  return { t: tc, u: Math.min(1, Math.max(0, u)), point: [a[0] + tc * r[0], a[1] + tc * r[1]] };
}

/** Closest point on segment a-b to p, with its parameter t. */
export function closestOnSegment(p: XY, a: XY, b: XY): { t: number; point: XY; distance: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const point: XY = [a[0] + t * dx, a[1] + t * dy];
  return { t, point, distance: Math.hypot(p[0] - point[0], p[1] - point[1]) };
}

/**
 * Closest points between segment a-b and segment c-d (which don't cross):
 * the point on a-b (with parameter t), the point on c-d, and the distance.
 */
export function closestBetweenSegments(a: XY, b: XY, c: XY, d: XY): { t: number; onAB: XY; onCD: XY; distance: number } {
  const x = segmentIntersection(a, b, c, d);
  if (x) return { t: x.t, onAB: x.point, onCD: x.point, distance: 0 };
  const candidates = [
    (() => { const q = closestOnSegment(a, c, d); return { t: 0, onAB: a, onCD: q.point, distance: q.distance }; })(),
    (() => { const q = closestOnSegment(b, c, d); return { t: 1, onAB: b, onCD: q.point, distance: q.distance }; })(),
    (() => { const q = closestOnSegment(c, a, b); return { t: q.t, onAB: q.point, onCD: c, distance: q.distance }; })(),
    (() => { const q = closestOnSegment(d, a, b); return { t: q.t, onAB: q.point, onCD: d, distance: q.distance }; })(),
  ];
  return candidates.reduce((best, cnd) => (cnd.distance < best.distance ? cnd : best));
}

/** A line (4+ points) whose last point is its first: a closed outline. */
export function isClosedRing(c: XY[]): boolean {
  if (c.length < 4) return false;
  const [a, b] = [c[0], c[c.length - 1]];
  return Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
}
