/**
 * Box schedule: every service within a radius of a work area, where it crosses the area
 * (or its closest point if it doesn't), and the RL there.
 *
 * A "run" is one CAD object (a polyline, line, arc...) or one block symbol (a pit, a pole),
 * whose separate pieces are treated as a single item.
 *
 * RLs, best source first:
 *   1. the line's own 3D levels, interpolated at the exact crossing / closest point
 *   2. the object's elevation (flat polyline elevation, block insertion level)
 *   3. an RL attribute / data field (RL, RL_LID, LEVEL, INVERT...)
 *   4. a nearby text label such as "RL 45.32" (within LABEL_SEARCH_RADIUS)
 * A level of exactly 0.000 is treated as "not set" (2D CAD objects sit at zero).
 */
import type { CadDrawing, CadFeature, CadText, XY } from '../cad/types';
import { RL_FIELDS } from '../services/dictionary';
import { dataValue } from '../services/register';
import {
  boxDimensions,
  closestBetweenSegments,
  closestOnSegment,
  featureBBox,
  pointInPolygon,
  segmentIntersection,
} from './geometry';
import { type BBox, SpatialGrid } from './spatialIndex';

export const SCHEDULE_RADIUS = 10;
/** How far from a point to look for an "RL 12.345" text label, m. */
export const LABEL_SEARCH_RADIUS = 2.5;
/** Crossing points closer than this along the box edge are treated as one, m. */
const SAME_POINT = 0.005;

export type RlSource = '3D line' | 'elevation' | 'attribute' | 'label';

export interface RlValue {
  value: number;
  source: RlSource;
}

export interface Run {
  key: string;
  layer: string;
  features: CadFeature[];
  /** Block name for symbols (pits, poles...). */
  block?: string;
  /** Representative feature (carries the data/meta for the run). */
  primary: CadFeature;
  bbox: BBox;
}

export type Relation = 'crosses' | 'inside' | 'near';

export interface SchedulePoint {
  /** Where on the service the RL applies (crossing point, or closest point to the box). */
  at: XY;
  /** Matching point on the box outline (same as `at` for crossings). */
  onBox: XY;
  rl: RlValue | null;
}

export interface ScheduleEntry {
  run: Run;
  relation: Relation;
  /** Horizontal distance from the box outline, m (0 if crossing or inside). */
  distance: number;
  points: SchedulePoint[];
}

const RL_LABEL = /\bRL\s*[:=]?\s*~?\s*(-?\d{1,4}(?:\.\d+)?)/i;
const isSet = (z: number | undefined | null): z is number => typeof z === 'number' && Number.isFinite(z) && z !== 0;

/** Group a drawing's features into runs (block symbols become one run). Text is not a service. */
export function buildRuns(drawing: CadDrawing): Run[] {
  const runs = new Map<string, Run>();
  for (const f of drawing.features) {
    if (f.kind === 'text') continue;
    if (f.kind === 'line' && f.coords.length < 2) continue;
    const key = f.meta?.insertHandle && f.block ? `B:${f.meta.insertHandle}` : `F:${f.handle}:${f.entityType}`;
    let run = runs.get(key);
    const bbox = featureBBox(f);
    if (!Number.isFinite(bbox[0])) continue;
    if (!run) {
      run = { key, layer: f.layer, features: [], primary: f, bbox, ...(key.startsWith('B:') ? { block: f.block } : {}) };
      runs.set(key, run);
    } else {
      run.bbox = [Math.min(run.bbox[0], bbox[0]), Math.min(run.bbox[1], bbox[1]), Math.max(run.bbox[2], bbox[2]), Math.max(run.bbox[3], bbox[3])];
    }
    run.features.push(f);
  }
  // Distinct objects can share a handle in odd files: keep keys unique.
  return [...runs.values()];
}

/** Line pieces of a feature with per-vertex levels where known. */
function pieces(f: CadFeature): { coords: XY[]; z?: number[] }[] {
  if (f.kind === 'line') return [{ coords: f.coords, z: f.z }];
  if (f.kind === 'polygon') return f.rings.map((r) => ({ coords: r }));
  if (f.kind === 'point') return [{ coords: [f.coord, f.coord] }];
  return [];
}

