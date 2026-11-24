/**
 * Renders CAD features (already in the map's CRS) efficiently enough for large surveys.
 *
 * - Geometry is merged into a few thousand multi-geometries (by layer, colour, level of detail
 *   and 128 m area cell) and drawn as one image that just slides while panning.
 * - Level of detail: small symbols (blocks, circles, points, hatches) are only drawn once they
 *   would be at least a couple of pixels across. Ordinary lines are always drawn.
 * - Text labels are created on demand for the area in view, once they are big enough to read.
 * - Clicking and offset checks use a spatial index of the original features.
 */
import Feature from 'ol/Feature';
import LineString from 'ol/geom/LineString';
import MultiLineString from 'ol/geom/MultiLineString';
import MultiPoint from 'ol/geom/MultiPoint';
import MultiPolygon from 'ol/geom/MultiPolygon';
import Point from 'ol/geom/Point';
import Polygon from 'ol/geom/Polygon';
import VectorLayer from 'ol/layer/Vector';
import VectorImageLayer from 'ol/layer/VectorImage';
import VectorSource from 'ol/source/Vector';
import { Circle as CircleStyle, Fill, Stroke, Style, Text } from 'ol/style';
import type { FeatureLike } from 'ol/Feature';
import type { Extent } from 'ol/extent';
import { featureBBox, pointInPolygon, pointToFeatureDistance } from '../analysis/geometry';
import { type BBox, SpatialGrid } from '../analysis/spatialIndex';
import type { CadDrawing, CadFeature, CadText, XY } from '../cad/types';

/** CAD text height is cap height; a font's em size is ~1.4x that. */
const CAP_HEIGHT_RATIO = 0.72;
/** Labels smaller than this on screen are not drawn. */
const MIN_LABEL_PX = 5;
/** Symbols smaller than this on screen are not drawn. */
const MIN_SYMBOL_PX = 2;
/** Upper limit of labels drawn at once (largest text wins). */
const MAX_LABELS = 4000;
/** Size of the area cells geometry is grouped into, in metres. */
const GROUP_CELL = 128;

interface IndexedFeature {
  cad: CadFeature;
  /** Largest resolution (m/px) at which the feature is drawn. */
  maxRes: number;
}

/** Largest resolution at which a feature is still worth drawing. */
export function maxVisibleResolution(f: CadFeature, box: BBox): number {
  if (f.kind === 'text') return f.height / CAP_HEIGHT_RATIO / MIN_LABEL_PX;
  const size = Math.max(box[2] - box[0], box[3] - box[1]);
  if (f.kind === 'point') return 0.5;
  // Ordinary lines (not part of a symbol) are always drawn; the renderer simplifies them.
  if (f.kind === 'line' && !f.block && f.entityType !== 'CIRCLE') return Infinity;
  return size / MIN_SYMBOL_PX;
}

/** Round down to a power of two so features share a small number of groups. */
const resBucket = (r: number) => (Number.isFinite(r) ? 2 ** Math.floor(Math.log2(Math.max(r, 1e-6))) : Infinity);

export class UtilityLayers {
  readonly geometryLayer: VectorImageLayer<VectorSource>;
  readonly textLayer: VectorLayer<VectorSource>;
  readonly highlightLayer: VectorLayer<VectorSource>;
  private geometrySource = new VectorSource();
  private textSource = new VectorSource();
  private highlightSource = new VectorSource();
  private hidden = new Set<string>();
  private highlighted: CadFeature | null = null;
  private labelsOn = true;
  private styleCache = new Map<string, Style>();
  private isOverhead: (layer: string) => boolean = () => false;

  private index: SpatialGrid<IndexedFeature> | null = null;
  private texts: CadText[] = [];
  private textMaxRes: number[] = [];
  private textIndex: SpatialGrid<number> | null = null;
  private textFeatures = new Map<number, Feature>();
  private lastLabelView: { extent: Extent; resolution: number } | null = null;

