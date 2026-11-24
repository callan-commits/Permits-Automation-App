/**
 * Callout content and placement for printouts (page coordinates, pt).
 *
 * Content:
 *   line 1: "[insert service]" - always left for the engineer to fill in, so every service is
 *           identified by a person (due diligence), even where the survey data names it
 *   line 2: "RL: ~32.088 QLB" ("~" = not QL-A; one callout per crossing / closest point),
 *           or "RL: [insert RL]" where the survey has no level
 * Every callout has a yellow fill: all of them need checking and completing.
 */
import type { XY } from '../cad/types';
import type { ScheduleRow } from '../services/scheduleModel';

export interface CalloutSpec {
  /** Schedule row key + point index, unique per callout. */
  key: string;
  lines: string[];
  /** Arrow tip on the page. */
  anchor: XY;
  /** Leader/border colour, 0-1 RGB. */
  color: [number, number, number];
  /** No RL was found for this point (the callout says "[insert RL]"). */
  missingRl: boolean;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlacedCallout extends CalloutSpec {
  box: Rect;
  /** Leader: anchor -> knee -> attach (attach is the middle of the box side facing the anchor). */
  knee: XY;
  attach: XY;
  /** True if no clear spot was found and the callout overlaps something. */
  crowded: boolean;
}

export const CALLOUT_FONT_SIZE = 10;
export const CALLOUT_LEADING = 12;
export const CALLOUT_PAD = 4;
/** Placeholder text the engineer replaces in their PDF editor. */
export const INSERT_SERVICE = '[insert service]';
export const INSERT_RL = '[insert RL]';
const KNEE = 12;

/** Callout text lines for one RL point of a schedule row. */
export function calloutLines(row: ScheduleRow, pointIndex: number): string[] {
  const ql = row.info.ql ? ` QL${row.info.ql}` : '';
  const rl = row.rls[pointIndex]?.text ?? null;
  return [INSERT_SERVICE, `RL: ${rl ?? INSERT_RL}${ql}`];
}

/** Callouts for the rows (one per RL point), anchors converted to page points. */
export function calloutSpecs(rows: ScheduleRow[], toPage: (ground: XY) => XY, colourOf: (row: ScheduleRow) => string): CalloutSpec[] {
  const out: CalloutSpec[] = [];
  for (const row of rows) {
    if (row.excluded) continue;
    const color = hexToRgb(colourOf(row));
    // An edited RL replaces the computed ones and is shown once.
    const points = row.rls.length ? row.rls : [];
    points.forEach((p, idx) => {
      const lines = calloutLines(row, idx);
      out.push({
        key: `${row.key}#${idx}`,
        lines,
        anchor: toPage(p.at),
        color,
        missingRl: p.text === null,
      });
    });
  }
  return out;
}

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', '').padEnd(6, '0').slice(0, 6), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const overlaps = (a: Rect, b: Rect, gap = 0) => a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;

function segIntersects(a: XY, b: XY, c: XY, d: XY): boolean {
  const o = (p: XY, q: XY, r: XY) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a);
  const d2 = o(c, d, b);
  const d3 = o(a, b, c);
  const d4 = o(a, b, d);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

function segmentHitsRect(a: XY, b: XY, r: Rect): boolean {
  const inside = (p: XY) => p[0] > r.x && p[0] < r.x + r.w && p[1] > r.y && p[1] < r.y + r.h;
  if (inside(a) || inside(b)) return true;
  const c: XY[] = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]];
  return [0, 1, 2, 3].some((i) => segIntersects(a, b, c[i], c[(i + 1) % 4]));
}

function pointInPoly(p: XY, poly: XY[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function rectHitsPolygon(r: Rect, poly: XY[]): boolean {
  const corners: XY[] = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]];
  if (corners.some((c) => pointInPoly(c, poly))) return true;
  if (poly.some((p) => p[0] > r.x && p[0] < r.x + r.w && p[1] > r.y && p[1] < r.y + r.h)) return true;
  for (let i = 0; i < poly.length - 1; i++) if (segmentHitsRect(poly[i], poly[i + 1], r)) return true;
  return false;
}

