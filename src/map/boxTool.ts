/**
 * Draw, select, move and delete excavation boxes.
 * Box coordinates are in the map CRS, i.e. the drawing's MGA grid.
 */
import Feature from 'ol/Feature';
import type Map from 'ol/Map';
import Polygon from 'ol/geom/Polygon';
import Draw, { createBox } from 'ol/interaction/Draw';
import type { GeometryFunction } from 'ol/interaction/Draw';
import Select from 'ol/interaction/Select';
import Translate from 'ol/interaction/Translate';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import { Fill, Stroke, Style, Text } from 'ol/style';
import { click } from 'ol/events/condition';
import { rectangleFromBaseline, signedOffset } from '../analysis/geometry';
import type { XY } from '../cad/types';

export type DrawMode = 'none' | 'rect' | 'rotated';

export interface ExcavationBox {
  id: number;
  name: string;
  /** Closed ring of 5 points (first = last), grid coordinates. */
  ring: XY[];
}

const BOX_COLOUR = '#ffcc00';
/** Boxes narrower than this (m) are treated as mis-clicks and discarded. */
const MIN_BOX_SIDE = 0.05;

function boxStyle(selected: boolean, name: string): Style[] {
  return [
    new Style({
      stroke: new Stroke({ color: selected ? '#ffffff' : BOX_COLOUR, width: selected ? 3 : 2.5, lineDash: selected ? [8, 4] : undefined }),
      fill: new Fill({ color: selected ? 'rgba(255,255,255,0.15)' : 'rgba(255,204,0,0.12)' }),
      text: new Text({
        text: name,
        font: 'bold 13px system-ui, sans-serif',
        fill: new Fill({ color: '#000' }),
        backgroundFill: new Fill({ color: selected ? '#ffffff' : BOX_COLOUR }),
        padding: [2, 4, 1, 4],
        overflow: true,
      }),
    }),
  ];
}

/** Rotated rectangle: click 1 and 2 set one edge, the third click sets the width. */
const rotatedBoxGeometry: GeometryFunction = (coordinates, geometry) => {
  const pts = coordinates as number[][];
  const p1 = pts[0] as XY;
  const p2 = (pts[1] ?? pts[0]) as XY;
  const width = pts[2] ? signedOffset(p1, p2, pts[2] as XY) : 0;
  const ring = rectangleFromBaseline(p1, p2, width);
  if (!geometry) return new Polygon([ring]);
  (geometry as Polygon).setCoordinates([ring]);
  return geometry;
};

export class BoxTool {
  readonly layer: VectorLayer<VectorSource>;
  private source = new VectorSource();
  private draw: Draw | null = null;
  private select: Select;
  private translate: Translate;
  private nextId = 1;
  private mode: DrawMode = 'none';
  private listeners: (() => void)[] = [];
  private modeListeners: ((m: DrawMode) => void)[] = [];

