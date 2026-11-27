/**
 * Box schedule: every service within a radius of a work area, where it crosses the area
 * (or its closest point if it doesn't), and the RL there.
 *
 * A "run" is one service as the schedule sees it: a CAD object (a polyline, line, arc...), a block
 * symbol (a pit, a pole), or a chain of line pieces that are really one service.
 *
 * Joining (done once when a drawing loads): surveys often break one cable or pipe into pieces that
 * meet end to end. Pieces are joined into one run where their ends meet (within JOINT_TOLERANCE) and
 * they are the same service: same layer, owner, type and quality level. A change of QL keeps them
 * apart. Corners are fine. Where three or more pieces of the same service meet (a branch), only
 * pairs that carry straight on (turn under BRANCH_MAX_TURN) are joined. Closed outlines (pits) and
 * symbols are never joined. Nothing is moved: crossing points and RLs are still worked out on
 * each piece with its own levels.
 *
 * Drain obverts: where an obvert line runs along an invert line (COLLOCATED_SHARE of its length
 * within COLLOCATED_TOLERANCE), only the invert is scheduled; obvert-only drains are kept.
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
import { dataValue, infoFromData } from '../services/register';
import {
  boxDimensions,
  closestBetweenSegments,
  closestOnSegment,
  featureBBox,
  isClosedRing,
  pointInPolygon,
  segmentIntersection,
} from './geometry';
import { type BBox, SpatialGrid } from './spatialIndex';

export const SCHEDULE_RADIUS = 10;
/** How far from a point to look for an "RL 12.345" text label, m. */
export const LABEL_SEARCH_RADIUS = 2.5;
/** Crossing points closer than this along the box edge are treated as one, m. */
const SAME_POINT = 0.005;
/** Line ends closer than this are one joint, m. Kept tight: at 5 cm, separate parallel cables start to match. */
export const JOINT_TOLERANCE = 0.01;
/** Where 3+ pieces of one service meet, only pairs turning less than this are joined, degrees. */
export const BRANCH_MAX_TURN = 45;
/** An obvert within this distance of an invert line is on the same pipe, m. */
export const COLLOCATED_TOLERANCE = 0.3;
/** Share of an obvert's length that must be within COLLOCATED_TOLERANCE of inverts. */
export const COLLOCATED_SHARE = 0.8;

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
  /** For a joined service: the pieces it was joined from (in order along it), so it can be split again. */
  pieces?: Run[];
  /** Per feature, true where the piece is drawn against the direction of the joined service. */
  reversed?: boolean[];
  /** For a piece of a joined service: the joined run's key. */
  parentKey?: string;
  /** An obvert line lying on an invert line: left out of the schedule (the invert is used). */
  coveredByInvert?: boolean;
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

/** Joining signature: pieces join only if this matches (null = never joined). */
export function serviceSignature(run: Run): string | null {
  const f = run.primary;
  if (run.block || run.features.length !== 1 || f.kind !== 'line' || f.coords.length < 2 || isClosedRing(f.coords)) return null;
  const i = infoFromData(f.meta);
  return [run.layer, i.owner ?? '', i.type ?? '', i.ql ?? ''].join('\u0001');
}

/**
 * Join line runs that meet end to end and are the same service (see the file header). Returns the
 * runs with each chain replaced by one joined run; the original pieces are kept on it.
 */
