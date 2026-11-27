/**
 * Ground surface from a feature survey, for service depths.
 *
 * Levels are collected from the feature survey (see `extractLevels`), then the surface level at a point is:
 *  1. "point": the level of a surveyed point within DIRECT_RADIUS (0.30 m), used as is (the nearest);
 *  2. "tin": otherwise, linear interpolation on the survey's triangulated surface (TIN, as 12d / Civil 3D
 *     build), using the triangle the point falls in, provided all three of its surveyed points are within
 *     AREA_RADIUS (5 m): the surface is only trusted between nearby surveyed points;
 *  3. "average": otherwise (e.g. at the edge of the survey), an inverse-distance-weighted average of the
 *     nearest MAX_AVERAGE (6) levels within AREA_RADIUS, if there are at least MIN_AVERAGE (3);
 *  4. "none": not enough survey nearby; the surface has to be found manually.
 */
import Delaunator from 'delaunator';
import type { CadDrawing, CadFeature, XY } from '../cad/types';
import { type BBox, SpatialGrid } from './spatialIndex';

export const DIRECT_RADIUS = 0.3;
export const AREA_RADIUS = 5;
export const MIN_AVERAGE = 3;
export const MAX_AVERAGE = 6;

export type LevelSource = 'point' | 'block' | 'line' | 'text';

export interface SurfaceLevel {
  x: number;
  y: number;
  z: number;
  layer: string;
  source: LevelSource;
}

export interface SurfaceResult {
  value: number | null;
  method: 'point' | 'tin' | 'average' | 'none';
  /** Plain-English account, for the schedule. */
  detail: string;
}

export interface LevelLayer {
  layer: string;
  count: number;
  /** Excluded unless the user includes it: the name says it isn't ground (inverts, wires, roofs…). */
  notGround: boolean;
}

/** Layers whose levels aren't the ground: underground services, overhead wires, roofs and the like. */
const NOT_GROUND =
  /(^|[^A-Z])(INV|INVERT|OBV|OBVERT|PIPE|CONDUIT|CABLE|UG|UNDERGROUND|DUCT|OVERHEAD|O\/H|OHW|OHLE|AERIAL|WIRE|CATENARY|ROOF|EAVE|CANOPY|RIDGE|GUTTER)([^A-Z]|$)/i;
/** Text that is a level: "RL 35.566", or a plain 35.566 on a level/spot-height layer. */
const RL_TEXT = /^\s*(?:RL|R\.L\.|LEVEL|LVL)\s*[:=]?\s*(-?\d{1,4}\.\d{1,3})\s*$/i;
const PLAIN_LEVEL = /^\s*(-?\d{1,4}\.\d{2,3})\s*$/;
const LEVEL_LAYER = /(^|[^A-Z])(SPOT|LEVEL|LEVELS|RL|HEIGHT|HT|ELEV|ELEVATION|SPOTHEIGHT|SH)([^A-Z]|$)/i;
/** Fields on a spot-height block that hold its level. */
const LEVEL_FIELDS = new Set(['RL', 'LEVEL', 'ELEV', 'ELEVATION', 'HEIGHT', 'HT', 'Z', 'SPOTLEVEL', 'SPOTHEIGHT']);
/** Text levels are only used when the survey has fewer z-coordinate levels than this. */
const FEW_LEVELS = 50;

const valid = (z: number | undefined): z is number => typeof z === 'number' && Number.isFinite(z) && z !== 0 && z > -500 && z < 5000;