  constructor(
    private map: Map,
    private notify: (message: string) => void = () => {},
  ) {
    this.layer = new VectorLayer({
      source: this.source,
      style: (f) => boxStyle(this.selectedId === f.get('box').id, f.get('box').name),
      properties: { name: 'boxes' },
      zIndex: 10,
    });
    map.addLayer(this.layer);

    this.select = new Select({ layers: [this.layer], condition: click, style: null, hitTolerance: 4 });
    this.select.on('select', () => {
      this.layer.changed();
      this.emit();
    });
    this.translate = new Translate({ features: this.select.getFeatures() });
    this.translate.on('translateend', (e) => {
      e.features.forEach((f) => this.syncFromGeometry(f as Feature<Polygon>));
      this.emit();
    });
    map.addInteraction(this.select);
    map.addInteraction(this.translate);

    document.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if (e.key === 'Escape') {
        if (this.draw) this.setMode('none');
        else this.selectBox(null);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedId !== null) {
        this.remove(this.selectedId);
      }
    });
  }

  get selectedId(): number | null {
    const f = this.select.getFeatures().item(0);
    return f ? (f.get('box') as ExcavationBox).id : null;
  }

  get currentMode(): DrawMode {
    return this.mode;
  }

  boxes(): ExcavationBox[] {
    return this.source
      .getFeatures()
      .map((f) => f.get('box') as ExcavationBox)
      .sort((a, b) => a.id - b.id);
  }

  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  onModeChange(fn: (m: DrawMode) => void): void {
    this.modeListeners.push(fn);
  }

  setMode(mode: DrawMode): void {
    if (this.draw) {
      this.map.removeInteraction(this.draw);
      this.draw = null;
    }
    this.mode = mode;
    this.select.setActive(mode === 'none');
    this.translate.setActive(mode === 'none');
    if (mode !== 'none') {
      this.draw =
        mode === 'rect'
          ? new Draw({ source: this.source, type: 'Circle', geometryFunction: createBox() })
          : new Draw({
              source: this.source,
              type: 'LineString',
              maxPoints: 3,
              geometryFunction: rotatedBoxGeometry,
              // Default 12 px "click near the last point to finish" would end narrow boxes early.
              snapTolerance: 1,
            });
      this.draw.on('drawend', (e) => {
        const f = e.feature as Feature<Polygon>;
        const id = this.nextId++;
        f.set('box', { id, name: `Box ${id}`, ring: [] } satisfies ExcavationBox);
        this.syncFromGeometry(f);
        const ring = (f.get('box') as ExcavationBox).ring;
        const sides = [0, 1].map((i) => Math.hypot(ring[i + 1][0] - ring[i][0], ring[i + 1][1] - ring[i][1]));
        const degenerate = Math.min(...sides) < MIN_BOX_SIDE;
        // Leave draw mode after each box and select the new one (after OpenLayers has added it).
        setTimeout(() => {
          this.setMode('none');
          if (degenerate) {
            this.source.removeFeature(f);
            this.nextId--;
            this.notify('Box discarded: it has no width. Click a third point away from the first edge.');
            this.emit();
          } else this.selectBox(id);
        });
      });
      this.map.addInteraction(this.draw);
    }
    this.modeListeners.forEach((fn) => fn(mode));
  }

  selectBox(id: number | null): void {
    const sel = this.select.getFeatures();
    sel.clear();
    if (id !== null) {
      const f = this.featureById(id);
      if (f) sel.push(f);
    }
    this.layer.changed();
    this.emit();
  }

  remove(id: number): void {
    const f = this.featureById(id);
    if (!f) return;
    this.select.getFeatures().remove(f);
    this.source.removeFeature(f);
    this.emit();
  }

  rename(id: number, name: string): void {
    const f = this.featureById(id);
    if (!f) return;
    (f.get('box') as ExcavationBox).name = name || `Box ${id}`;
    this.layer.changed();
    this.emit();
  }

  clear(): void {
    this.select.getFeatures().clear();
    this.source.clear();
    this.emit();
  }

  zoomTo(id: number): void {
    const f = this.featureById(id);
    const g = f?.getGeometry();
    if (g) this.map.getView().fit(g.getExtent(), { padding: [80, 80, 80, 80], maxZoom: 22, duration: 300 });
  }

  /** Called when the map view is replaced (e.g. CRS change). */
  refresh(): void {
    this.layer.changed();
  }

  private featureById(id: number): Feature<Polygon> | undefined {
    return this.source.getFeatures().find((f) => (f.get('box') as ExcavationBox).id === id) as Feature<Polygon> | undefined;
  }

  private syncFromGeometry(f: Feature<Polygon>) {
    const ring = (f.getGeometry()!.getCoordinates()[0] as XY[]).map(([x, y]) => [x, y] as XY);
    (f.get('box') as ExcavationBox).ring = normaliseRing(ring);
  }

  private emit() {
    this.listeners.forEach((fn) => fn());
  }
}

/** Ensure a closed 5-point ring, counter-clockwise, starting at the south-west-most corner. */
function normaliseRing(ring: XY[]): XY[] {
  let pts = ring.slice(0, 4);
  const area = pts.reduce((s, p, i) => {
    const q = pts[(i + 1) % pts.length];
    return s + p[0] * q[1] - q[0] * p[1];
  }, 0);
  if (area < 0) pts = pts.reverse();
  let start = 0;
  pts.forEach((p, i) => {
    if (p[1] + p[0] < pts[start][1] + pts[start][0]) start = i;
  });
  pts = [...pts.slice(start), ...pts.slice(0, start)];
  return [...pts, pts[0]];
}
