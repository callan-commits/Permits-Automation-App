/**
 * Service register: what each utility is (type), who owns it and whether it is overhead.
 *
 * Each field is resolved in this order, first answer wins:
 *   1. the user's edit for that object   (phase 3, schedule)
 *   2. data attached to the object        (block attributes, XDATA fields, records)
 *   3. the user's edit for the layer      (service register table)
 *   4. a guess from the layer name        (e.g. GAS-MULTINET -> Gas, Multinet Gas)
 * Anything still unknown is reported as null so the UI can highlight it.
 */
import type { CadDrawing, CadFeature, CadMeta } from '../cad/types';
import {
  DESCRIPTION_FIELDS,
  OVERHEAD_KEYWORDS,
  OWNER_FIELDS,
  OWNERS,
  type OwnerEntry,
  QL_FIELDS,
  SERVICE_TYPES,
  TYPE_FIELDS,
} from './dictionary';

export type InfoSource = 'edit' | 'data' | 'layer-edit' | 'layer-name' | 'owner' | 'none';

export interface ServiceInfo {
  type: string | null;
  owner: string | null;
  overhead: boolean;
  /** AS 5488 quality level letter (A-D), if known. */
  ql: string | null;
  /** Size / material / description from the object's data, if any. */
  description: string | null;
  source: { type: InfoSource; owner: InfoSource; overhead: InfoSource; ql: InfoSource };
}

export interface LayerSetting {
  type?: string;
  owner?: string;
  overhead?: boolean;
  /** True when the user says this layer is not a service (survey points, fences, contours...). */
  ignore?: boolean;
}

// ---------- text matching ----------

/** Upper-case words of a name, splitting on punctuation, underscores and camelCase. */
export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toUpperCase()
    .replace(/O\/H/g, ' OH ')
    .replace(/V\/LINE/g, ' VLINE ')
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
}

/** True if `phrase` (one or more words) appears as whole words in `tokens`. */
function hasPhrase(tokens: string[], phrase: string): boolean {
  const words = tokenize(phrase);
  if (!words.length) return false;
  outer: for (let i = 0; i + words.length <= tokens.length; i++) {
    for (let j = 0; j < words.length; j++) if (tokens[i + j] !== words[j]) continue outer;
    return true;
  }
  return false;
}

/** Known owner named in a piece of text (layer name or data value), longest alias first. */
export function findOwner(text: string): OwnerEntry | null {
  const tokens = tokenize(text);
  let best: { entry: OwnerEntry; len: number } | null = null;
  for (const entry of OWNERS) {
    for (const alias of [entry.name, ...entry.aliases]) {
      const len = tokenize(alias).length;
      if ((!best || len > best.len) && hasPhrase(tokens, alias)) best = { entry, len };
    }
  }
  return best?.entry ?? null;
}

export function findType(text: string): string | null {
  const tokens = tokenize(text);
  for (const t of SERVICE_TYPES) if (t.keywords.some((k) => hasPhrase(tokens, k))) return t.name;
  return null;
}

/** Owner name as displayed: the known name if recognised, otherwise the text as given. */
// Matching a name against the dictionary is slow-ish and big surveys repeat the same few names
// thousands of times, so results are cached by the raw text.
const ownerCache = new Map<string, string>();
const typeCache = new Map<string, string>();
const CACHE_LIMIT = 20000;

export function normaliseOwner(raw: string): string {
  let v = ownerCache.get(raw);
  if (v === undefined) {
    const trimmed = raw.trim();
    v = findOwner(trimmed)?.name ?? trimmed;
    if (ownerCache.size < CACHE_LIMIT) ownerCache.set(raw, v);
  }
  return v;
}

export function normaliseType(raw: string): string {
  let v = typeCache.get(raw);
  if (v === undefined) {
    const trimmed = raw.trim();
    v = findType(trimmed) ?? trimmed;
    if (typeCache.size < CACHE_LIMIT) typeCache.set(raw, v);
  }
  return v;
}

/** Quality level letter from text such as "QL-B", "QLB", "B", "Quality Level B". */
export function parseQl(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const m = /(?:^|[^A-Z])QL[\s_-]*([A-D])(?![A-Z])/i.exec(raw) ?? /^\s*([A-D])\s*$/i.exec(raw) ?? /QUALITY\s*LEVEL\s*([A-D])\b/i.exec(raw);
  return m ? m[1].toUpperCase() : null;
}

export interface LayerGuess {
  type: string | null;
  owner: string | null;
  overhead: boolean;
  ql: string | null;
}

/** Remove the words of an owner's name/aliases, so e.g. "Melbourne Water Drain" isn't read as a water main. */
function withoutOwnerWords(tokens: string[], owner: OwnerEntry | null): string[] {
  if (!owner) return tokens;
  let out = tokens;
  for (const alias of [owner.name, ...owner.aliases].sort((a, b) => tokenize(b).length - tokenize(a).length)) {
    const words = tokenize(alias);
    const next: string[] = [];
    for (let i = 0; i < out.length; ) {
      if (words.length && words.every((w, j) => out[i + j] === w)) i += words.length;
      else next.push(out[i++]);
    }
    out = next;
  }
  return out;
}