/** Every level in a feature survey, with the layer it came from. */
export function extractLevels(drawing: CadDrawing): { levels: SurfaceLevel[]; layers: LevelLayer[] } {
  const levels: SurfaceLevel[] = [];
  const seenInserts = new Set<string>();
  const texts: SurfaceLevel[] = [];
  for (const f of drawing.features) {
    const m = f.meta;
    // Block inserts (spot-height symbols etc.): once per insert, at the insertion point.
    if (m?.insertHandle && m.insertAt) {
      if (seenInserts.has(m.insertHandle)) continue;
      seenInserts.add(m.insertHandle);
      const z = blockLevel(f) ?? m.elevation;
      if (valid(z)) levels.push({ x: m.insertAt[0], y: m.insertAt[1], z, layer: f.layer, source: 'block' });
      continue;
    }
    if (f.kind === 'point') {
      if (valid(m?.elevation)) levels.push({ x: f.coord[0], y: f.coord[1], z: m!.elevation!, layer: f.layer, source: 'point' });
    } else if (f.kind === 'line') {
      // 3D strings (kerbs, edges, contours): every vertex with a level.
      const z = f.z;
      f.coords.forEach((c, i) => {
        const v = z ? z[i] : m?.elevation;
        if (valid(v)) levels.push({ x: c[0], y: c[1], z: v, layer: f.layer, source: 'line' });
      });
    } else if (f.kind === 'text') {
      const r = RL_TEXT.exec(f.text) ?? (LEVEL_LAYER.test(f.layer) ? PLAIN_LEVEL.exec(f.text) : null);
      if (r && valid(Number(r[1]))) texts.push({ x: f.coord[0], y: f.coord[1], z: Number(r[1]), layer: f.layer, source: 'text' });
    }
  }
  // Surveys normally carry their levels as 3D coordinates and repeat them as labels next to the point;
  // labels are only used when there are hardly any 3D levels (a flat drawing with written levels).
  if (levels.length < FEW_LEVELS) levels.push(...texts);
  const counts = new Map<string, number>();
  for (const l of levels) counts.set(l.layer, (counts.get(l.layer) ?? 0) + 1);
  const layers = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([layer, count]) => ({ layer, count, notGround: NOT_GROUND.test(layer) }));
  return { levels, layers };
}

function blockLevel(f: CadFeature): number | undefined {
  for (const source of [f.meta?.attributes, f.meta?.fields]) {
    for (const [k, v] of Object.entries(source ?? {})) {
      if (!LEVEL_FIELDS.has(k.toUpperCase().replace(/[^A-Z]/g, ''))) continue;
      const n = Number(String(v).replace(/^\s*RL\s*/i, ''));
      if (Number.isFinite(n) && n !== 0) return n;
    }
  }
  return undefined;
}

export class SurfaceModel {
  readonly levels: SurfaceLevel[];
  private points: SpatialGrid<number>;
  private triangles: SpatialGrid<number>;
  private tri: Uint32Array;