export class ScheduleEngine {
  readonly runs: Run[];
  private index: SpatialGrid<Run>;
  private labels: SpatialGrid<{ text: CadText; value: number }>;

  constructor(drawing: CadDrawing) {
    this.runs = buildRuns(drawing);
    const ext = drawing.focusExtent ?? drawing.extent ?? [0, 0, 1, 1];
    this.index = new SpatialGrid<Run>(ext, 20);
    for (const r of this.runs) this.index.insert(r.bbox, r);
    this.labels = new SpatialGrid(ext, 10);
    for (const f of drawing.features) {
      if (f.kind !== 'text') continue;
      const m = RL_LABEL.exec(f.text.replace(/\n/g, ' '));
      if (m) this.labels.insert([f.coord[0], f.coord[1], f.coord[0], f.coord[1]], { text: f, value: parseFloat(m[1]) });
    }
  }

  /** Services within `radius` m of the closed ring, nearest first. `include` filters runs (e.g. ignored layers). */
  compute(ring: XY[], radius = SCHEDULE_RADIUS, include: (run: Run) => boolean = () => true): ScheduleEntry[] {
    const xs = ring.map((p) => p[0]);
    const ys = ring.map((p) => p[1]);
    const query: BBox = [Math.min(...xs) - radius, Math.min(...ys) - radius, Math.max(...xs) + radius, Math.max(...ys) + radius];
    const centre = boxDimensions(ring).centre;
    const out: ScheduleEntry[] = [];
    for (const run of this.index.query(query)) {
      if (!include(run)) continue;
      const entry = run.block ? this.symbolEntry(run, ring) : this.lineEntry(run, ring, centre);
      if (entry && entry.distance <= radius + 1e-9) out.push(entry);
    }
    return out.sort((a, b) => a.distance - b.distance || a.run.layer.localeCompare(b.run.layer) || a.run.key.localeCompare(b.run.key));
  }

  private lineEntry(run: Run, ring: XY[], centre: XY): ScheduleEntry | null {
    // 1. Crossings with the box outline
    const crossings: { at: XY; rl: RlValue | null; order: number }[] = [];
    let order = 0;
    let insideVertex = false;
    let best: { distance: number; at: XY; onBox: XY; f: CadFeature; seg: number; t: number; z?: number[] } | null = null;
    for (const f of run.features) {
      for (const piece of pieces(f)) {
        const c = piece.coords;
        for (let i = 0; i < c.length - 1; i++) {
          const a = c[i];
          const b = c[i + 1];
          if (!insideVertex && (pointInPolygon(a, ring) || pointInPolygon(b, ring))) insideVertex = true;
          for (let j = 0; j < ring.length - 1; j++) {
            const x = segmentIntersection(a, b, ring[j], ring[j + 1]);
            if (x && !crossings.some((k) => Math.hypot(k.at[0] - x.point[0], k.at[1] - x.point[1]) < SAME_POINT)) {
              crossings.push({ at: x.point, rl: this.rlOnLine(run, f, piece.z, i, x.t, x.point), order: order + i + x.t });
            }
            const cb = closestBetweenSegments(a, b, ring[j], ring[j + 1]);
            if (!best || cb.distance < best.distance) best = { distance: cb.distance, at: cb.onAB, onBox: cb.onCD, f, seg: i, t: cb.t, z: piece.z };
          }
        }
        order += c.length;
      }
    }
    if (crossings.length) {
      crossings.sort((p, q) => p.order - q.order);
      return { run, relation: 'crosses', distance: 0, points: crossings.map((k) => ({ at: k.at, onBox: k.at, rl: k.rl })) };
    }
    // An area (hatch) that surrounds the box counts as inside it.
    if (!insideVertex && run.features.some((f) => f.kind === 'polygon' && pointInPolygon(centre, f.rings[0]))) {
      return { run, relation: 'inside', distance: 0, points: [{ at: centre, onBox: centre, rl: this.rlFromObject(run) ?? this.rlFromLabel(centre, run.layer) }] };
    }
    if (insideVertex) {
      // Wholly inside the area: report the point of the run nearest the area's centre.
      let near: { at: XY; f: CadFeature; seg: number; t: number; z?: number[]; d: number } | null = null;
      for (const f of run.features) {
        for (const piece of pieces(f)) {
          for (let i = 0; i < piece.coords.length - 1; i++) {
            const q = closestOnSegment(centre, piece.coords[i], piece.coords[i + 1]);
            if (!near || q.distance < near.d) near = { at: q.point, f, seg: i, t: q.t, z: piece.z, d: q.distance };
          }
        }
      }
      if (!near) return null;
      return { run, relation: 'inside', distance: 0, points: [{ at: near.at, onBox: near.at, rl: this.rlOnLine(run, near.f, near.z, near.seg, near.t, near.at) }] };
    }
    if (!best) return null;
    return {
      run,
      relation: 'near',
      distance: best.distance,
      points: [{ at: best.at, onBox: best.onBox, rl: this.rlOnLine(run, best.f, best.z, best.seg, best.t, best.at) }],
    };
  }