const guessCache = new Map<string, LayerGuess>();

export function guessFromLayerName(layer: string): LayerGuess {
  const cached = guessCache.get(layer);
  if (cached) return cached;
  const guess = guessUncached(layer);
  guessCache.set(layer, guess);
  return guess;
}

function guessUncached(layer: string): LayerGuess {
  const owner = findOwner(layer);
  const tokens = tokenize(layer);
  return {
    owner: owner?.name ?? null,
    type: findType(withoutOwnerWords(tokens, owner).join(' ')) ?? owner?.impliesType ?? null,
    overhead: OVERHEAD_KEYWORDS.some((k) => hasPhrase(tokens, k)),
    ql: parseQl(layer.replace(/[^A-Za-z0-9]+/g, ' ')) ?? tokens.map((t) => /^QL([A-D])$/.exec(t)?.[1]).find(Boolean) ?? null,
  };
}

// ---------- object data ----------

// Field names repeat across every object in a survey: cache their normalised form.
const fieldKeyCache = new Map<string, string>();
const fieldKey = (k: string) => {
  let v = fieldKeyCache.get(k);
  if (v === undefined) {
    v = k.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (fieldKeyCache.size < 20000) fieldKeyCache.set(k, v);
  }
  return v;
};

/** Values surveys use for "not known": treated as no value, so the field is flagged for input. */
export function isPlaceholder(v: string): boolean {
  return /^\s*(unknown|unk|unidentified|unclassified|na|n\/a|n\.a\.|none|nil|null|tbc|tba|tbd|-+|\?+)\s*$/i.test(v);
}

/** First non-empty value among the object's attributes / data fields with one of these names. */
const nameSets = new WeakMap<string[], Set<string>>();

export function dataValue(meta: CadMeta | undefined, names: string[]): string | null {
  if (!meta) return null;
  let wanted = nameSets.get(names);
  if (!wanted) nameSets.set(names, (wanted = new Set(names)));
  // Plain loops: 12d strings can carry 80+ attributes, and this runs for every object.
  for (const source of [meta.attributes, meta.fields]) {
    if (!source) continue;
    for (const k in source) {
      if (!wanted.has(fieldKey(k))) continue;
      const v = source[k];
      if (v && v.trim() && !isPlaceholder(v)) return v.trim();
    }
  }
  return null;
}

export interface DataInfo {
  owner: string | null;
  type: string | null;
  ql: string | null;
  description: string | null;
}

const DESCRIPTION_SET = new Set(DESCRIPTION_FIELDS);

/** Owner, type, QL and description from an object's data. Cached per object (survey data doesn't change). */
const infoCache = new WeakMap<CadMeta, DataInfo>();
export function infoFromData(meta: CadMeta | undefined): DataInfo {
  if (!meta) return readInfo(undefined);
  let v = infoCache.get(meta);
  if (!v) infoCache.set(meta, (v = readInfo(meta)));
  return v;
}

function readInfo(meta: CadMeta | undefined): DataInfo {
  const owner = dataValue(meta, OWNER_FIELDS);
  const type = dataValue(meta, TYPE_FIELDS);
  const ql = parseQl(dataValue(meta, QL_FIELDS));
  const descParts: string[] = [];
  if (meta) {
    for (const source of [meta.attributes, meta.fields]) {
      if (!source) continue;
      for (const k in source) {
        if (!DESCRIPTION_SET.has(fieldKey(k))) continue;
        const v = source[k].trim();
        if (v && !descParts.includes(v)) descParts.push(v);
      }
    }
  }
  return {
    owner: owner ? normaliseOwner(owner) : null,
    type: type ? normaliseType(type) : null,
    ql,
    description: descParts.length ? descParts.join(' ') : null,
  };
}

// ---------- register ----------

const STORAGE_KEY = 'permits.serviceRegister.v1';

export interface LayerSummary {
  layer: string;
  featureCount: number;
  guess: LayerGuess;
  setting: LayerSetting;
  /** Owners / types found in object data on this layer, with object counts. */
  dataOwners: Map<string, number>;
  dataTypes: Map<string, number>;
  /** Resolved layer-level values (data only used when every object with data agrees). */
  type: string | null;
  owner: string | null;
  overhead: boolean;
  source: { type: InfoSource; owner: InfoSource; overhead: InfoSource };
  /** True when type or owner can't be determined for at least some objects (never for ignored layers). */
  incomplete: boolean;
  ignored: boolean;
}

export class ServiceRegister {
  private settings: Record<string, LayerSetting>;
  private listeners: (() => void)[] = [];

  constructor(private storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeLocalStorage()) {
    this.settings = {};
    try {
      const raw = this.storage?.getItem(STORAGE_KEY);
      if (raw) this.settings = JSON.parse(raw) ?? {};
    } catch {
      this.settings = {};
    }
  }

  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  layerSetting(layer: string): LayerSetting {
    return this.settings[layer] ?? {};
  }

