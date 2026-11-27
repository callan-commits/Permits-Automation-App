/**
 * Reader for 12d Model ASCII files: .12da, and .12daz (a .12da inside a zip).
 *
 * The file is streamed: unzipped and decoded (12d writes UTF-16 or UTF-8) a chunk at a time and parsed
 * line by line, so very large exports (hundreds of MB unzipped) never sit in memory as one string.
 *
 * What becomes what:
 *  - each 12d model is a layer (its full name, e.g. "EFU Existing Utility/VIDA/Elec/UT Elec UG QL B");
 *  - super strings and 3d strings are lines, with a level (RL) per vertex. A string with one vertex is a
 *    point. Closed strings are closed. Arcs (radius_data) are drawn as arcs; a positive radius means the
 *    centre is to the right of the direction of travel (a clockwise arc);
 *  - circles (pits) are drawn as round outlines at their level;
 *  - each string's own attributes (including those in groups) become its object data, so OWNER /
 *    TYPE / QUALITY_LEVEL work like DWG object data. VicTrack's "VT_UTL_…" fields are also made
 *    available without the prefix (VT_UTL_OWNER → OWNER). Per-vertex survey attributes are skipped.
 * Levels written as "null" (or the file's null value, e.g. -999) are treated as missing.
 */
import { Unzip, UnzipInflate } from 'fflate';
import { aciToHex } from './aci';
import { computeExtent, computeFocusExtent } from './convert';
import type { CadDrawing, CadFeature, CadLayer, XY } from './types';

export function is12dFile(fileName: string): boolean {
  return /\.12daz?$/i.test(fileName);
}

/** Parse a .12da / .12daz file. `stage` receives progress messages. */
export function parse12d(bytes: Uint8Array, fileName: string, stage: (text: string) => void = () => {}): CadDrawing {
  const parser = new TwelveDParser();
  const decoder = new StreamDecoder((text) => parser.feed(text));
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  const mb = (bytes.byteLength / 1e6).toFixed(1);
  let lastReport = 0;
  const report = (done: number) => {
    const pct = Math.floor((done / bytes.byteLength) * 100);
    if (pct >= lastReport + 5 || pct === 100) {
      lastReport = pct;
      stage(`Reading ${fileName} (${mb} MB): ${pct}%…`);
    }
  };

  if (isZip) {
    let found = false;
    const unzip = new Unzip((file) => {
      if (found || !/\.12da$/i.test(file.name)) return;
      found = true;
      file.ondata = (err, chunk, final) => {
        if (err) throw err;
        decoder.push(chunk, final);
      };
      file.start();
    });
    unzip.register(UnzipInflate);
    const STEP = 1 << 20;
    for (let i = 0; i < bytes.byteLength; i += STEP) {
      unzip.push(bytes.subarray(i, Math.min(i + STEP, bytes.byteLength)), i + STEP >= bytes.byteLength);
      report(Math.min(i + STEP, bytes.byteLength));
    }
    if (!found) throw new Error(`${fileName} is a zip file but does not contain a .12da file.`);
  } else {
    const STEP = 4 << 20;
    for (let i = 0; i < bytes.byteLength; i += STEP) {
      decoder.push(bytes.subarray(i, Math.min(i + STEP, bytes.byteLength)), i + STEP >= bytes.byteLength);
      report(Math.min(i + STEP, bytes.byteLength));
    }
  }
  if (!decoder.started) throw new Error(`${fileName} is empty.`);
  stage('Building map objects…');
  return parser.finish(fileName);
}

// ---------- decoding ----------

/** Detects the text encoding from the first bytes (BOM, or zero bytes for BOM-less UTF-16). */
class StreamDecoder {
  private decoder: TextDecoder | null = null;
  started = false;

  constructor(private sink: (text: string) => void) {}

  push(chunk: Uint8Array, final: boolean): void {
    if (!this.decoder) {
      if (!chunk.byteLength && !final) return;
      this.started = chunk.byteLength > 0;
      this.decoder = new TextDecoder(detectEncoding(chunk));
    }
    const text = this.decoder.decode(chunk, { stream: !final });
    if (text) this.sink(text);
    if (final) this.sink('\n');
  }
}