/**
 * Scan the whole frame for the nearest position where a box overlaps nothing (other callouts,
 * the work area, other arrow tips) and whose leader doesn't run through other callouts.
 */
function freeSpot(
  spec: CalloutSpec,
  w: number,
  h: number,
  frame: Rect,
  margin: number,
  placed: PlacedCallout[],
  workArea: XY[],
  clearLeaders: boolean,
): { score: number; box: Rect; knee: XY; attach: XY } | null {
  const tip = spec.anchor;
  let best: { score: number; box: Rect; knee: XY; attach: XY } | null = null;
  const step = 10;
  for (let x = frame.x + margin; x + w <= frame.x + frame.w - margin; x += step) {
    for (let y = frame.y + margin; y + h <= frame.y + frame.h - margin; y += step) {
      const box: Rect = { x, y, w, h };
      // Leader goes to the side of the box facing the anchor, with a short horizontal knee.
      const toRight = x >= tip[0];
      const attach: XY = toRight ? [x, y + h / 2] : [x + w, y + h / 2];
      const knee: XY = [attach[0] + (toRight ? -KNEE : KNEE), attach[1]];
      const dist = Math.hypot(knee[0] - tip[0], knee[1] - tip[1]);
      if (best && dist >= best.score) continue;
      if (!toRight && x + w > tip[0] - KNEE) continue; // box must sit clear of the anchor
      if (toRight && x < tip[0] + KNEE) continue;
      if (placed.some((p) => overlaps(p.box, box, 4))) continue;
      if (workArea.length > 2 && rectHitsPolygon(box, workArea)) continue;
      if (placed.some((p) => p.anchor[0] > x - 4 && p.anchor[0] < x + w + 4 && p.anchor[1] > y - 4 && p.anchor[1] < y + h + 4)) continue;
      if (clearLeaders && placed.some((p) => segmentHitsRect(tip, knee, p.box) || segmentHitsRect(p.anchor, p.knee, box))) continue;
      best = { score: dist, box, knee, attach };
    }
  }
  return best;
}

/** Number of leader pairs that cross (leaders are tip -> knee -> attach polylines). */
export function countCrossings(placed: Pick<PlacedCallout, 'anchor' | 'knee' | 'attach'>[]): number {
  let n = 0;
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) if (leadersCross(placed[i], placed[j])) n++;
  }
  return n;
}

/** Number of (leader, other callout box) pairs where the leader runs under the box. */
export function countLeadersUnderBoxes(placed: Pick<PlacedCallout, 'anchor' | 'knee' | 'attach' | 'box'>[]): number {
  let n = 0;
  for (let i = 0; i < placed.length; i++) {
    for (let j = 0; j < placed.length; j++) if (i !== j && leaderUnderBox(placed[i], placed[j].box)) n++;
  }
  return n;
}

function leaderUnderBox(a: Pick<PlacedCallout, 'anchor' | 'knee' | 'attach'>, box: Rect): boolean {
  const r: Rect = { x: box.x + 1, y: box.y + 1, w: box.w - 2, h: box.h - 2 };
  return segmentHitsRect(a.anchor, a.knee, r) || segmentHitsRect(a.knee, a.attach, r);
}

/** Crossed leaders plus leaders running under other boxes: what the layout tries to drive to zero. */
function tangles(placed: PlacedCallout[]): number {
  return countCrossings(placed) + countLeadersUnderBoxes(placed);
}

function leadersCross(a: Pick<PlacedCallout, 'anchor' | 'knee' | 'attach'>, b: Pick<PlacedCallout, 'anchor' | 'knee' | 'attach'>): boolean {
  const sa: [XY, XY][] = [[a.anchor, a.knee], [a.knee, a.attach]];
  const sb: [XY, XY][] = [[b.anchor, b.knee], [b.knee, b.attach]];
  return sa.some(([p, q]) => sb.some(([r, t]) => segIntersects(p, q, r, t)));
}

