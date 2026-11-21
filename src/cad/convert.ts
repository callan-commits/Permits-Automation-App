/**
 * Convert a parsed LibreDWG database into simple map geometry (CadDrawing).
 *
 * Output coordinates are unchanged drawing coordinates (for utility surveys:
 * MGA easting/northing in metres). Curves are tessellated to a chord tolerance
 * small enough not to matter for offset checks.
 */
import type { DwgDatabase } from '@mlightcad/libredwg-web';
import { aciToHex, trueColorToHex } from './aci';
import type { CadDrawing, CadFeature, CadLayer, CadText, XY } from './types';

/** Max distance (m) between a true curve and its straight-segment approximation. */
export const CHORD_TOLERANCE = 0.01;
const MAX_BLOCK_DEPTH = 8;

// Loosely-typed entity: the library's union types are large and we read fields defensively.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ent = Record<string, any> & { type: string; layer: string; handle: string };

/** 2D affine transform: x' = a*x + c*y + e, y' = b*x + d*y + f */
type Mat = [number, number, number, number, number, number];
const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

function mul(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}
const translate = (x: number, y: number): Mat => [1, 0, 0, 1, x, y];
const rotate = (r: number): Mat => [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0];
const scale = (sx: number, sy: number): Mat => [sx, 0, 0, sy, 0, 0];
const apply = (m: Mat, x: number, y: number): XY => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
/** Uniform scale factor of a transform (for text heights). */
const matScale = (m: Mat) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));

/** Object Coordinate System: entities extruded along -Z are mirrored in X. */
function ocs(e: Ent): Mat {
  const z = e.extrusionDirection?.z;
  return typeof z === 'number' && z < 0 ? scale(-1, 1) : IDENTITY;
}

function segmentsFor(radius: number, sweep: number): number {
  const r = Math.max(Math.abs(radius), 1e-9);
  const step = r > CHORD_TOLERANCE ? 2 * Math.acos(1 - CHORD_TOLERANCE / r) : Math.PI / 8;
  return Math.min(2048, Math.max(4, Math.ceil(Math.abs(sweep) / step)));
}