  constructor() {
    this.geometryLayer = new VectorImageLayer({
      source: this.geometrySource,
      style: (f, res) => this.groupStyle(f, res),
      imageRatio: 1.5, // render a margin around the view so short pans need no redraw
      properties: { name: 'utilities' },
    });
    this.textLayer = new VectorLayer({
      source: this.textSource,
      style: (f, res) => this.textStyle(f, res),
      properties: { name: 'utility-labels' },
    });
    this.highlightLayer = new VectorLayer({
      source: this.highlightSource,
      style: new Style({
        stroke: new Stroke({ color: '#ffffff', width: 4 }),
        fill: new Fill({ color: 'rgba(255,255,255,0.2)' }),
        image: new CircleStyle({ radius: 6, stroke: new Stroke({ color: '#ffffff', width: 2 }) }),
      }),
      zIndex: 5,
    });
  }

  setDrawing(drawing: CadDrawing | null): void {
    this.geometrySource.clear();
    this.textSource.clear();
    this.textFeatures.clear();
    this.highlight(null);
    this.texts = [];
    this.textMaxRes = [];
    this.index = null;
    this.textIndex = null;
    this.lastLabelView = null;
    this.hidden = new Set(drawing?.layers.filter((l) => l.hiddenInDrawing).map((l) => l.name) ?? []);
    if (!drawing || !drawing.extent) return;

    const ext = drawing.focusExtent ?? drawing.extent;
    const nonText = drawing.features.length - drawing.features.filter((f) => f.kind === 'text').length;
    const area = Math.max((ext[2] - ext[0]) * (ext[3] - ext[1]), 1);
    const cell = Math.min(200, Math.max(2, Math.sqrt(area / Math.max(nonText / 4, 1))));
    this.index = new SpatialGrid<IndexedFeature>(ext, cell);
    this.textIndex = new SpatialGrid<number>(ext, Math.max(cell * 2, 10));

    // Merge geometry into groups.
    interface Group {
      layer: string;
      color: string;
      kind: 'line' | 'polygon' | 'point';
      maxRes: number;
      flat: number[];
      ends: number[];
      endss: number[][];
    }
    const groups = new Map<string, Group>();
    for (const cad of drawing.features) {
      const box = featureBBox(cad);
      if (!Number.isFinite(box[0])) continue;
      const maxRes = maxVisibleResolution(cad, box);
      if (cad.kind === 'text') {
        const i = this.texts.length;
        this.texts.push(cad);
        this.textMaxRes.push(maxRes);
        this.textIndex.insert(box, i);
        continue;
      }
      if (cad.kind === 'line' && cad.coords.length < 2) continue;
      this.index.insert(box, { cad, maxRes });
      const bucket = resBucket(maxRes);
      const cx = Math.floor((box[0] + box[2]) / 2 / GROUP_CELL);
      const cy = Math.floor((box[1] + box[3]) / 2 / GROUP_CELL);
      const key = `${cad.layer}\u0000${cad.color}\u0000${cad.kind}\u0000${bucket}\u0000${cx}\u0000${cy}`;
      let g = groups.get(key);
      if (!g) {
        g = { layer: cad.layer, color: cad.color, kind: cad.kind, maxRes: bucket, flat: [], ends: [], endss: [] };
        groups.set(key, g);
      }
      if (cad.kind === 'line') {
        for (const [x, y] of cad.coords) g.flat.push(x, y);
        g.ends.push(g.flat.length);
      } else if (cad.kind === 'polygon') {
        const ends: number[] = [];
        for (const ring of cad.rings) {
          for (const [x, y] of ring) g.flat.push(x, y);
          ends.push(g.flat.length);
        }
        g.endss.push(ends);
      } else {
        g.flat.push(cad.coord[0], cad.coord[1]);
      }
    }

    const features: Feature[] = [];
    for (const g of groups.values()) {
      const geom =
        g.kind === 'line'
          ? new MultiLineString(g.flat, 'XY', g.ends)
          : g.kind === 'polygon'
            ? new MultiPolygon(g.flat, 'XY', g.endss)
            : new MultiPoint(g.flat, 'XY');
      const f = new Feature(geom);
      f.setProperties({ layer: g.layer, color: g.color, kind: g.kind, maxRes: g.maxRes }, true);
      features.push(f);
    }
    // Hatches first so lines draw on top of them.
    features.sort((a, b) => Number(b.get('kind') === 'polygon') - Number(a.get('kind') === 'polygon'));
    this.geometrySource.addFeatures(features);
  }