  private symbolEntry(run: Run, ring: XY[]): ScheduleEntry | null {
    const centre: XY = [(run.bbox[0] + run.bbox[2]) / 2, (run.bbox[1] + run.bbox[3]) / 2];
    let distance = Infinity;
    let onBox: XY = centre;
    let inside = pointInPolygon(centre, ring);
    for (const f of run.features) {
      for (const piece of pieces(f)) {
        for (let i = 0; i < piece.coords.length - 1; i++) {
          if (pointInPolygon(piece.coords[i], ring)) inside = true;
          for (let j = 0; j < ring.length - 1; j++) {
            const cb = closestBetweenSegments(piece.coords[i], piece.coords[i + 1], ring[j], ring[j + 1]);
            if (cb.distance < distance) [distance, onBox] = [cb.distance, cb.onCD];
          }
        }
      }
    }
    if (inside) distance = 0;
    const rl = this.rlFromObject(run) ?? this.rlFromLabel(centre, run.layer);
    return { run, relation: inside ? 'inside' : distance === 0 ? 'crosses' : 'near', distance, points: [{ at: centre, onBox: inside ? centre : onBox, rl }] };
  }

  private rlOnLine(run: Run, f: CadFeature, z: number[] | undefined, seg: number, t: number, at: XY): RlValue | null {
    if (z && isSet(z[seg]) && isSet(z[seg + 1])) return { value: z[seg] + t * (z[seg + 1] - z[seg]), source: '3D line' };
    // Only one end levelled: use it when the point is at that end.
    if (z && t < 1e-6 && isSet(z[seg])) return { value: z[seg], source: '3D line' };
    if (z && t > 1 - 1e-6 && isSet(z[seg + 1])) return { value: z[seg + 1], source: '3D line' };
    return this.rlFromObject(run, f) ?? this.rlFromLabel(at, run.layer);
  }

  private rlFromObject(run: Run, f: CadFeature = run.primary): RlValue | null {
    const meta = f.meta ?? run.primary.meta;
    if (isSet(meta?.elevation)) return { value: meta!.elevation!, source: 'elevation' };
    const raw = dataValue(meta, RL_FIELDS);
    const v = raw !== null ? parseFloat(raw.replace(/[^0-9.\-]/g, '')) : NaN;
    if (isSet(v)) return { value: v, source: 'attribute' };
    return null;
  }

  private rlFromLabel(at: XY, layer: string): RlValue | null {
    const r = LABEL_SEARCH_RADIUS;
    let best: { value: number; score: number } | null = null;
    for (const { text, value } of this.labels.query([at[0] - r, at[1] - r, at[0] + r, at[1] + r])) {
      const d = Math.hypot(text.coord[0] - at[0], text.coord[1] - at[1]);
      if (d > r) continue;
      const score = d + (text.layer === layer ? 0 : r); // prefer labels on the same layer
      if (!best || score < best.score) best = { value, score };
    }
    return best ? { value: best.value, source: 'label' } : null;
  }
}

/** "~" marks an approximate level: anything not surveyed to quality level A (as on existing markups). */
export function formatRl(v: number, ql: string | null): string {
  return `${ql === 'A' ? '' : '~'}${v.toFixed(3)}`;
}
