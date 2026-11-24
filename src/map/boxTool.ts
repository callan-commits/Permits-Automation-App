/**
 * Draw, select, edit, move and delete work areas ("boxes"): rectangles, rotated
 * rectangles or free-form polygons. Coordinates are in the map CRS (the drawing's MGA grid).
 */
import Feature from 'ol/Feature';
import type Map from 'ol/Map';
import Polygon from 'ol/geom/Polygon';
import Draw from 'ol/interaction/Draw';
import type { GeometryFunction } from 'ol/interaction/Draw';
import Modify from 'ol/interaction/Modify';
import Select from 'ol/interaction/Select';
import Translate from 'ol/interaction/Translate';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import { Fill, Stroke, Style, Text } from 'ol/style';
import { altKeyOnly, click, singleClick } from 'ol/events/condition';
import { invalidShapeReason, normaliseRing, rectangleFromBaseline, signedOffset } from '../analysis/geometry';
import type { XY } from '../cad/types';

export type DrawMode = 'none' | 'rect' | 'rotated' | 'polygon';

export interface ExcavationBox {
  id: number;
  name: string;
  /** Closed ring (first = last), counter-clockwise, grid coordinates. Any number of vertices. */
  ring: XY[];
}

const BOX_COLOUR = '#ffcc00';

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
  private modify: Modify;
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
      style: (f) => {
        const box = f.get('box') as ExcavationBox | undefined;
        // A rejected shape sits in the source briefly before it's removed: don't draw it.
        return box ? boxStyle(this.selectedId === box.id, box.name) : undefined;
      },
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
    // Vertex editing on the selected box: drag a vertex, click an edge to add one, Alt+click to delete one.
    this.modify = new Modify({
      features: this.select.getFeatures(),
      deleteCondition: (e) => altKeyOnly(e) && singleClick(e),
      pixelTolerance: 8,
    });
    this.modify.on('modifystart', (e) => {
      e.features.forEach((f) => f.set('beforeEdit', (f as Feature<Polygon>).getGeometry()!.clone(), true));
    });
    this.modify.on('modifyend', (e) => {
      e.features.forEach((f) => {
        const feature = f as Feature<Polygon>;
        const reason = invalidShapeReason(feature.getGeometry()!.getCoordinates()[0] as XY[]);
        if (reason) {
          feature.setGeometry(feature.get('beforeEdit') as Polygon);
          this.notify(`Edit undone: ${reason}.`);
        }
        this.syncFromGeometry(feature);
      });
      this.emit();
    });
    // OpenLayers gives the most recently added interaction first pick, so corner editing (added last)
    // wins near corners and edges, and dragging anywhere else moves the whole box.
    map.addInteraction(this.select);
    map.addInteraction(this.translate);
    map.addInteraction(this.modify);

    document.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if (e.key === 'Escape') {
        if (this.draw) this.setMode('none');
        else this.selectBox(null);
      } else if (e.key === 'Backspace' && this.draw && this.mode === 'polygon') {
        e.preventDefault();
        this.draw.removeLastPoint(); // undo the last corner while drawing
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && !this.draw && this.selectedId !== null) {
        this.remove(this.selectedId);
      } else if (e.key === 'Enter' && this.draw && this.mode === 'polygon') {
        this.draw.finishDrawing();
      }
    });
  }

  get selectedId(): number | null {
    const box = this.select.getFeatures().item(0)?.get('box') as ExcavationBox | undefined;
    return box ? box.id : null;
  }

  get currentMode(): DrawMode {
    return this.mode;
  }

  boxes(): ExcavationBox[] {
    return this.source
      .getFeatures()
      .map((f) => f.get('box') as ExcavationBox | undefined)
      .filter((b): b is ExcavationBox => Boolean(b))
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
    this.modify.setActive(mode === 'none');
    if (mode !== 'none') {
      this.selectBox(null);
      this.draw =
        mode === 'rect'
          ? new Draw({ source: this.source, type: 'Circle', geometryFunction: this.screenBoxGeometry })
          : mode === 'rotated'
            ? new Draw({
                source: this.source,
                type: 'LineString',
                maxPoints: 3,
                geometryFunction: rotatedBoxGeometry,
                // Default 12 px "click near the last point to finish" would end narrow boxes early.
                snapTolerance: 1,
              })
            : // Free-form: click corners; finish by clicking the first corner, double-clicking or pressing Enter.
              new Draw({ source: this.source, type: 'Polygon' });
      this.draw.on('drawend', (e) => {
        const f = e.feature as Feature<Polygon>;
        const reason = invalidShapeReason(f.getGeometry()!.getCoordinates()[0] as XY[]);
        const id = reason ? 0 : this.nextId++;
        if (!reason) {
          f.set('box', { id, name: `Box ${id}`, ring: [] } satisfies ExcavationBox);
          this.syncFromGeometry(f);
        }
        // Leave draw mode after each box and select the new one (after OpenLayers has added it).
        setTimeout(() => {
          this.setMode('none');
          if (reason) {
            this.source.removeFeature(f);
            this.notify(`Box discarded: ${reason}.`);
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

  /** Rectangle from two opposite corners, square to the screen (follows map rotation). */
  private screenBoxGeometry: GeometryFunction = (coordinates, geometry) => {
    const [a, b] = coordinates as number[][];
    const view = this.map.getView();
    const r = view.getRotation();
    // Screen "right" and "up" directions in map coordinates for the current rotation.
    const o = this.map.getCoordinateFromPixel([0, 0]);
    const px = this.map.getCoordinateFromPixel([100, 0]);
    let ex: XY = o && px ? [px[0] - o[0], px[1] - o[1]] : [Math.cos(r), -Math.sin(r)];
    const len = Math.hypot(ex[0], ex[1]) || 1;
    ex = [ex[0] / len, ex[1] / len];
    const ey: XY = [-ex[1], ex[0]];
    const d: XY = [b[0] - a[0], b[1] - a[1]];
    const u = d[0] * ex[0] + d[1] * ex[1];
    const v = d[0] * ey[0] + d[1] * ey[1];
    const ring: XY[] = [
      [a[0], a[1]],
      [a[0] + u * ex[0], a[1] + u * ex[1]],
      [b[0], b[1]],
      [a[0] + v * ey[0], a[1] + v * ey[1]],
      [a[0], a[1]],
    ];
    if (!geometry) return new Polygon([ring]);
    (geometry as Polygon).setCoordinates([ring]);
    return geometry;
  };

  private featureById(id: number): Feature<Polygon> | undefined {
    return this.source.getFeatures().find((f) => (f.get('box') as ExcavationBox | undefined)?.id === id) as Feature<Polygon> | undefined;
  }

  private syncFromGeometry(f: Feature<Polygon>) {
    const ring = normaliseRing((f.getGeometry()!.getCoordinates()[0] as XY[]).map(([x, y]) => [x, y] as XY));
    (f.get('box') as ExcavationBox).ring = ring;
    // Keep the drawn geometry identical to the stored ring (no duplicate points).
    f.getGeometry()!.setCoordinates([ring]);
  }

  private emit() {
    this.listeners.forEach((fn) => fn());
  }
}