  /** Number of merged map objects (for diagnostics). */
  get renderedObjectCount(): number {
    return this.geometrySource.getFeatures().length;
  }

  isLayerVisible(layer: string): boolean {
    return !this.hidden.has(layer);
  }

  setLayerVisible(layer: string, visible: boolean): void {
    if (visible) this.hidden.delete(layer);
    else this.hidden.add(layer);
    this.refresh();
  }

  setAllVisible(layers: string[], visible: boolean): void {
    for (const l of layers) {
      if (visible) this.hidden.delete(l);
      else this.hidden.add(l);
    }
    this.refresh();
  }

  setLabelsVisible(on: boolean): void {
    this.labelsOn = on;
    this.textLayer.setVisible(on);
    if (this.lastLabelView) this.updateLabels(this.lastLabelView.extent, this.lastLabelView.resolution);
  }

  get labelsVisible(): boolean {
    return this.labelsOn;
  }

  /** Overhead services are drawn dashed. */
  setOverheadTest(fn: (layer: string) => boolean): void {
    this.isOverhead = fn;
    this.geometryLayer.changed();
  }

  hiddenLayers(): Set<string> {
    return new Set(this.hidden);
  }

  /** Non-text features whose bounding box intersects `box` (all layers). */
  featuresIn(box: BBox): CadFeature[] {
    return this.index ? this.index.query(box).map((i) => i.cad) : [];
  }

  /**
   * Create label features for the area in view. Call after the view stops moving.
   * Only labels that would be readable at this resolution are created.
   */
  updateLabels(extent: Extent, resolution: number): void {
    this.lastLabelView = { extent: [...extent], resolution };
    if (!this.textIndex || !this.labelsOn) {
      if (this.textSource.getFeatures().length) this.textSource.clear(true);
      return;
    }
    let wanted = this.textIndex
      .query(extent as BBox)
      .filter((i) => this.textMaxRes[i] >= resolution && !this.hidden.has(this.texts[i].layer));
    if (wanted.length > MAX_LABELS) wanted = wanted.sort((a, b) => this.textMaxRes[b] - this.textMaxRes[a]).slice(0, MAX_LABELS);
    const want = new Set(wanted);
    const current = this.textSource.getFeatures();
    const toRemove = current.filter((f) => !want.has(f.get('idx') as number));
    const have = new Set(current.map((f) => f.get('idx') as number));
    const toAdd: Feature[] = [];
    for (const i of wanted) {
      if (have.has(i)) continue;
      let f = this.textFeatures.get(i);
      if (!f) {
        f = new Feature(new Point(this.texts[i].coord));
        f.setProperties({ idx: i, cad: this.texts[i] }, true);
        this.textFeatures.set(i, f);
      }
      toAdd.push(f);
    }
    if (toRemove.length) this.textSource.removeFeatures(toRemove);
    if (toAdd.length) this.textSource.addFeatures(toAdd);
  }

