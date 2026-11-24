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

/**
 * Place callout boxes around their anchors: outside the work area where possible, inside the
 * frame, not overlapping each other, with leaders that don't cross. Greedy: callouts are placed
 * in order around the work area, each taking its best-scoring free spot.
 */
export function layoutCallouts(
  specs: CalloutSpec[],
  frame: Rect,
  workArea: XY[],
  textWidth: (text: string) => number,
): PlacedCallout[] {
  const cx = workArea.reduce((s, p) => s + p[0], 0) / Math.max(workArea.length, 1);
  const cy = workArea.reduce((s, p) => s + p[1], 0) / Math.max(workArea.length, 1);
  const ordered = [...specs].sort(
    (a, b) => Math.atan2(a.anchor[1] - cy, a.anchor[0] - cx) - Math.atan2(b.anchor[1] - cy, b.anchor[0] - cx),
  );
  const placed: PlacedCallout[] = [];
  const margin = 6;
  for (const spec of ordered) {
    const w = Math.max(...spec.lines.map(textWidth)) + 2 * CALLOUT_PAD;
    const h = spec.lines.length * CALLOUT_LEADING + 2 * CALLOUT_PAD;
    const out = Math.atan2(spec.anchor[1] - cy, spec.anchor[0] - cx);
    let best: { score: number; box: Rect; knee: XY; attach: XY; crowded: boolean } | null = null;
    for (const dist of [36, 56, 80, 110, 145, 185]) {
      for (let k = 0; k < 24; k++) {
        // Try directions alternating either side of "straight out from the work area".
        const step = Math.ceil(k / 2) * (k % 2 ? 1 : -1);
        const ang = out + (step * Math.PI) / 12;
        const tip = spec.anchor;
        const target: XY = [tip[0] + Math.cos(ang) * dist, tip[1] + Math.sin(ang) * dist];
        const toRight = target[0] >= tip[0];
        // Short horizontal "knee" into the side of the box facing the anchor (as in hand markups).
        const attach: XY = [target[0] + (toRight ? KNEE : -KNEE), target[1]];
        const box: Rect = { x: toRight ? attach[0] : attach[0] - w, y: attach[1] - h / 2, w, h };
        const knee: XY = target;
        if (box.x < frame.x + margin || box.y < frame.y + margin || box.x + w > frame.x + frame.w - margin || box.y + h > frame.y + frame.h - margin) continue;
        let penalty = 0;
        if (placed.some((p) => overlaps(p.box, box, 4))) penalty += 10000;
        if (workArea.length > 2 && rectHitsPolygon(box, workArea)) penalty += 2000;
        for (const p of placed) {
          if (segIntersects(tip, knee, p.anchor, p.knee) || segIntersects(knee, attach, p.anchor, p.knee)) penalty += 400;
          if (segmentHitsRect(tip, knee, p.box)) penalty += 1500;
          if (segmentHitsRect(p.anchor, p.knee, box)) penalty += 1500;
        }
        // Other callouts' arrow tips shouldn't be hidden under this box.
        if (placed.some((p) => p.anchor[0] > box.x && p.anchor[0] < box.x + w && p.anchor[1] > box.y && p.anchor[1] < box.y + h)) penalty += 3000;
        const score = penalty + dist + Math.abs(step) * 6;
        if (!best || score < best.score) best = { score, box, knee, attach, crowded: penalty >= 1500 };
      }
      if (best && best.score < 1000) break; // a clean spot at this distance: stop looking further out
    }
    if (!best || best.crowded) {
      // No clean spot near the anchor: take the nearest clean spot anywhere on the sheet.
      // First insist leaders stay clear of other callouts; then allow them to pass behind one.
      const spot = freeSpot(spec, w, h, frame, margin, placed, workArea, true) ?? freeSpot(spec, w, h, frame, margin, placed, workArea, false);
      if (spot) best = { score: spot.score, box: spot.box, knee: spot.knee, attach: spot.attach, crowded: false };
    }
    if (!best) {
      // Nothing fits inside the frame: park it at the anchor, clamped to the frame.
      const box: Rect = {
        x: Math.min(Math.max(spec.anchor[0] + 20, frame.x + margin), frame.x + frame.w - w - margin),
        y: Math.min(Math.max(spec.anchor[1] - h / 2, frame.y + margin), frame.y + frame.h - h - margin),
        w,
        h,
      };
      const attach: XY = [box.x, box.y + h / 2];
      best = { score: Infinity, box, knee: attach, attach, crowded: true };
    }
    placed.push({ ...spec, box: best.box, knee: best.knee, attach: best.attach, crowded: best.crowded });
  }
  return placed;
}