export function detectEncoding(head: Uint8Array): string {
  if (head[0] === 0xff && head[1] === 0xfe) return 'utf-16le';
  if (head[0] === 0xfe && head[1] === 0xff) return 'utf-16be';
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return 'utf-8';
  // UTF-16 without a byte-order mark: every other byte of ASCII text is zero.
  if (head.length >= 4 && head[1] === 0 && head[3] === 0 && head[0] !== 0) return 'utf-16le';
  if (head.length >= 4 && head[0] === 0 && head[2] === 0 && head[1] !== 0) return 'utf-16be';
  return 'utf-8';
}

// ---------- parsing ----------

interface StringRec {
  kind: string;
  model: string;
  name: string;
  colour: string;
  closed: boolean;
  attrs: Record<string, string>;
  pts: number[]; // x, y, x, y…
  zs: number[];
  constZ: number;
  radii: number[];
  major: boolean[];
  circle: { x: number; y: number; z: number; r: number } | null;
}

type Ctx =
  | { k: 'root' }
  | { k: 'string'; s: StringRec }
  | { k: 'attrs'; target: Record<string, string> }
  | { k: 'group'; target: Record<string, string> }
  | { k: 'coords'; s: StringRec; dims: 2 | 3 }
  | { k: 'radius'; s: StringRec }
  | { k: 'major'; s: StringRec }
  | { k: 'skip'; depth: number };

const TYPE_COLOURS: Record<string, string> = {
  ELEC: '#ff3b30',
  COMMS: '#ff9500',
  GAS: '#ffd60a',
  WATER: '#0a84ff',
  SEWER: '#a2845e',
  DRAIN: '#30d158',
  FUEL: '#ff6ad5',
  RAIL: '#bf5af2',
};

const NAMED_COLOURS: Record<string, string> = {
  red: '#ff0000',
  green: '#00ff00',
  blue: '#0000ff',
  yellow: '#ffff00',
  cyan: '#00ffff',
  magenta: '#ff00ff',
  white: '#ffffff',
  black: '#000000',
  orange: '#ff8000',
  purple: '#a020f0',
  brown: '#a0522d',
  grey: '#808080',
  gray: '#808080',
  pink: '#ffc0cb',
};

class TwelveDParser {
  private buf = '';
  private stack: Ctx[] = [{ k: 'root' }];
  private model = '';
  private nullValue = -999;
  private features: CadFeature[] = [];
  private skipped: Record<string, number> = {};
  private datums = new Map<string, number>();
  private count = 0;

  feed(text: string): void {
    const data = this.buf + text;
    let start = 0;
    for (;;) {
      const nl = data.indexOf('\n', start);
      if (nl < 0) break;
      this.line(data.slice(start, nl));
      start = nl + 1;
    }
    this.buf = data.slice(start);
  }

  private line(raw: string): void {
    const line = raw.trim();
    if (!line) return;
    // Usually a brace ends a line ("group {") or stands alone ("}"), but some blocks are written on one
    // line or close after a value ('data "x.bmp"  }'): split those into separate logical lines.
    if (line.indexOf('{') < 0 && line.indexOf('}') < 0) this.logical(line);
    else if (line === '}' || (line.endsWith('{') && line.indexOf('{') === line.length - 1 && line.indexOf('}') < 0)) this.logical(line);
    else for (const part of splitBraces(line)) this.logical(part);
  }

  private logical(line: string): void {
    const ctx = this.stack[this.stack.length - 1];

    // Fast path for the bulk of a large file: blocks we don't read (per-vertex survey data etc.).
    if (ctx.k === 'skip') {
      if (line.endsWith('{')) ctx.depth++;
      else if (line === '}' && --ctx.depth === 0) this.stack.pop();
      return;
    }
    if (line === '}') {
      this.close();
      return;
    }
    if (ctx.k === 'coords') {
      const p = line.split(/\s+/);
      const x = num(p[0]);
      const y = num(p[1]);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        ctx.s.pts.push(x, y);
        ctx.s.zs.push(ctx.dims === 3 ? this.level(p[2]) : NaN);
      }
      return;
    }
    if (ctx.k === 'radius') {
      for (const v of line.split(/\s+/)) ctx.s.radii.push(num(v) || 0);
      return;
    }
    if (ctx.k === 'major') {
      for (const v of line.split(/\s+/)) ctx.s.major.push(v === 't' || v === '1' || v === 'true');
      return;
    }
    if (line.startsWith('//')) {
      const m = /^\/\/\s*null\s+(\S+)/.exec(line);
      if (m && Number.isFinite(Number(m[1]))) this.nullValue = Number(m[1]);
      return;
    }