export function arcPoints(cx: number, cy: number, r: number, start: number, sweep: number): XY[] {
  const n = segmentsFor(r, sweep);
  const pts: XY[] = [];
  for (let i = 0; i <= n; i++) {
    const a = start + (sweep * i) / n;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

/** Points along a polyline segment with a bulge (bulge = tan(sweep/4), +ve = counter-clockwise). */
export function bulgeSegment(p1: XY, p2: XY, bulge: number): XY[] {
  if (!bulge || Math.abs(bulge) < 1e-12) return [p1, p2];
  const dx = p2[0] - p1[0];
  const dy = p2[1] - p1[1];
  const c = Math.hypot(dx, dy);
  if (c === 0) return [p1];
  const sweep = 4 * Math.atan(bulge);
  const r = (c * (1 + bulge * bulge)) / (4 * Math.abs(bulge));
  const d = (c * (1 - bulge * bulge)) / (4 * bulge); // signed distance chord-midpoint -> centre
  const mx = (p1[0] + p2[0]) / 2;
  const my = (p1[1] + p2[1]) / 2;
  const cx = mx - (dy / c) * d;
  const cy = my + (dx / c) * d;
  const start = Math.atan2(p1[1] - cy, p1[0] - cx);
  const pts = arcPoints(cx, cy, r, start, sweep);
  pts[0] = p1;
  pts[pts.length - 1] = p2;
  return pts;
}

function polylineWithBulges(verts: { x: number; y: number; bulge?: number }[], closed: boolean): XY[] {
  const out: XY[] = [];
  const n = verts.length;
  const segs = closed ? n : n - 1;
  if (n === 1) return [[verts[0].x, verts[0].y]];
  for (let i = 0; i < segs; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % n];
    const pts = bulgeSegment([a.x, a.y], [b.x, b.y], a.bulge ?? 0);
    if (out.length) pts.shift();
    out.push(...pts);
  }
  return out;
}

/** Evaluate a (rational) B-spline with de Boor's algorithm. */
function nurbsPoints(degree: number, knots: number[], ctrl: XY[], weights?: number[]): XY[] {
  const n = ctrl.length;
  if (n < 2 || knots.length < n + degree + 1) return ctrl;
  const w = weights && weights.length === n ? weights : ctrl.map(() => 1);
  const t0 = knots[degree];
  const t1 = knots[n];
  const samples = Math.max(32, n * 16);
  const out: XY[] = [];
  for (let s = 0; s <= samples; s++) {
    const t = t0 + ((t1 - t0) * s) / samples;
    let k = degree;
    while (k < n - 1 && t >= knots[k + 1]) k++;
    const d = [];
    for (let j = 0; j <= degree; j++) {
      const i = k - degree + j;
      d.push([ctrl[i][0] * w[i], ctrl[i][1] * w[i], w[i]]);
    }
    for (let r = 1; r <= degree; r++) {
      for (let j = degree; j >= r; j--) {
        const i = k - degree + j;
        const denom = knots[i + degree - r + 1] - knots[i];
        const alpha = denom === 0 ? 0 : (t - knots[i]) / denom;
        for (let q = 0; q < 3; q++) d[j][q] = (1 - alpha) * d[j - 1][q] + alpha * d[j][q];
      }
    }
    const [x, y, ww] = d[degree];
    out.push([x / ww, y / ww]);
  }
  return out;
}

/** Centripetal Catmull-Rom through fit points (used when a spline only stores fit points). */
function fitPointCurve(pts: XY[], closed: boolean): XY[] {
  if (pts.length < 3) return pts;
  const P = closed ? [pts[pts.length - 1], ...pts, pts[0], pts[1]] : [pts[0], ...pts, pts[pts.length - 1]];
  const out: XY[] = [];
  const steps = 16;
  for (let i = 1; i < P.length - 2; i++) {
    const [p0, p1, p2, p3] = [P[i - 1], P[i], P[i + 1], P[i + 2]];
    for (let s = i === 1 ? 0 : 1; s <= steps; s++) {
      const t = s / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  return out;
}

/** Strip AutoCAD MTEXT formatting codes, keeping line breaks. */
export function cleanMText(raw: string): string {
  return raw
    .replace(/\\P/g, '\n')
    .replace(/\\~/g, ' ')
    .replace(/\\[ACFHQTWfhpqtw][^;]*;/g, '')
    .replace(/\\S([^^;]*)\^([^;]*);/g, '$1/$2')
    .replace(/\\[LlOoKkNX]/g, '')
    .replace(/[{}]/g, '')
    .replace(/\\\\/g, '\\');
}

export function cleanText(raw: string): string {
  return raw
    .replace(/%%[cC]/g, 'Ø')
    .replace(/%%[dD]/g, '°')
    .replace(/%%[pP]/g, '±')
    .replace(/%%[uUoO]/g, '')
    .replace(/%%%/g, '%');
}

const H_ALIGN: CadText['hAlign'][] = ['left', 'center', 'right', 'center', 'center', 'center'];
const V_ALIGN: CadText['vAlign'][] = ['baseline', 'bottom', 'middle', 'top'];
// MTEXT attachment points 1..9: TL TC TR ML MC MR BL BC BR
const MTEXT_ALIGN: [CadText['hAlign'], CadText['vAlign']][] = [
  ['left', 'top'],
  ['center', 'top'],
  ['right', 'top'],
  ['left', 'middle'],
  ['center', 'middle'],
  ['right', 'middle'],
  ['left', 'bottom'],
  ['center', 'bottom'],
  ['right', 'bottom'],
];

interface Ctx {
  m: Mat;
  /** Layer that replaces "0" for block contents. */
  insertLayer?: string;
  /** Colour used for BYBLOCK entities. */
  blockColor?: string;
  block?: string;
  depth: number;
}

export function convertDatabase(db: DwgDatabase, fileName: string): CadDrawing {
  const layerColor = new Map<string, string>();
  const layerHidden = new Map<string, boolean>();
  for (const l of db.tables?.LAYER?.entries ?? []) {
    layerColor.set(l.name, aciToHex(Math.abs(l.colorIndex ?? 7)));
    layerHidden.set(l.name, Boolean(l.off || l.frozen || (l.colorIndex ?? 0) < 0));
  }
  const blocks = new Map<string, { basePoint: { x: number; y: number }; entities: Ent[] }>();
  const paperSpaceHandles = new Set<string>();
  for (const b of db.tables?.BLOCK_RECORD?.entries ?? []) {
    blocks.set(b.name, { basePoint: b.basePoint ?? { x: 0, y: 0 }, entities: (b.entities ?? []) as Ent[] });
    if (b.name.toUpperCase().startsWith('*PAPER_SPACE')) paperSpaceHandles.add(b.handle);
  }

  const features: CadFeature[] = [];
  const skipped: Record<string, number> = {};
  const warnings: string[] = [];
  const skip = (t: string): void => {
    skipped[t] = (skipped[t] ?? 0) + 1;
  };

  const resolveLayer = (e: Ent, ctx: Ctx) => (e.layer === '0' && ctx.insertLayer ? ctx.insertLayer : e.layer || '0');
  const resolveColor = (e: Ent, ctx: Ctx, layer: string) => {
    if (typeof e.color === 'number') return trueColorToHex(e.color);
    const ci = e.colorIndex ?? 256;
    if (ci === 0) return ctx.blockColor ?? layerColor.get(layer) ?? '#ffffff';
    if (ci === 256 || ci < 0 || ci > 256) return layerColor.get(layer) ?? '#ffffff';
    return aciToHex(ci);
  };

  const emitText = (
    base: Omit<CadText, 'kind' | 'coord' | 'text' | 'height' | 'rotation' | 'hAlign' | 'vAlign'>,
    m: Mat,
    x: number,
    y: number,
    text: string,
    height: number,
    rotation: number,
    hAlign: CadText['hAlign'],
    vAlign: CadText['vAlign'],
  ) => {
    if (!text.trim()) return;
    // Rotate the text's baseline direction through the full transform (handles block rotation and mirroring).
    const dx = Math.cos(rotation);
    const dy = Math.sin(rotation);
    const rot = Math.atan2(m[1] * dx + m[3] * dy, m[0] * dx + m[2] * dy);
    features.push({
      ...base,
      kind: 'text',
      coord: apply(m, x, y),
      text,
      height: height * matScale(m),
      rotation: rot,
      hAlign,
      vAlign,
    });
  };

  const textFromBase = (t: Ent): { x: number; y: number; h: CadText['hAlign']; v: CadText['vAlign'] } => {
    const ha = t.halign ?? 0;
    const va = t.valign ?? 0;
    const sp = t.startPoint ?? { x: 0, y: 0 };
    const ep = t.endPoint ?? sp;
    if (ha === 3 || ha === 5) return { x: (sp.x + ep.x) / 2, y: (sp.y + ep.y) / 2, h: 'center', v: 'baseline' };
    const useEnd = (ha !== 0 || va !== 0) && (ep.x !== 0 || ep.y !== 0);
    const p = useEnd ? ep : sp;
    return { x: p.x, y: p.y, h: H_ALIGN[ha] ?? 'left', v: V_ALIGN[va] ?? 'baseline' };
  };

  function visit(e: Ent, ctx: Ctx): void {
    if (e.isVisible === false) return;
    const layer = resolveLayer(e, ctx);
    const color = resolveColor(e, ctx, layer);
    const base = { layer, color, entityType: e.type, handle: e.handle, ...(ctx.block ? { block: ctx.block } : {}) };
    const m = mul(ctx.m, ocs(e));

    switch (e.type) {
      case 'LINE': {
        features.push({
          ...base,
          kind: 'line',
          coords: [apply(m, e.startPoint.x, e.startPoint.y), apply(m, e.endPoint.x, e.endPoint.y)],
        });
        return;
      }
      case 'LWPOLYLINE': {
        const verts = e.vertices ?? [];
        if (!verts.length) return;
        const closed = Boolean((e.flag ?? 0) & 1) || Boolean((e.flag ?? 0) & 512);
        const pts = polylineWithBulges(verts, closed).map(([x, y]) => apply(m, x, y));
        features.push({ ...base, kind: 'line', coords: pts });
        return;
      }
      case 'POLYLINE2D':
      case 'POLYLINE3D': {
        const verts = (e.vertices ?? []).filter((v: Ent) => !((v.flag ?? 0) & 16)); // drop spline frame points
        if (!verts.length) return;
        const closed = Boolean((e.flag ?? 0) & 1);
        if (e.type === 'POLYLINE3D') {
          const coords = verts.map((v: Ent) => apply(ctx.m, v.x, v.y));
          const z = verts.map((v: Ent) => v.z ?? 0);
          if (closed && coords.length > 2) {
            coords.push(coords[0]);
            z.push(z[0]);
          }
          features.push({ ...base, kind: 'line', coords, z });
        } else {
          const pts = polylineWithBulges(verts, closed).map(([x, y]) => apply(m, x, y));
          features.push({ ...base, kind: 'line', coords: pts });
        }
        return;
      }
      case 'ARC': {
        let sweep = e.endAngle - e.startAngle;
        while (sweep <= 0) sweep += 2 * Math.PI;
        const pts = arcPoints(e.center.x, e.center.y, e.radius, e.startAngle, sweep).map(([x, y]) => apply(m, x, y));
        features.push({ ...base, kind: 'line', coords: pts });
        return;
      }
      case 'CIRCLE': {
        const pts = arcPoints(e.center.x, e.center.y, e.radius, 0, 2 * Math.PI).map(([x, y]) => apply(m, x, y));
        features.push({ ...base, kind: 'line', coords: pts });
        return;
      }
      case 'ELLIPSE': {
        const M = e.majorAxisEndPoint;
        const ratio = e.axisRatio ?? 1;
        let sweep = (e.endAngle ?? 2 * Math.PI) - (e.startAngle ?? 0);
        while (sweep <= 0) sweep += 2 * Math.PI;
        const n = segmentsFor(Math.hypot(M.x, M.y), sweep);
        const pts: XY[] = [];
        for (let i = 0; i <= n; i++) {
          const t = (e.startAngle ?? 0) + (sweep * i) / n;
          const x = e.center.x + M.x * Math.cos(t) - ratio * M.y * Math.sin(t);
          const y = e.center.y + M.y * Math.cos(t) + ratio * M.x * Math.sin(t);
          pts.push(apply(ctx.m, x, y));
        }
        features.push({ ...base, kind: 'line', coords: pts });
        return;
      }
      case 'SPLINE': {
        const closed = Boolean((e.flag ?? 0) & 1);
        const ctrl: XY[] = (e.controlPoints ?? []).map((p: Ent) => [p.x, p.y]);
        const fit: XY[] = (e.fitPoints ?? []).map((p: Ent) => [p.x, p.y]);
        let pts: XY[] = [];
        if (ctrl.length >= 2 && (e.knots ?? []).length) pts = nurbsPoints(e.degree ?? 3, e.knots, ctrl, e.weights);
        else if (fit.length >= 2) pts = fitPointCurve(fit, closed);
        else if (ctrl.length >= 2) pts = ctrl;
        if (pts.length < 2) return skip('SPLINE (empty)');
        features.push({ ...base, kind: 'line', coords: pts.map(([x, y]) => apply(ctx.m, x, y)) });
        return;
      }
      case 'POINT': {
        features.push({ ...base, kind: 'point', coord: apply(m, e.position.x, e.position.y) });
        return;
      }
      case 'TEXT': {
        const p = textFromBase(e);
        emitText(base, m, p.x, p.y, cleanText(e.text ?? ''), e.textHeight ?? 1, e.rotation ?? 0, p.h, p.v);
        return;
      }
      case 'MTEXT': {
        const [h, v] = MTEXT_ALIGN[(e.attachmentPoint ?? 1) - 1] ?? MTEXT_ALIGN[0];
        const dir = e.direction;
        const rot = dir && (dir.x || dir.y) ? Math.atan2(dir.y, dir.x) : (e.rotation ?? 0);
        const ip = e.insertionPoint;
        emitText(base, m, ip.x, ip.y, cleanText(cleanMText(e.text ?? '')), e.textHeight ?? 1, rot, h, v);
        return;
      }
      case 'HATCH': {
        const rings: XY[][] = [];
        for (const path of e.boundaryPaths ?? []) {
          let ring: XY[] = [];
          if (path.vertices) {
            ring = polylineWithBulges(path.vertices, true);
          } else if (path.edges) {
            for (const edge of path.edges) {
              let pts: XY[] = [];
              if (edge.type === 1) pts = [[edge.start.x, edge.start.y], [edge.end.x, edge.end.y]];
              else if (edge.type === 2) {
                // Clockwise hatch arcs store negated angles.
                const ccw = edge.isCCW !== false;
                const start = ccw ? edge.startAngle : -edge.startAngle;
                const end = ccw ? edge.endAngle : -edge.endAngle;
                let sweep = end - start;
                if (ccw) while (sweep <= 0) sweep += 2 * Math.PI;
                else while (sweep >= 0) sweep -= 2 * Math.PI;
                pts = arcPoints(edge.center.x, edge.center.y, edge.radius, start, sweep);
              } else if (edge.controlPoints) pts = edge.controlPoints.map((p: Ent) => [p.x, p.y]);
              if (ring.length) pts.shift();
              ring.push(...pts);
            }
          }
          if (ring.length >= 3) rings.push(ring.map(([x, y]) => apply(m, x, y)));
        }
        if (!rings.length) return skip('HATCH (no boundary)');
        features.push({ ...base, kind: 'polygon', rings });
        return;
      }
      case 'INSERT': {
        if (ctx.depth >= MAX_BLOCK_DEPTH) {
          warnings.push(`Block nesting deeper than ${MAX_BLOCK_DEPTH} levels was not expanded (${e.name}).`);
          return;
        }
        const blk = blocks.get(e.name);
        const cols = Math.max(1, e.columnCount ?? 1);
        const rows = Math.max(1, e.rowCount ?? 1);
        let drewSomething = false;
        if (blk) {
          const before = features.length;
          for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
              const local = mul(
                translate(e.insertionPoint.x, e.insertionPoint.y),
                mul(
                  rotate(e.rotation ?? 0),
                  mul(
                    translate(c * (e.columnSpacing ?? 0), r * (e.rowSpacing ?? 0)),
                    mul(scale(e.xScale ?? 1, e.yScale ?? 1), translate(-blk.basePoint.x, -blk.basePoint.y)),
                  ),
                ),
              );
              const child: Ctx = {
                m: mul(m, local),
                insertLayer: layer,
                blockColor: color,
                block: ctx.block ?? e.name,
                depth: ctx.depth + 1,
              };
              for (const be of blk.entities) {
                if (be.type === 'ATTDEF') continue;
                visit(be, child);
              }
            }
          }
          drewSomething = features.length > before;
        }
        if (!drewSomething) {
          features.push({ ...base, kind: 'point', block: e.name, coord: apply(m, e.insertionPoint.x, e.insertionPoint.y) });
        }
        // Attributes are stored already placed in the insert's coordinate space.
        for (const at of e.attribs ?? []) {
          if ((at.flags ?? 0) & 1 || !at.text) continue; // invisible
          const t = at.text as Ent;
          const p = textFromBase(t);
          const atLayer = resolveLayer(at as Ent, ctx);
          emitText(
            { ...base, layer: atLayer, color: resolveColor(at as Ent, ctx, atLayer), entityType: 'ATTRIB', block: e.name },
            mul(ctx.m, ocs(at as Ent)),
            p.x,
            p.y,
            cleanText(t.text ?? ''),
            t.textHeight ?? 1,
            t.rotation ?? 0,
            p.h,
            p.v,
          );
        }
        return;
      }
      case 'SOLID':
      case 'TRACE':
      case '3DFACE': {
        // SOLID/TRACE corners run 1-2-4-3 around the outline; 3DFACE runs 1-2-3-4.
        const c = [e.corner1, e.corner2, e.corner3, e.corner4 ?? e.corner3];
        const order = e.type === '3DFACE' ? [0, 1, 2, 3] : [0, 1, 3, 2];
        const ring = order.map((i) => apply(e.type === '3DFACE' ? ctx.m : m, c[i].x, c[i].y));
        features.push({ ...base, kind: 'polygon', rings: [[...ring, ring[0]]] });
        return;
      }
      case 'DIMENSION': {
        // Dimensions are drawn from their anonymous "*D" block, already in world coordinates.
        const blk = e.name ? blocks.get(e.name) : undefined;
        if (!blk) return skip(e.type);
        const child: Ctx = { m: ctx.m, insertLayer: layer, blockColor: color, block: ctx.block, depth: ctx.depth + 1 };
        for (const be of blk.entities) visit(be, child);
        return;
      }
      // Attribute definitions are templates; attributes are drawn with their INSERT. Infinite lines are not drawn.
      case 'ATTDEF':
      case 'ATTRIB':
      case 'XLINE':
      case 'RAY':
      case 'VIEWPORT':
        return;
      default:
        skip(e.type);
    }
  }

  for (const e of (db.entities ?? []) as Ent[]) {
    if (e.isInPaperSpace) continue;
    const owner = e.ownerBlockRecordSoftId;
    if (owner && paperSpaceHandles.has(owner)) continue;
    try {
      visit(e, { m: IDENTITY, depth: 0 });
    } catch (err) {
      skip(`${e.type} (error)`);
      if (warnings.length < 20) warnings.push(`Could not convert ${e.type} ${e.handle}: ${(err as Error).message}`);
    }
  }

  // Layers: everything in the layer table plus any referenced-but-undeclared names.
  const counts = new Map<string, number>();
  for (const f of features) counts.set(f.layer, (counts.get(f.layer) ?? 0) + 1);
  const layerNames = new Set<string>([...layerColor.keys(), ...counts.keys()]);
  const layers: CadLayer[] = [...layerNames]
    .map((name) => ({
      name,
      color: layerColor.get(name) ?? '#ffffff',
      hiddenInDrawing: layerHidden.get(name) ?? false,
      featureCount: counts.get(name) ?? 0,
    }))
    .filter((l) => l.featureCount > 0)
    .sort((a, b) => a.name.localeCompare(b.name));

  const extent = computeExtent(features);
  const focusExtent = computeFocusExtent(features) ?? extent;
  const insUnits = (db.header as Record<string, unknown> | undefined)?.INSUNITS as number | undefined;
  if (insUnits !== undefined && insUnits !== 0 && insUnits !== 6) {
    warnings.push(`Drawing units are not metres (INSUNITS=${insUnits}). Coordinates are used as-is.`);
  }
  if (extent && focusExtent && (extent[2] - extent[0] > 5 * (focusExtent[2] - focusExtent[0] + 1) || extent[3] - extent[1] > 5 * (focusExtent[3] - focusExtent[1] + 1))) {
    warnings.push('Some objects are far from the rest of the drawing (stray objects?). The map zooms to the main cluster.');
  }
  return { fileName, layers, features, extent, focusExtent, skipped, warnings, insUnits };
}

export function computeExtent(features: CadFeature[]): CadDrawing['extent'] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = ([x, y]: XY) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  for (const f of features) {
    if (f.kind === 'line') f.coords.forEach(add);
    else if (f.kind === 'polygon') f.rings.forEach((r) => r.forEach(add));
    else add(f.coord);
  }
  return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : null;
}