  /** The feature drawn nearest to `coord` within `tolerance` metres, respecting visibility. */
  hitTest(coord: XY, resolution: number, tolerancePx = 6): CadFeature | null {
    if (!this.index) return null;
    const tol = tolerancePx * resolution;
    let best: CadFeature | null = null;
    let bestDist = tol;
    for (const { cad, maxRes } of this.index.query([coord[0] - tol, coord[1] - tol, coord[0] + tol, coord[1] + tol])) {
      if (maxRes < resolution || this.hidden.has(cad.layer)) continue;
      let d = pointToFeatureDistance(coord, cad);
      // Clicking inside a closed outline (a pit symbol, a closed polyline) selects it too.
      if (d > tol && cad.kind === 'line' && isClosedRing(cad.coords) && pointInPolygon(coord, cad.coords)) d = 0;
      // Prefer an edge that was clicked on over an area the click merely falls inside.
      const inside = d === 0 && (cad.kind === 'polygon' || (cad.kind === 'line' && isClosedRing(cad.coords)));
      const adjusted = inside ? tol * 0.9 : d;
      if (adjusted <= bestDist) {
        bestDist = adjusted;
        best = cad;
      }
    }
    return best;
  }

  highlight(cad: CadFeature | null): void {
    this.highlighted = cad;
    this.highlightSource.clear(true);
    if (!cad || cad.kind === 'text') {
      this.textLayer.changed();
      return;
    }
    const geom =
      cad.kind === 'line' ? new LineString(cad.coords) : cad.kind === 'polygon' ? new Polygon(cad.rings) : new Point(cad.coord);
    this.highlightSource.addFeature(new Feature(geom));
    this.textLayer.changed();
  }

  private refresh() {
    this.geometryLayer.changed();
    if (this.lastLabelView) this.updateLabels(this.lastLabelView.extent, this.lastLabelView.resolution);
    this.textLayer.changed();
  }

  private groupStyle(f: FeatureLike, resolution: number): Style | undefined {
    if (resolution > (f.get('maxRes') as number) || this.hidden.has(f.get('layer'))) return undefined;
    const color = f.get('color') as string;
    const kind = f.get('kind') as string;
    const overhead = kind === 'line' && this.isOverhead(f.get('layer') as string);
    const key = `${kind}|${color}|${overhead}`;
    let s = this.styleCache.get(key);
    if (!s) {
      if (kind === 'polygon') s = new Style({ stroke: new Stroke({ color, width: 1 }), fill: new Fill({ color: withAlpha(color, 0.25) }) });
      else if (kind === 'point')
        s = new Style({ image: new CircleStyle({ radius: 3, fill: new Fill({ color }), stroke: new Stroke({ color: '#000', width: 1 }) }) });
      else s = new Style({ stroke: new Stroke({ color, width: 2, lineDash: overhead ? [10, 6] : undefined }) });
      this.styleCache.set(key, s);
    }
    return s;
  }

  private textStyle(f: FeatureLike, resolution: number): Style | undefined {
    const cad = f.get('cad') as CadText;
    if (this.hidden.has(cad.layer)) return undefined;
    const px = cad.height / resolution / CAP_HEIGHT_RATIO;
    if (px < MIN_LABEL_PX) return undefined;
    const hl = cad === this.highlighted;
    // Reuse the style while panning at the same zoom.
    const cacheKey = `${px.toFixed(1)}|${hl}`;
    const feature = f as Feature;
    if (feature.get('styleKey') === cacheKey) return feature.get('style') as Style;
    const style = new Style({
      text: new Text({
        text: cad.text,
        font: `${px.toFixed(1)}px "Arial Narrow", Arial, sans-serif`,
        rotation: -cad.rotation, // OpenLayers rotates clockwise; CAD is counter-clockwise
        rotateWithView: true,
        textAlign: cad.hAlign,
        textBaseline: cad.vAlign === 'baseline' ? 'alphabetic' : cad.vAlign,
        justify: cad.hAlign,
        fill: new Fill({ color: hl ? '#ffffff' : cad.color }),
        stroke: new Stroke({ color: 'rgba(0,0,0,0.85)', width: Math.max(2, px / 6) }),
        overflow: true,
      }),
    });
    feature.setProperties({ styleKey: cacheKey, style }, true);
    return style;
  }
}

function isClosedRing(c: XY[]): boolean {
  if (c.length < 4) return false;
  const [a, b] = [c[0], c[c.length - 1]];
  return Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
}

function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}