    const opens = line.endsWith('{');
    const tok = tokens(opens ? line.slice(0, -1) : line);
    const key = tok[0] ?? '';

    switch (ctx.k) {
      case 'root':
        if (key === 'model' && !opens) this.model = tok[1] ?? '';
        else if (key === 'string' && opens) this.stack.push({ k: 'string', s: this.newString(tok[1] ?? '') });
        else if (opens) {
          this.skipped[`12d ${key}`] = (this.skipped[`12d ${key}`] ?? 0) + 1;
          this.stack.push({ k: 'skip', depth: 1 });
        }
        return;
      case 'string': {
        const s = ctx.s;
        if (opens) {
          if (key === 'attributes') this.stack.push({ k: 'attrs', target: s.attrs });
          else if (key === 'data_3d' || key === 'data') this.stack.push({ k: 'coords', s, dims: 3 });
          else if (key === 'data_2d') this.stack.push({ k: 'coords', s, dims: 2 });
          else if (key === 'radius_data') this.stack.push({ k: 'radius', s });
          else if (key === 'major_data') this.stack.push({ k: 'major', s });
          else this.stack.push({ k: 'skip', depth: 1 });
          return;
        }
        if (key === 'name') s.name = tok[1] ?? '';
        else if (key === 'colour') s.colour = tok.slice(1).join(' ');
        else if (key === 'closed') s.closed = tok[1] === '1' || tok[1] === 'true';
        else if (key === 'z') s.constZ = this.level(tok[1]);
        else if (key === 'radius') (s.circle ??= { x: NaN, y: NaN, z: NaN, r: 0 }).r = num(tok[1]);
        else if (key === 'xcentre') {
          const c = (s.circle ??= { x: NaN, y: NaN, z: NaN, r: 0 });
          for (let i = 0; i + 1 < tok.length; i += 2) {
            if (tok[i] === 'xcentre') c.x = num(tok[i + 1]);
            else if (tok[i] === 'ycentre') c.y = num(tok[i + 1]);
            else if (tok[i] === 'zcentre') c.z = this.level(tok[i + 1]);
          }
        }
        return;
      }
      case 'attrs':
        if (opens) {
          if (key === 'group') this.stack.push({ k: 'group', target: ctx.target });
          else this.stack.push({ k: 'skip', depth: 1 });
          return;
        }
        // e.g.  text "OWNER" "VicTrack"   |   real "DIA_EXT_M" 0.063   |   integer "string_no" 1
        if (tok.length >= 3) setAttr(ctx.target, tok[1], tok[2] === 'null' ? '' : tok[2]);
        return;
      case 'group':
        if (opens) {
          if (key === 'attributes') this.stack.push({ k: 'attrs', target: ctx.target });
          else this.stack.push({ k: 'skip', depth: 1 });
        }
        return;
    }
  }

  private level(v: string | undefined): number {
    const n = num(v);
    return Number.isFinite(n) && n !== this.nullValue ? n : NaN;
  }

  private newString(kind: string): StringRec {
    return { kind, model: this.model, name: '', colour: '', closed: false, attrs: {}, pts: [], zs: [], constZ: NaN, radii: [], major: [], circle: null };
  }

  private close(): void {
    const ctx = this.stack.pop();
    if (!ctx || ctx.k === 'root') {
      this.stack = [{ k: 'root' }];
      return;
    }
    if (ctx.k === 'string') this.emit(ctx.s);
  }

  private emit(s: StringRec): void {
    const handle = `12d-${++this.count}`;
    const attributes: Record<string, string> = {};
    if (s.name) attributes['12d string'] = s.name;
    for (const [k, v] of Object.entries(s.attrs)) attributes[k] = v;
    // VicTrack utility fields: also make them available without the prefix (VT_UTL_OWNER → OWNER).
    for (const [k, v] of Object.entries(s.attrs)) {
      const m = /^VT_UTL_(.+)$/i.exec(k);
      if (m && v.trim() && !attributes[m[1]]?.trim()) attributes[m[1]] = v;
    }
    const datum = attributes.HORZ_DATUM?.trim();
    if (datum) this.datums.set(datum, (this.datums.get(datum) ?? 0) + 1);
    const base = { layer: s.model || '12d', color: this.colour(s), entityType: `12D_${s.kind.toUpperCase()}`, handle, meta: { attributes } };

    if (s.kind === 'circle' && s.circle && Number.isFinite(s.circle.x) && Number.isFinite(s.circle.y) && s.circle.r) {
      const { x, y, z } = s.circle;
      const r = Math.abs(s.circle.r); // the sign only gives the direction
      const n = 48;
      const coords: XY[] = [];
      for (let i = 0; i <= n; i++) coords.push([x + r * Math.cos((i / n) * 2 * Math.PI), y + r * Math.sin((i / n) * 2 * Math.PI)]);
      this.features.push({ ...base, kind: 'line', coords, z: coords.map(() => z), meta: { attributes, elevation: Number.isFinite(z) ? z : undefined } });
      return;
    }
    const n = s.pts.length / 2;
    if (n === 0) {
      this.skipped[`12d ${s.kind} (no points)`] = (this.skipped[`12d ${s.kind} (no points)`] ?? 0) + 1;
      return;
    }
    const zAt = (i: number) => (Number.isFinite(s.zs[i]) ? s.zs[i] : s.constZ);
    if (n === 1) {
      const z = zAt(0);
      this.features.push({ ...base, kind: 'point', coord: [s.pts[0], s.pts[1]], meta: { attributes, elevation: Number.isFinite(z) ? z : undefined } });
      return;
    }
    const coords: XY[] = [];
    const z: number[] = [];
    const segs = s.closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % n;
      const a: XY = [s.pts[2 * i], s.pts[2 * i + 1]];
      const b: XY = [s.pts[2 * j], s.pts[2 * j + 1]];
      const za = zAt(i);
      const zb = zAt(j);
      coords.push(a);
      z.push(za);
      const r = s.radii[i] ?? 0;
      if (r) {
        const arc = arcBetween(a, b, r, s.major[i] ?? false);
        arc.forEach(([p, t]) => {
          coords.push(p);
          z.push(za + t * (zb - za));
        });
      }
    }
    const last = s.closed ? 0 : n - 1;
    coords.push([s.pts[2 * last], s.pts[2 * last + 1]]);
    z.push(zAt(last));
    this.features.push({ ...base, kind: 'line', coords, z: z.some((v) => Number.isFinite(v)) ? z : undefined });
  }

  private colour(s: StringRec): string {
    const name = s.colour.toLowerCase();
    const aci = /^acad\s+(\d+)$/.exec(name);
    if (aci) return aciToHex(Number(aci[1]));
    if (NAMED_COLOURS[name]) return NAMED_COLOURS[name];
    if (name.includes('steel blue')) return '#4682b4';
    if (name.includes('water')) return '#3b82f6';
    if (name.includes('communication')) return TYPE_COLOURS.COMMS;
    // Project-specific colour names: colour by the service type instead.
    const type = `${s.attrs.TYPE ?? ''} ${s.attrs.VT_UTL_TYPE ?? ''} ${s.model}`.toUpperCase();
    for (const [k, c] of Object.entries(TYPE_COLOURS)) if (type.includes(k)) return c;
    return '#c7c7cc';
  }

  finish(fileName: string): CadDrawing {
    if (this.buf.trim()) this.line(this.buf);
    const features = this.features;
    const byLayer = new Map<string, { count: number; colours: Map<string, number> }>();
    for (const f of features) {
      const l = byLayer.get(f.layer) ?? { count: 0, colours: new Map() };
      l.count++;
      l.colours.set(f.color, (l.colours.get(f.color) ?? 0) + 1);
      byLayer.set(f.layer, l);
    }
    const layers: CadLayer[] = [...byLayer.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, l]) => ({ name, featureCount: l.count, hiddenInDrawing: false, color: [...l.colours.entries()].sort((a, b) => b[1] - a[1])[0][0] }));
    const warnings: string[] = [];
    const other = [...this.datums.keys()].filter((d) => !/MGA\s*2020.*55|GDA\s*2020.*55|7855/i.test(d));
    if (other.length) warnings.push(`Some strings say they use another grid (${other.slice(0, 3).join(', ')}). The app reads everything as MGA2020 Zone 55.`);
    if (!features.length) warnings.push('No strings with coordinates were found in this 12d file.');
    const extent = computeExtent(features);
    return { fileName, layers, features, extent, focusExtent: computeFocusExtent(features) ?? extent, skipped: this.skipped, warnings };
  }
}