  /** Update the user's setting for a layer. Empty strings / undefined clear that field. */
  setLayer(layer: string, patch: LayerSetting): void {
    const next: LayerSetting = { ...this.settings[layer], ...patch };
    for (const k of Object.keys(next) as (keyof LayerSetting)[]) {
      const v = next[k];
      if (v === undefined || v === '' || (k === 'ignore' && v === false)) delete next[k];
    }
    if (next.owner) next.owner = normaliseOwner(next.owner);
    if (Object.keys(next).length) this.settings[layer] = next;
    else delete this.settings[layer];
    this.save();
    this.listeners.forEach((fn) => fn());
  }

  resetLayer(layer: string): void {
    delete this.settings[layer];
    this.save();
    this.listeners.forEach((fn) => fn());
  }

  /** False when the user has marked the layer as not a service. */
  isService(layer: string): boolean {
    return !this.settings[layer]?.ignore;
  }

  isOverhead(layer: string): boolean {
    const s = this.settings[layer];
    return s?.overhead ?? guessFromLayerName(layer).overhead;
  }

  /** Resolve type / owner / overhead / QL for one object. */
  resolve(feature: CadFeature, edit?: { type?: string; owner?: string }): ServiceInfo {
    const data = infoFromData(feature.meta);
    const setting = this.settings[feature.layer] ?? {};
    const guess = guessFromLayerName(feature.layer);

    let owner: string | null = null;
    let ownerSrc: InfoSource = 'none';
    if (edit?.owner) [owner, ownerSrc] = [edit.owner, 'edit'];
    else if (data.owner) [owner, ownerSrc] = [data.owner, 'data'];
    else if (setting.owner) [owner, ownerSrc] = [setting.owner, 'layer-edit'];
    else if (guess.owner) [owner, ownerSrc] = [guess.owner, 'layer-name'];

    let type: string | null = null;
    let typeSrc: InfoSource = 'none';
    if (edit?.type) [type, typeSrc] = [edit.type, 'edit'];
    else if (data.type) [type, typeSrc] = [data.type, 'data'];
    else if (setting.type) [type, typeSrc] = [setting.type, 'layer-edit'];
    else if (guess.type) [type, typeSrc] = [guess.type, 'layer-name'];
    else if (owner) {
      const implied = findOwner(owner)?.impliesType;
      if (implied) [type, typeSrc] = [implied, 'owner'];
    }

    const overhead = setting.overhead ?? guess.overhead;
    const ql = data.ql ?? guess.ql;
    return {
      type,
      owner,
      overhead,
      ql,
      description: data.description,
      source: {
        type: typeSrc,
        owner: ownerSrc,
        overhead: setting.overhead !== undefined ? 'layer-edit' : guess.overhead ? 'layer-name' : 'none',
        ql: data.ql ? 'data' : guess.ql ? 'layer-name' : 'none',
      },
    };
  }

  /** One row per drawing layer, for the register table. */
  summarise(drawing: CadDrawing): LayerSummary[] {
    const byLayer = new Map<string, { count: number; owners: Map<string, number>; types: Map<string, number>; unresolved: boolean }>();
    for (const f of drawing.features) {
      if (f.kind === 'text' && !f.meta) continue; // plain labels aren't services
      let s = byLayer.get(f.layer);
      if (!s) byLayer.set(f.layer, (s = { count: 0, owners: new Map(), types: new Map(), unresolved: false }));
      s.count++;
      const d = infoFromData(f.meta);
      if (d.owner) s.owners.set(d.owner, (s.owners.get(d.owner) ?? 0) + 1);
      if (d.type) s.types.set(d.type, (s.types.get(d.type) ?? 0) + 1);
      const info = this.resolve(f);
      if (!info.owner || !info.type) s.unresolved = true;
    }
    const rows: LayerSummary[] = [];
    for (const layer of drawing.layers) {
      const s = byLayer.get(layer.name);
      if (!s) continue;
      const setting = this.settings[layer.name] ?? {};
      const guess = guessFromLayerName(layer.name);
      const single = (m: Map<string, number>) => (m.size === 1 ? [...m.keys()][0] : null);
      const dataOwner = single(s.owners);
      const dataType = single(s.types);
      const owner = setting.owner ?? dataOwner ?? guess.owner;
      const type = setting.type ?? dataType ?? guess.type ?? (owner ? (findOwner(owner)?.impliesType ?? null) : null);
      rows.push({
        layer: layer.name,
        featureCount: s.count,
        guess,
        setting,
        dataOwners: s.owners,
        dataTypes: s.types,
        owner,
        type,
        overhead: setting.overhead ?? guess.overhead,
        source: {
          owner: setting.owner ? 'layer-edit' : dataOwner ? 'data' : guess.owner ? 'layer-name' : 'none',
          type: setting.type ? 'layer-edit' : dataType ? 'data' : guess.type ? 'layer-name' : type ? 'owner' : 'none',
          overhead: setting.overhead !== undefined ? 'layer-edit' : guess.overhead ? 'layer-name' : 'none',
        },
        incomplete: s.unresolved && !setting.ignore,
        ignored: Boolean(setting.ignore),
      });
    }
    return rows;
  }

  private save() {
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.settings));
    } catch {
      /* storage unavailable: settings last for this session only */
    }
  }
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