  /** @param levels the levels to build the surface from (already filtered by layer). */
  constructor(levels: SurfaceLevel[]) {
    // One level per position (within 1 mm): the first one.
    const seen = new Set<string>();
    this.levels = levels.filter((l) => {
      const k = `${Math.round(l.x * 1000)},${Math.round(l.y * 1000)}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const ext = this.extent();
    this.points = new SpatialGrid<number>(ext, 2);
    this.levels.forEach((l, i) => this.points.insert([l.x, l.y, l.x, l.y], i));
    this.triangles = new SpatialGrid<number>(ext, 5);
    if (this.levels.length >= 3) {
      const coords = new Float64Array(this.levels.length * 2);
      this.levels.forEach((l, i) => {
        coords[2 * i] = l.x;
        coords[2 * i + 1] = l.y;
      });
      this.tri = new Delaunator(coords).triangles;
      for (let t = 0; t < this.tri.length; t += 3) {
        const [a, b, c] = [this.levels[this.tri[t]], this.levels[this.tri[t + 1]], this.levels[this.tri[t + 2]]];
        // A point can only use a triangle whose corners are all within AREA_RADIUS, so no side is longer than 2×.
        const longest = Math.max(Math.hypot(a.x - b.x, a.y - b.y), Math.hypot(b.x - c.x, b.y - c.y), Math.hypot(c.x - a.x, c.y - a.y));
        if (longest > 2 * AREA_RADIUS) continue;
        this.triangles.insert([Math.min(a.x, b.x, c.x), Math.min(a.y, b.y, c.y), Math.max(a.x, b.x, c.x), Math.max(a.y, b.y, c.y)], t);
      }
    } else this.tri = new Uint32Array(0);
  }

  get size(): number {
    return this.levels.length;
  }

  private extent(): BBox {
    if (!this.levels.length) return [0, 0, 1, 1];
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const l of this.levels) [x0, y0, x1, y1] = [Math.min(x0, l.x), Math.min(y0, l.y), Math.max(x1, l.x), Math.max(y1, l.y)];
    return [x0, y0, x1 + 1, y1 + 1];
  }

  /** Levels within `r` m of p, nearest first, with their distances. */
  near(p: XY, r: number): { level: SurfaceLevel; distance: number }[] {
    return this.points
      .query([p[0] - r, p[1] - r, p[0] + r, p[1] + r])
      .map((i) => ({ level: this.levels[i], distance: Math.hypot(this.levels[i].x - p[0], this.levels[i].y - p[1]) }))
      .filter((n) => n.distance <= r)
      .sort((a, b) => a.distance - b.distance);
  }

  /** Surface level at p (see the file header for the method). */
  at(p: XY): SurfaceResult {
    const nearby = this.near(p, AREA_RADIUS);
    const closest = nearby[0];
    if (closest && closest.distance <= DIRECT_RADIUS) {
      return { value: closest.level.z, method: 'point', detail: `Surveyed point ${fmtDistance(closest.distance)} away (${closest.level.layer})` };
    }
    for (const t of this.triangles.query([p[0], p[1], p[0], p[1]])) {
      const [a, b, c] = [this.levels[this.tri[t]], this.levels[this.tri[t + 1]], this.levels[this.tri[t + 2]]];
      const w = barycentric(p, a, b, c);
      if (!w) continue;
      const far = Math.max(...[a, b, c].map((v) => Math.hypot(v.x - p[0], v.y - p[1])));
      if (far > AREA_RADIUS) break; // the triangle it falls in is too big to trust
      return {
        value: w[0] * a.z + w[1] * b.z + w[2] * c.z,
        method: 'tin',
        detail: `Interpolated between 3 surveyed points, furthest ${fmtDistance(far)} away`,
      };
    }
    if (nearby.length >= MIN_AVERAGE) {
      const used = nearby.slice(0, MAX_AVERAGE);
      let sw = 0;
      let sz = 0;
      for (const n of used) {
        const w = 1 / (n.distance * n.distance);
        sw += w;
        sz += w * n.level.z;
      }
      return {
        value: sz / sw,
        method: 'average',
        detail: `Weighted average of ${used.length} surveyed points within ${fmtDistance(used[used.length - 1].distance)}`,
      };
    }
    return {
      value: null,
      method: 'none',
      detail: nearby.length
        ? `Only ${nearby.length} surveyed point${nearby.length === 1 ? '' : 's'} within ${AREA_RADIUS} m: find the surface manually`
        : `No surveyed points within ${AREA_RADIUS} m: find the surface manually`,
    };
  }
}

/** Barycentric weights of p in triangle abc, or null if outside (with a hair of tolerance on the edges). */
function barycentric(p: XY, a: SurfaceLevel, b: SurfaceLevel, c: SurfaceLevel): [number, number, number] | null {
  const det = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
  if (Math.abs(det) < 1e-12) return null;
  const wa = ((b.y - c.y) * (p[0] - c.x) + (c.x - b.x) * (p[1] - c.y)) / det;
  const wb = ((c.y - a.y) * (p[0] - c.x) + (a.x - c.x) * (p[1] - c.y)) / det;
  const wc = 1 - wa - wb;
  const eps = -1e-9;
  return wa >= eps && wb >= eps && wc >= eps ? [wa, wb, wc] : null;
}

function fmtDistance(m: number): string {
  return m < 1 ? `${Math.round(m * 100)} cm` : `${m.toFixed(1)} m`;
}