/** Split a line at braces that aren't inside quotes: 'a { b }' → ['a {', 'b', '}']. */
export function splitBraces(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      cur += ch;
      if (ch === '\\' && i + 1 < line.length) cur += line[++i];
      else if (ch === '"') quoted = false;
    } else if (ch === '"') {
      quoted = true;
      cur += ch;
    } else if (ch === '{') {
      out.push(`${cur.trim()} {`.trim());
      cur = '';
    } else if (ch === '}') {
      if (cur.trim()) out.push(cur.trim());
      out.push('}');
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function setAttr(target: Record<string, string>, key: string, value: string): void {
  // The same field can appear in several groups: keep the first value that isn't empty.
  if (target[key] === undefined || (!target[key].trim() && value.trim())) target[key] = value;
}

function num(v: string | undefined): number {
  if (v === undefined || v === 'null') return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

/** Split a line into words and quoted strings ("a \"b\" c" style escapes). */
export function tokens(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  const n = line.length;
  while (i < n) {
    const ch = line[i];
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i++;
    } else if (ch === '"') {
      let s = '';
      i++;
      while (i < n && line[i] !== '"') {
        if (line[i] === '\\' && i + 1 < n) i++;
        s += line[i++];
      }
      i++;
      out.push(s);
    } else {
      let j = i;
      while (j < n && line[j] !== ' ' && line[j] !== '\t' && line[j] !== '\r') j++;
      out.push(line.slice(i, j));
      i = j;
    }
  }
  return out;
}

/**
 * Points strictly between a and b on a 12d arc of the given signed radius (positive: centre to the
 * right of a→b, i.e. clockwise), with the fraction of the way along for each. `major` picks the
 * longer of the two possible arcs.
 */
export function arcBetween(a: XY, b: XY, radius: number, major: boolean): [XY, number][] {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const L = Math.hypot(dx, dy);
  if (L === 0) return [];
  const R = Math.max(Math.abs(radius), L / 2);
  const h = Math.sqrt(Math.max(0, R * R - (L / 2) ** 2));
  const side = radius > 0 ? 1 : -1; // +1: centre on the right
  const rx = dy / L;
  const ry = -dx / L; // right-hand normal
  const off = (major ? -h : h) * side;
  const cx = (a[0] + b[0]) / 2 + rx * off;
  const cy = (a[1] + b[1]) / 2 + ry * off;
  const a0 = Math.atan2(a[1] - cy, a[0] - cx);
  let sweep = Math.atan2(b[1] - cy, b[0] - cx) - a0;
  if (side > 0) while (sweep > 0) sweep -= 2 * Math.PI;
  else while (sweep < 0) sweep += 2 * Math.PI;
  // Chord error under ~1 cm, at most 64 pieces.
  const step = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - 0.01 / R)));
  const pieces = Math.min(64, Math.max(2, Math.ceil(Math.abs(sweep) / (step || 0.1))));
  const out: [XY, number][] = [];
  for (let k = 1; k < pieces; k++) {
    const t = k / pieces;
    out.push([[cx + R * Math.cos(a0 + sweep * t), cy + R * Math.sin(a0 + sweep * t)], t]);
  }
  return out;
}