export function joinRuns(runs: Run[], signature: (run: Run) => string | null = serviceSignature): Run[] {
  const sig = runs.map(signature);
  const tol = JOINT_TOLERANCE;
  // Ends, bucketed on a grid of the tolerance, then grouped into joints.
  type End = { run: number; end: 0 | 1; at: XY };
  const ends: End[] = [];
  const endIndex = new Map<number, number>(); // run * 2 + end -> index into ends
  runs.forEach((r, i) => {
    if (sig[i] === null) return;
    const c = (r.primary as { coords: XY[] }).coords;
    for (const end of [0, 1] as const) endIndex.set(i * 2 + end, ends.push({ run: i, end, at: end === 0 ? c[0] : c[c.length - 1] }) - 1);
  });
  // Grid buckets with numeric keys (cell column * rows + cell row), relative to the lowest end.
  let gx0 = Infinity;
  let gy0 = Infinity;
  let gy1 = -Infinity;
  for (const e of ends) {
    gx0 = Math.min(gx0, Math.round(e.at[0] / tol));
    gy0 = Math.min(gy0, Math.round(e.at[1] / tol));
    gy1 = Math.max(gy1, Math.round(e.at[1] / tol));
  }
  const span = gy1 - gy0 + 3;
  const cell = (gx: number, gy: number) => (gx - gx0 + 1) * span + (gy - gy0 + 1);
  const buckets = new Map<number, number[]>();
  ends.forEach((e, k) => {
    const b = cell(Math.round(e.at[0] / tol), Math.round(e.at[1] / tol));
    (buckets.get(b) ?? buckets.set(b, []).get(b)!).push(k);
  });
  const parent = ends.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  ends.forEach((e, i) => {
    const gx = Math.round(e.at[0] / tol);
    const gy = Math.round(e.at[1] / tol);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const j of buckets.get(cell(gx + dx, gy + dy)) ?? []) {
          if (j <= i) continue;
          const o = ends[j];
          if (Math.hypot(o.at[0] - e.at[0], o.at[1] - e.at[1]) <= tol) parent[find(j)] = find(i);
        }
  });
  const joints = new Map<number, number[]>();
  ends.forEach((_, i) => (joints.get(find(i)) ?? joints.set(find(i), []).get(find(i))!).push(i));

  // Direction of a piece leaving a joint (from its end, into the piece).
  const outward = (e: End): XY => {
    const c = (runs[e.run].primary as { coords: XY[] }).coords;
    const from = e.end === 0 ? c[0] : c[c.length - 1];
    for (let k = 1; k < c.length; k++) {
      const p = e.end === 0 ? c[k] : c[c.length - 1 - k];
      const v: XY = [p[0] - from[0], p[1] - from[1]];
      const n = Math.hypot(v[0], v[1]);
      if (n > 1e-9) return [v[0] / n, v[1] / n];
    }
    return [0, 0];
  };
  // Turn when going in along one piece and out along the other: 0° = straight on.
  const turn = (a: End, b: End) => {
    const u = outward(a);
    const v = outward(b);
    return (Math.acos(Math.max(-1, Math.min(1, -(u[0] * v[0] + u[1] * v[1])))) * 180) / Math.PI;
  };

  const link: [number, number][] = []; // pairs of end indices joined
  for (const members of joints.values()) {
    const bySig = new Map<string, number[]>();
    for (const m of members) (bySig.get(sig[ends[m].run]!) ?? bySig.set(sig[ends[m].run]!, []).get(sig[ends[m].run]!)!).push(m);
    for (const group of bySig.values()) {
      if (group.length < 2) continue;
      if (group.length === 2) {
        if (ends[group[0]].run !== ends[group[1]].run) link.push([group[0], group[1]]);
        continue;
      }
      // A branch: join the straightest pairs only.
      const pairs: [number, number, number][] = [];
      for (let x = 0; x < group.length; x++)
        for (let y = x + 1; y < group.length; y++)
          if (ends[group[x]].run !== ends[group[y]].run) pairs.push([group[x], group[y], turn(ends[group[x]], ends[group[y]])]);
      pairs.sort((p, q) => p[2] - q[2]);
      const used = new Set<number>();
      for (const [a, b, ang] of pairs) {
        if (ang > BRANCH_MAX_TURN || used.has(a) || used.has(b)) continue;
        used.add(a);
        used.add(b);
        link.push([a, b]);
      }
    }
  }
  if (!link.length) return runs;

  // Walk each chain from a free end (or anywhere, for a loop).
  const next = new Map<number, number>(); // end index -> end index it is joined to
  for (const [a, b] of link) {
    next.set(a, b);
    next.set(b, a);
  }
  const inChain = new Set<number>();
  const out: Run[] = [];
  const chains: { run: number; reversed: boolean }[][] = [];
  const linked = new Set<number>(link.flatMap(([a, b]) => [ends[a].run, ends[b].run]));
  const starts = [...linked].sort((a, b) => {
    const free = (r: number) => (next.has(endIndex.get(r * 2)!) ? 0 : 1) + (next.has(endIndex.get(r * 2 + 1)!) ? 0 : 1);
    return free(b) - free(a) || a - b;
  });
  for (const start of starts) {
    if (inChain.has(start)) continue;
    // Enter the chain at a free end where there is one.
    const startReversed = !next.has(endIndex.get(start * 2 + 1)!) && next.has(endIndex.get(start * 2)!);
    const chain: { run: number; reversed: boolean }[] = [];
    let cur = start;
    let reversed = startReversed;
    while (!inChain.has(cur)) {
      inChain.add(cur);
      chain.push({ run: cur, reversed });
      const exit = endIndex.get(cur * 2 + (reversed ? 0 : 1))!;
      const to = next.get(exit);
      if (to === undefined) break;
      cur = ends[to].run;
      reversed = ends[to].end === 1;
    }
    chains.push(chain);
  }
  const joinedRuns = new Set<number>();
  for (const chain of chains) {
    if (chain.length < 2) continue;
    const pieces = chain.map((c) => runs[c.run]);
    const key = `J:${pieces.map((p) => p.key).sort()[0]}`;
    const longest = pieces.reduce((a, b) => (lineLength(b.primary) > lineLength(a.primary) ? b : a));
    const joined: Run = {
      key,
      layer: pieces[0].layer,
      features: pieces.map((p) => p.primary),
      primary: longest.primary,
      bbox: [Math.min(...pieces.map((p) => p.bbox[0])), Math.min(...pieces.map((p) => p.bbox[1])), Math.max(...pieces.map((p) => p.bbox[2])), Math.max(...pieces.map((p) => p.bbox[3]))],
      pieces: pieces.map((p) => ({ ...p, parentKey: key })),
      reversed: chain.map((c) => c.reversed),
    };
    out.push(joined);
    chain.forEach((c) => joinedRuns.add(c.run));
  }
  runs.forEach((r, i) => {
    if (!joinedRuns.has(i)) out.push(r);
  });
  return out;
}