/** Box of size w x h centred at c, with its leader from `tip`: attach at the middle of the side facing the tip. */
function placeAt(tip: XY, c: XY, w: number, h: number): { box: Rect; knee: XY; attach: XY } {
  const box: Rect = { x: c[0] - w / 2, y: c[1] - h / 2, w, h };
  const dx = tip[0] - c[0];
  const dy = tip[1] - c[1];
  let attach: XY;
  let knee: XY;
  if (Math.abs(dx) / w >= Math.abs(dy) / h) {
    // tip is to the left/right: leader enters a side, with a short horizontal knee (as in hand markups)
    const sx = dx >= 0 ? 1 : -1;
    attach = [c[0] + (sx * w) / 2, c[1]];
    knee = [attach[0] + sx * Math.min(KNEE, Math.max(0, Math.abs(dx) - w / 2)), c[1]];
  } else {
    const sy = dy >= 0 ? 1 : -1;
    attach = [c[0], c[1] + (sy * h) / 2];
    knee = [c[0], attach[1] + sy * Math.min(KNEE, Math.max(0, Math.abs(dy) - h / 2))];
  }
  return { box, knee, attach };
}

/**
 * Least-squares positions along a line, in the given order, with minimum gaps between neighbours
 * (pool-adjacent-violators on the gap-shifted targets). Keeps the order, moves things as little as possible.
 */
export function spreadInOrder(targets: number[], gaps: number[]): number[] {
  // y_i = x_i - (sum of gaps before i) must be non-decreasing; fit y to the shifted targets.
  const offs: number[] = [0];
  for (let i = 1; i < targets.length; i++) offs.push(offs[i - 1] + gaps[i - 1]);
  const shifted = targets.map((t, i) => t - offs[i]);
  const blocks: { sum: number; n: number }[] = [];
  for (const v of shifted) {
    blocks.push({ sum: v, n: 1 });
    while (blocks.length > 1 && blocks[blocks.length - 2].sum / blocks[blocks.length - 2].n > blocks[blocks.length - 1].sum / blocks[blocks.length - 1].n) {
      const b = blocks.pop()!;
      blocks[blocks.length - 1].sum += b.sum;
      blocks[blocks.length - 1].n += b.n;
    }
  }
  const y: number[] = [];
  for (const b of blocks) for (let k = 0; k < b.n; k++) y.push(b.sum / b.n);
  return y.map((v, i) => v + offs[i]);
}

interface Ellipse {
  c: XY;
  a: number;
  b: number;
}

/** Arc-length table for an ellipse, so positions can be spread evenly along it. */
function arcTable(e: Ellipse, steps = 720): { phi: number[]; s: number[]; length: number } {
  const phi: number[] = [];
  const s: number[] = [];
  let acc = 0;
  let prev: XY = [e.c[0] + e.a, e.c[1]];
  for (let i = 0; i <= steps; i++) {
    const p = (i / steps) * 2 * Math.PI;
    const pt: XY = [e.c[0] + e.a * Math.cos(p), e.c[1] + e.b * Math.sin(p)];
    acc += Math.hypot(pt[0] - prev[0], pt[1] - prev[1]);
    prev = pt;
    phi.push(p);
    s.push(acc);
  }
  return { phi, s, length: acc };
}

function phiAt(table: { phi: number[]; s: number[]; length: number }, sv: number): number {
  const L = table.length;
  const v = ((sv % L) + L) % L;
  let lo = 0;
  let hi = table.s.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (table.s[mid] < v) lo = mid;
    else hi = mid;
  }
  const f = table.s[hi] === table.s[lo] ? 0 : (v - table.s[lo]) / (table.s[hi] - table.s[lo]);
  return table.phi[lo] + f * (table.phi[hi] - table.phi[lo]);
}