/**
 * Extent of the main cluster of features: drops features whose centre lies far outside the
 * interquartile range of all feature centres, then takes the extent of what's left.
 */
export function computeFocusExtent(features: CadFeature[]): CadDrawing['extent'] {
  if (features.length < 10) return null;
  const centres: XY[] = [];
  for (const f of features) {
    const e = computeExtent([f]);
    if (e) centres.push([(e[0] + e[2]) / 2, (e[1] + e[3]) / 2]);
  }
  const quantile = (vals: number[], q: number) => vals[Math.min(vals.length - 1, Math.max(0, Math.floor(q * (vals.length - 1))))];
  const xs = centres.map((c) => c[0]).sort((a, b) => a - b);
  const ys = centres.map((c) => c[1]).sort((a, b) => a - b);
  const [x1, x3, y1, y3] = [quantile(xs, 0.25), quantile(xs, 0.75), quantile(ys, 0.25), quantile(ys, 0.75)];
  // Generous fence (5x IQR, at least 50 m) so only genuine outliers are dropped.
  const fx = Math.max(5 * (x3 - x1), 50);
  const fy = Math.max(5 * (y3 - y1), 50);
  const kept = features.filter((f) => {
    const e = computeExtent([f]);
    if (!e) return false;
    const cx = (e[0] + e[2]) / 2;
    const cy = (e[1] + e[3]) / 2;
    return cx >= x1 - fx && cx <= x3 + fx && cy >= y1 - fy && cy <= y3 + fy;
  });
  return computeExtent(kept);
}