function lineLength(f: CadFeature): number {
  if (f.kind !== 'line') return 0;
  let n = 0;
  for (let i = 1; i < f.coords.length; i++) n += Math.hypot(f.coords[i][0] - f.coords[i - 1][0], f.coords[i][1] - f.coords[i - 1][1]);
  return n;
}

const INVERT = /(^|[^a-z])(inv|invert)([^a-z]|$)/i;
const OBVERT = /(^|[^a-z])(obv|obvert)([^a-z]|$)/i;
const lastPart = (layer: string) => layer.split('/').pop() ?? layer;

/** Mark obvert runs that lie along invert lines (see the file header). Returns how many were marked. */
export function markCollocatedObverts(runs: Run[], ext: BBox): number {
  const inverts = runs.filter((r) => !r.block && INVERT.test(lastPart(r.layer)) && !OBVERT.test(lastPart(r.layer)));
  const obverts = runs.filter((r) => !r.block && OBVERT.test(lastPart(r.layer)));
  if (!inverts.length || !obverts.length) return 0;
  const segs = new SpatialGrid<[XY, XY]>(ext, 5);
  for (const r of inverts)
    for (const f of r.features)
      for (const p of pieces(f))
        for (let i = 0; i < p.coords.length - 1; i++) {
          const [a, b] = [p.coords[i], p.coords[i + 1]];
          segs.insert([Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])], [a, b]);
        }
  const tol = COLLOCATED_TOLERANCE;
  const near = (pt: XY) => {
    for (const [a, b] of segs.query([pt[0] - tol, pt[1] - tol, pt[0] + tol, pt[1] + tol])) if (closestOnSegment(pt, a, b).distance <= tol) return true;
    return false;
  };
  let marked = 0;
  for (const r of obverts) {
    let total = 0;
    let along = 0;
    for (const f of r.features)
      for (const p of pieces(f))
        for (let i = 0; i < p.coords.length - 1; i++) {
          const [a, b] = [p.coords[i], p.coords[i + 1]];
          const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
          const n = Math.max(1, Math.min(200, Math.ceil(len / 0.25)));
          for (let k = 0; k < n; k++) {
            const t = (k + 0.5) / n;
            total += len / n;
            if (near([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])])) along += len / n;
          }
        }
    if (total > 0 && along / total >= COLLOCATED_SHARE) {
      r.coveredByInvert = true;
      for (const p of r.pieces ?? []) p.coveredByInvert = true;
      marked++;
    }
  }
  return marked;
}