function sAt(table: { phi: number[]; s: number[] }, phi: number): number {
  const p = ((phi % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const i = Math.min(table.phi.length - 2, Math.floor((p / (2 * Math.PI)) * (table.phi.length - 1)));
  const f = (p - table.phi[i]) / (table.phi[i + 1] - table.phi[i]);
  return table.s[i] + f * (table.s[i + 1] - table.s[i]);
}

/**
 * Callouts arranged like a clock face around the work area ("option A"):
 * each sits on an ellipse enclosing the work area and all arrow tips, in the same angular order as
 * the tips it points to (so leaders don't cross), spread just enough not to overlap. If one ring is
 * too full, further rings are added outside it. A final pass swaps any pair whose leaders still cross,
 * and anything left overlapping is moved to the nearest clear spot on the sheet.
 */
export function layoutCallouts(
  specs: CalloutSpec[],
  frame: Rect,
  workArea: XY[],
  textWidth: (text: string) => number,
): PlacedCallout[] {
  if (!specs.length) return [];
  const margin = 6;
  const GAP = 8; // minimum clear space between neighbouring boxes, pt
  const sizes = specs.map((sp) => ({
    w: Math.max(...sp.lines.map(textWidth)) + 2 * CALLOUT_PAD,
    h: sp.lines.length * CALLOUT_LEADING + 2 * CALLOUT_PAD,
  }));
  const maxW = Math.max(...sizes.map((z) => z.w));
  const maxH = Math.max(...sizes.map((z) => z.h));

  // Hull of the work area and all tips: the rings go outside it.
  const pts = [...workArea, ...specs.map((sp) => sp.anchor)];
  const minX = Math.min(...pts.map((p) => p[0]));
  const maxX = Math.max(...pts.map((p) => p[0]));
  const minY = Math.min(...pts.map((p) => p[1]));
  const maxY = Math.max(...pts.map((p) => p[1]));
  const c: XY = [(minX + maxX) / 2, (minY + maxY) / 2];
  const hx = (maxX - minX) / 2;
  const hy = (maxY - minY) / 2;
  // Ellipse through the hull's corners (half-axes x sqrt 2), plus room for half a box and a gap.
  const baseA = hx * Math.SQRT2 + maxW / 2 + 24;
  const baseB = hy * Math.SQRT2 + maxH / 2 + 20;
  // Largest ellipse that keeps boxes on the sheet.
  const limA = Math.min(c[0] - frame.x, frame.x + frame.w - c[0]) - maxW / 2 - margin;
  const limB = Math.min(c[1] - frame.y, frame.y + frame.h - c[1]) - maxH / 2 - margin;
  // Rings: grow one ring outward (up to the sheet's edge) before adding a second, because a single
  // ring keeps every callout in clock order and so keeps leaders from crossing.
  let grow = 0; // 0 = tight around the hull, 1 = as big as the sheet allows
  let spreadRings = 0; // when > 1: that many rings, the outermost pushed out to the sheet's edge
  const stepA = maxW * 0.55 + 24;
  const stepB = maxH + 22;
  const ring = (r: number): Ellipse => {
    let a0 = baseA + grow * Math.max(0, limA - baseA);
    let b0 = baseB + grow * Math.max(0, limB - baseB);
    if (spreadRings > 1) {
      a0 = Math.max(a0, limA - (spreadRings - 1) * stepA);
      b0 = Math.max(b0, limB - (spreadRings - 1) * stepB);
    }
    return {
      c,
      a: Math.max(20, Math.min(a0 + r * stepA, limA)),
      b: Math.max(14, Math.min(b0 + r * stepB, limB)),
    };
  };

  const attempt = (mode: 'radial' | 'nearest') => {
  spreadRings = 0;
  // Natural angular order of the tips around the centre.
  // Where a tip "wants" its callout on ring e: straight out from the centre, or the nearest point of the ring.
  const idealPhi = (i: number, e: Ellipse) => {
    const p = specs[i].anchor;
    if (mode === 'radial') return Math.atan2((p[1] - c[1]) / e.b, (p[0] - c[0]) / e.a);
    let best = 0;
    let bestD = Infinity;
    for (let k = 0; k < 360; k++) {
      const ph = (k / 360) * 2 * Math.PI;
      const d = Math.hypot(c[0] + e.a * Math.cos(ph) - p[0], c[1] + e.b * Math.sin(ph) - p[1]);
      if (d < bestD) [bestD, best] = [d, ph];
    }
    return best;
  };
  const sortKey = (i: number) => {
    const ph = idealPhi(i, ring(0));
    return ((ph % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  };
  const order = specs.map((_, i) => i).sort((i, j) => sortKey(i) - sortKey(j));

  // Space needed between two neighbours on a ring, along its direction of travel t.
  const need = (i: number, j: number, t: XY) => {
    const wbar = (sizes[i].w + sizes[j].w) / 2 + GAP;
    const hbar = (sizes[i].h + sizes[j].h) / 2 + GAP;
    return Math.min(Math.abs(t[0]) > 1e-6 ? wbar / Math.abs(t[0]) : Infinity, Math.abs(t[1]) > 1e-6 ? hbar / Math.abs(t[1]) : Infinity);
  };
  const tangent = (e: Ellipse, phi: number): XY => {
    const t: XY = [-e.a * Math.sin(phi), e.b * Math.cos(phi)];
    const l = Math.hypot(t[0], t[1]) || 1;
    return [t[0] / l, t[1] / l];
  };

  // How many rings (and how big) are needed: total required spacing vs each ring's length.
  const ringsFit = (rings: number) => {
    for (let r = 0; r < rings; r++) {
      const e = ring(r);
      const members = order.filter((_, k) => k % rings === r);
      let total = 0;
      for (let k = 0; k < members.length && members.length > 1; k++) {
        const i = members[k];
        const j = members[(k + 1) % members.length];
        total += need(i, j, tangent(e, idealPhi(i, e)));
      }
      if (total > arcTable(e, 360).length * 0.92) return false;
    }
    return true;
  };
  let rings = 1;
  search: for (; rings <= 6; rings++) {
    for (grow = 0; grow <= 1.0001; grow += 0.1) if (ringsFit(rings)) break search;
  }
  if (rings > 6) [rings, grow] = [6, 1];
  // Several rings: use the whole sheet, so the rings sit further apart and the boxes have room.
  spreadRings = rings;

  const centres: XY[] = new Array(specs.length);
  const ringOf: number[] = new Array(specs.length);
  for (let r = 0; r < rings; r++) {
    const e = ring(r);
    const table = arcTable(e);
    const L = table.length;
    const members = order.filter((_, k) => k % rings === r);
    if (!members.length) continue;
    const ideal = members.map((i) => sAt(table, idealPhi(i, e)));
    // Cut the circle at the biggest empty stretch, so the spread happens in one straight run.
    let cut = 0;
    let biggest = -1;
    for (let k = 0; k < members.length; k++) {
      const gap = (ideal[(k + 1) % members.length] - ideal[k] + L) % L || (members.length === 1 ? L : 0);
      if (gap > biggest) [biggest, cut] = [gap, (k + 1) % members.length];
    }
    const seq = members.map((_, k) => (cut + k) % members.length);
    let targets = seq.map((k) => ideal[k]);
    for (let k = 1; k < targets.length; k++) while (targets[k] < targets[k - 1]) targets[k] += L;
    let pos = targets.slice();
    for (let iter = 0; iter < 3; iter++) {
      const gaps = seq.slice(0, -1).map((k, n) => {
        const mid = phiAt(table, (pos[n] + pos[n + 1]) / 2);
        return need(members[k], members[seq[n + 1]], tangent(e, mid));
      });
      pos = spreadInOrder(targets, gaps);
      // If the run wraps round onto its own start, spread everything evenly instead.
      const wrapNeed = seq.length > 1 ? need(members[seq[seq.length - 1]], members[seq[0]], tangent(e, phiAt(table, pos[0]))) : 0;
      if (pos[pos.length - 1] - pos[0] > L - wrapNeed) {
        const total = gaps.reduce((x, y) => x + y, 0) + wrapNeed;
        const extra = Math.max(0, L - total) / Math.max(seq.length, 1);
        pos = [pos[0]];
        for (let n = 0; n < gaps.length; n++) pos.push(pos[n] + gaps[n] + extra);
      }
      targets = targets.map((t) => t); // targets unchanged; gaps refined from the new positions
    }
    seq.forEach((k, n) => {
      const i = members[k];
      const ph = phiAt(table, pos[n]);
      centres[i] = [c[0] + e.a * Math.cos(ph), c[1] + e.b * Math.sin(ph)];
      ringOf[i] = r;
    });
  }

  const clampC = (i: number, p: XY): XY => [
    Math.min(Math.max(p[0], frame.x + margin + sizes[i].w / 2), frame.x + frame.w - margin - sizes[i].w / 2),
    Math.min(Math.max(p[1], frame.y + margin + sizes[i].h / 2), frame.y + frame.h - margin - sizes[i].h / 2),
  ];
  let placed: PlacedCallout[] = specs.map((sp, i) => ({ ...sp, ...placeAt(sp.anchor, clampC(i, centres[i]), sizes[i].w, sizes[i].h), crowded: false }));

  // Untangle: swap the positions of two callouts (on any ring) when that removes crossings.
  const crossingsOf = (list: PlacedCallout[]) => tangles(list);
  let current = crossingsOf(placed);
  for (let pass = 0; pass < 12 && current > 0; pass++) {
    let improved = false;
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        if (!leadersCross(placed[i], placed[j]) && !leaderUnderBox(placed[i], placed[j].box) && !leaderUnderBox(placed[j], placed[i].box)) continue;
        const ci: XY = [placed[j].box.x + placed[j].box.w / 2, placed[j].box.y + placed[j].box.h / 2];
        const cj: XY = [placed[i].box.x + placed[i].box.w / 2, placed[i].box.y + placed[i].box.h / 2];
        const trial = placed.slice();
        trial[i] = { ...placed[i], ...placeAt(placed[i].anchor, clampC(i, ci), sizes[i].w, sizes[i].h) };
        trial[j] = { ...placed[j], ...placeAt(placed[j].anchor, clampC(j, cj), sizes[j].w, sizes[j].h) };
        const boxClash = [i, j].some((k) => trial.some((o, m) => m !== k && overlaps(o.box, trial[k].box, 2)));
        const n = crossingsOf(trial);
        if (!boxClash && n < current) {
          placed = trial;
          current = n;
          improved = true;
        }
      }
    }
    if (!improved) break;
  }

    // Then swap neighbouring callouts along each ring (like a bubble sort) while that removes crossings,
    // or keeps them equal and shortens the leaders.
    const len = (p: PlacedCallout) => Math.hypot(p.anchor[0] - p.attach[0], p.anchor[1] - p.attach[1]);
    const centreOf = (p: PlacedCallout): XY => [p.box.x + p.box.w / 2, p.box.y + p.box.h / 2];
    for (let pass = 0; pass < 25 && current > 0; pass++) {
      let improved = false;
      for (let r = 0; r < rings; r++) {
        const idx = placed
          .map((_, i) => i)
          .filter((i) => ringOf[i] === r)
          .sort((i, j) => Math.atan2(centreOf(placed[i])[1] - c[1], centreOf(placed[i])[0] - c[0]) - Math.atan2(centreOf(placed[j])[1] - c[1], centreOf(placed[j])[0] - c[0]));
        for (let k = 0; k < idx.length; k++) {
          const i = idx[k];
          const j = idx[(k + 1) % idx.length];
          if (i === j) continue;
          const trial = placed.slice();
          trial[i] = { ...placed[i], ...placeAt(placed[i].anchor, clampC(i, centreOf(placed[j])), sizes[i].w, sizes[i].h) };
          trial[j] = { ...placed[j], ...placeAt(placed[j].anchor, clampC(j, centreOf(placed[i])), sizes[j].w, sizes[j].h) };
          if ([i, j].some((m) => trial.some((o, q) => q !== m && overlaps(o.box, trial[m].box, 2)))) continue;
          const n = tangles(trial);
          if (n < current || (n === current && len(trial[i]) + len(trial[j]) < len(placed[i]) + len(placed[j]) - 1)) {
            if (n < current) improved = true;
            placed = trial;
            current = n;
            idx[k] = j;
            idx[(k + 1) % idx.length] = i;
          }
        }
      }
      if (!improved) break;
    }
    // Finally any two callouts may trade places when that removes crossings or, at equal crossings,
    // shortens their leaders.
    for (let pass = 0; pass < 6; pass++) {
      let changed = false;
      for (let i = 0; i < placed.length; i++) {
        for (let j = i + 1; j < placed.length; j++) {
          const trial = placed.slice();
          trial[i] = { ...placed[i], ...placeAt(placed[i].anchor, clampC(i, centreOf(placed[j])), sizes[i].w, sizes[i].h) };
          trial[j] = { ...placed[j], ...placeAt(placed[j].anchor, clampC(j, centreOf(placed[i])), sizes[j].w, sizes[j].h) };
          const before = len(placed[i]) + len(placed[j]);
          const after = len(trial[i]) + len(trial[j]);
          if (current === 0 && after >= before - 1) continue;
          if ([i, j].some((m) => trial.some((o, q) => q !== m && overlaps(o.box, trial[m].box, 2)))) continue;
          const n = tangles(trial);
          if (n < current || (n === current && after < before - 1)) {
            placed = trial;
            current = n;
            changed = true;
          }
        }
      }
      if (!changed) break;
    }
    return { placed, current };
  };
  const leaderLength = (list: PlacedCallout[]) => list.reduce((t, p) => t + Math.hypot(p.anchor[0] - p.attach[0], p.anchor[1] - p.attach[1]), 0);
  const insideFrame = (b: Rect) => b.x >= frame.x + margin - 0.01 && b.y >= frame.y + margin - 0.01 && b.x + b.w <= frame.x + frame.w - margin + 0.01 && b.y + b.h <= frame.y + frame.h - margin + 0.01;

  // Repair anything still overlapping another box, the work area, or another callout's arrow tip:
  // first nudge it a little (out from the centre, or along the ring), else find a free spot anywhere.
  const repair = (placed: PlacedCallout[]): PlacedCallout[] => {
    const out: PlacedCallout[] = [];
    const blocked = (p: PlacedCallout, box: Rect) =>
      out.some((o) => overlaps(o.box, box, 2)) ||
      (workArea.length > 2 && rectHitsPolygon(box, workArea)) ||
      placed.some((o) => o !== p && o.anchor[0] > box.x - 2 && o.anchor[0] < box.x + box.w + 2 && o.anchor[1] > box.y - 2 && o.anchor[1] < box.y + box.h + 2);
    for (const p of placed) {
      if (!blocked(p, p.box)) {
        out.push(p);
        continue;
      }
      const w = p.box.w;
      const h = p.box.h;
      const pc: XY = [p.box.x + w / 2, p.box.y + h / 2];
      const rl = Math.hypot(pc[0] - c[0], pc[1] - c[1]) || 1;
      const rad: XY = [(pc[0] - c[0]) / rl, (pc[1] - c[1]) / rl];
      const tan: XY = [-rad[1], rad[0]];
      let best: { score: number; v: PlacedCallout } | null = null;
      for (let k = -6; k <= 30; k++) {
        for (let m = -12; m <= 12; m++) {
          if (k === 0 && m === 0) continue;
          const q: XY = [pc[0] + rad[0] * k * 6 + tan[0] * m * 8, pc[1] + rad[1] * k * 6 + tan[1] * m * 8];
          const v = { ...p, ...placeAt(p.anchor, q, w, h) };
          if (!insideFrame(v.box) || blocked(p, v.box)) continue;
          const crossings = out.reduce((t, o) => t + (leadersCross(o, v) ? 1 : 0) + (leaderUnderBox(o, v.box) ? 1 : 0) + (leaderUnderBox(v, o.box) ? 1 : 0), 0);
          const score = crossings * 1000 + Math.hypot(q[0] - pc[0], q[1] - pc[1]);
          if (!best || score < best.score) best = { score, v };
        }
      }
      if (best) {
        out.push(best.v);
        continue;
      }
      const spot = freeSpot(p, w, h, frame, margin, out, workArea, true) ?? freeSpot(p, w, h, frame, margin, out, workArea, false);
      out.push(spot ? { ...p, box: spot.box, knee: spot.knee, attach: spot.attach, crowded: false } : { ...p, crowded: true });
    }
    // Then nudge any callout whose leader still crosses another, or runs under another box, to the
    // nearby spot that tangles least.
    const inv = (v: PlacedCallout, k: number, list: PlacedCallout[]) =>
      list.reduce((t, o, m) => (m === k ? t : t + (leadersCross(o, v) ? 1 : 0) + (leaderUnderBox(o, v.box) ? 1 : 0) + (leaderUnderBox(v, o.box) ? 1 : 0)), 0);
    for (let pass = 0; pass < 4; pass++) {
      let changed = false;
      for (let k = 0; k < out.length; k++) {
        const p = out[k];
        if (p.crowded) continue;
        const now = inv(p, k, out);
        if (now === 0) continue;
        const w = p.box.w;
        const h = p.box.h;
        const pc: XY = [p.box.x + w / 2, p.box.y + h / 2];
        const rl = Math.hypot(pc[0] - c[0], pc[1] - c[1]) || 1;
        const rad: XY = [(pc[0] - c[0]) / rl, (pc[1] - c[1]) / rl];
        const tan: XY = [-rad[1], rad[0]];
        let best: { score: number; v: PlacedCallout } | null = null;
        for (let a = -8; a <= 20; a++) {
          for (let m = -15; m <= 15; m++) {
            if (a === 0 && m === 0) continue;
            const q: XY = [pc[0] + rad[0] * a * 6 + tan[0] * m * 8, pc[1] + rad[1] * a * 6 + tan[1] * m * 8];
            const v = { ...p, ...placeAt(p.anchor, q, w, h) };
            if (!insideFrame(v.box)) continue;
            if (out.some((o, m2) => m2 !== k && overlaps(o.box, v.box, 2))) continue;
            if (workArea.length > 2 && rectHitsPolygon(v.box, workArea)) continue;
            if (out.some((o, m2) => m2 !== k && o.anchor[0] > v.box.x - 2 && o.anchor[0] < v.box.x + v.box.w + 2 && o.anchor[1] > v.box.y - 2 && o.anchor[1] < v.box.y + v.box.h + 2)) continue;
            const n = inv(v, k, out);
            if (n >= now) continue;
            const score = n * 1000 + Math.hypot(q[0] - pc[0], q[1] - pc[1]);
            if (!best || score < best.score) best = { score, v };
          }
        }
        if (best) {
          out[k] = best.v;
          changed = true;
        }
      }
      if (!changed) break;
    }
    return out;
  };

  const results = [attempt('radial'), attempt('nearest')].map((t) => {
    const list = repair(t.placed);
    return { list, crowded: list.filter((p) => p.crowded).length, crossings: tangles(list), length: leaderLength(list) };
  });
  results.sort((x, y) => x.crowded - y.crowded || x.crossings - y.crossings || x.length - y.length);
  return results[0].list;
}
