/** Renders CAD features (already in the map's CRS) as OpenLayers vector layers. */
import Feature from 'ol/Feature';
import LineString from 'ol/geom/LineString';
import Point from 'ol/geom/Point';
import Polygon from 'ol/geom/Polygon';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import { Circle as CircleStyle, Fill, Stroke, Style, Text } from 'ol/style';
import type { FeatureLike } from 'ol/Feature';
import type { CadDrawing, CadFeature, CadText } from '../cad/types';

/** CAD text height is cap height; a font's em size is ~1.4x that. */
const CAP_HEIGHT_RATIO = 0.72;
const MIN_LABEL_PX = 5;

export class UtilityLayers {
  readonly geometryLayer: VectorLayer<VectorSource>;
  readonly textLayer: VectorLayer<VectorSource>;
  private geometrySource = new VectorSource();
  private textSource = new VectorSource();
  private hidden = new Set<string>();
  private highlighted: CadFeature | null = null;
  private labelsOn = true;
  private styleCache = new Map<string, Style>();

  constructor() {
    this.geometryLayer = new VectorLayer({
      source: this.geometrySource,
      style: (f) => this.geometryStyle(f),
      updateWhileAnimating: true,
      updateWhileInteracting: true,
      properties: { name: 'utilities' },
    });
    this.textLayer = new VectorLayer({
      source: this.textSource,
      style: (f, res) => this.textStyle(f, res),
      updateWhileInteracting: true,
      properties: { name: 'utility-labels' },
    });
  }

  setDrawing(drawing: CadDrawing | null): void {
    this.geometrySource.clear();
    this.textSource.clear();
    this.highlighted = null;
    this.hidden = new Set(drawing?.layers.filter((l) => l.hiddenInDrawing).map((l) => l.name) ?? []);
    if (!drawing) return;
    const geoms: Feature[] = [];
    const texts: Feature[] = [];
    for (const cad of drawing.features) {
      let olf: Feature;
      switch (cad.kind) {
        case 'line':
          if (cad.coords.length < 2) continue;
          olf = new Feature(new LineString(cad.coords));
          break;
        case 'polygon':
          olf = new Feature(new Polygon(cad.rings));
          break;
        case 'point':
        case 'text':
          olf = new Feature(new Point(cad.coord));
          break;
      }
      olf.set('cad', cad);
      (cad.kind === 'text' ? texts : geoms).push(olf);
    }
    // Draw polygons (hatches) first so lines sit on top.
    geoms.sort((a, b) => Number(b.get('cad').kind === 'polygon') - Number(a.get('cad').kind === 'polygon'));
    this.geometrySource.addFeatures(geoms);
    this.textSource.addFeatures(texts);
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
  }

  get labelsVisible(): boolean {
    return this.labelsOn;
  }

  highlight(cad: CadFeature | null): void {
    this.highlighted = cad;
    this.refresh();
  }

  hiddenLayers(): Set<string> {
    return new Set(this.hidden);
  }

  private refresh() {
    this.geometryLayer.changed();
    this.textLayer.changed();
  }

  private geometryStyle(f: FeatureLike): Style | undefined {
    const cad = f.get('cad') as CadFeature;
    if (this.hidden.has(cad.layer)) return undefined;
    const hl = cad === this.highlighted;
    const key = `${cad.kind}|${cad.color}|${hl}`;
    let s = this.styleCache.get(key);
    if (!s) {
      const stroke = new Stroke({ color: hl ? '#ffffff' : cad.color, width: hl ? 4 : 2 });
      if (cad.kind === 'polygon') s = new Style({ stroke, fill: new Fill({ color: withAlpha(cad.color, 0.25) }) });
      else if (cad.kind === 'point')
        s = new Style({
          image: new CircleStyle({ radius: hl ? 5 : 3, fill: new Fill({ color: cad.color }), stroke: new Stroke({ color: '#000', width: 1 }) }),
        });
      else s = new Style({ stroke });
      this.styleCache.set(key, s);
    }
    return s;
  }

  private textStyle(f: FeatureLike, resolution: number): Style | undefined {
    const cad = f.get('cad') as CadText;
    if (this.hidden.has(cad.layer)) return undefined;
    const px = cad.height / resolution / CAP_HEIGHT_RATIO;
    if (px < MIN_LABEL_PX) return undefined;
    return new Style({
      text: new Text({
        text: cad.text,
        font: `${px.toFixed(1)}px "Arial Narrow", Arial, sans-serif`,
        rotation: -cad.rotation, // OpenLayers rotates clockwise; CAD is counter-clockwise
        rotateWithView: true,
        textAlign: cad.hAlign === 'center' ? 'center' : cad.hAlign,
        textBaseline: cad.vAlign === 'baseline' ? 'alphabetic' : cad.vAlign,
        justify: cad.hAlign === 'center' ? 'center' : cad.hAlign,
        fill: new Fill({ color: cad === this.highlighted ? '#ffffff' : cad.color }),
        stroke: new Stroke({ color: 'rgba(0,0,0,0.85)', width: Math.max(2, px / 6) }),
        overflow: true,
      }),
    });
  }
}

function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}