export class ScheduleEngine {
  readonly runs: Run[];
  /** Number of line pieces joined into longer services, and obverts left out for their inverts. */
  readonly stats: { joined: number; services: number; obvertsCovered: number };
  private index: SpatialGrid<Run>;
  private labels: SpatialGrid<{ text: CadText; value: number }>;

  constructor(drawing: CadDrawing) {
    const separate = buildRuns(drawing);
    this.runs = joinRuns(separate);
    const joined = this.runs.filter((r) => r.pieces);
    const ext = drawing.focusExtent ?? drawing.extent ?? [0, 0, 1, 1];
    const covered = markCollocatedObverts(this.runs, drawing.extent ?? ext);
    this.stats = { joined: joined.reduce((n, r) => n + r.pieces!.length, 0), services: joined.length, obvertsCovered: covered };
    this.index = new SpatialGrid<Run>(ext, 20);
    for (const r of this.runs) this.index.insert(r.bbox, r);
    this.labels = new SpatialGrid(ext, 10);
    for (const f of drawing.features) {
      if (f.kind !== 'text') continue;
      const m = RL_LABEL.exec(f.text.replace(/\n/g, ' '));
      if (m) this.labels.insert([f.coord[0], f.coord[1], f.coord[0], f.coord[1]], { text: f, value: parseFloat(m[1]) });
    }
  }

  /**
   * Services within `radius` m of the closed ring, nearest first. `include` filters runs (e.g. ignored
   * layers). A joined service whose key is in `split` is scheduled as its separate pieces instead.
   */
  compute(ring: XY[], radius = SCHEDULE_RADIUS, include: (run: Run) => boolean = () => true, split: (key: string) => boolean = () => false): ScheduleEntry[] {
    const xs = ring.map((p) => p[0]);
    const ys = ring.map((p) => p[1]);
    const query: BBox = [Math.min(...xs) - radius, Math.min(...ys) - radius, Math.max(...xs) + radius, Math.max(...ys) + radius];
    const centre = boxDimensions(ring).centre;
    const out: ScheduleEntry[] = [];
    for (const found of this.index.query(query)) {
      if (found.coveredByInvert || !include(found)) continue;
      for (const run of found.pieces && split(found.key) ? found.pieces : [found]) {
        const entry = run.block ? this.symbolEntry(run, ring) : this.lineEntry(run, ring, centre);
        if (entry && entry.distance <= radius + 1e-9) out.push(entry);
      }
    }
    return out.sort((a, b) => a.distance - b.distance || a.run.layer.localeCompare(b.run.layer) || a.run.key.localeCompare(b.run.key));
  }

  private lineEntry(run: Run, ring: XY[], centre: XY): ScheduleEntry | null {
    // 1. Crossings with the box outline
    const crossings: { at: XY; rl: RlValue | null; order: number }[] = [];
    let order = 0;
    let insideVertex = false;
    let best: { distance: number; at: XY; onBox: XY; f: CadFeature; seg: number; t: number; z?: number[] } | null = null;
    for (let fi = 0; fi < run.features.length; fi++) {
      const f = run.features[fi];
      const rev = run.reversed?.[fi] ?? false;
      for (const piece of pieces(f)) {
        const c = piece.coords;
        for (let i = 0; i < c.length - 1; i++) {
          const a = c[i];
          const b = c[i + 1];
          if (!insideVertex && (pointInPolygon(a, ring) || pointInPolygon(b, ring))) insideVertex = true;
          for (let j = 0; j < ring.length - 1; j++) {
            const x = segmentIntersection(a, b, ring[j], ring[j + 1]);
            if (x && !crossings.some((k) => Math.hypot(k.at[0] - x.point[0], k.at[1] - x.point[1]) < SAME_POINT)) {
              // Order along the service, so crossings list in the direction of travel.
              const along = rev ? c.length - 1 - (i + x.t) : i + x.t;
              crossings.push({ at: x.point, rl: this.rlOnLine(run, f, piece.z, i, x.t, x.point), order: order + along });
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
