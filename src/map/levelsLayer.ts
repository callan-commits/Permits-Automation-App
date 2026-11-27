/**
 * Feature survey levels on the map: small dots once zoomed in (they'd be a smear further out), and the
 * level itself beside each dot when zoomed right in.
 */
import Feature from 'ol/Feature';
import type { FeatureLike } from 'ol/Feature';
import type OlMap from 'ol/Map';
import Point from 'ol/geom/Point';
import VectorImageLayer from 'ol/layer/VectorImage';
import VectorSource from 'ol/source/Vector';
import { Circle as CircleStyle, Fill, Stroke, Style, Text } from 'ol/style';
import type { SurfaceLevel } from '../analysis/surface';

/** Dots show below this resolution (m per pixel); labels below LABEL_RES. */
const DOT_RES = 0.6;
const LABEL_RES = 0.06;

export class LevelsLayer {
  private source = new VectorSource<Feature<Point>>();
  private layer: VectorImageLayer<VectorSource<Feature<Point>>>;
  private dot = new Style({
    image: new CircleStyle({ radius: 2.5, fill: new Fill({ color: '#f5f5f5' }), stroke: new Stroke({ color: '#111', width: 1 }) }),
  });

  constructor(map: OlMap) {
    this.layer = new VectorImageLayer({
      source: this.source,
      maxResolution: DOT_RES,
      zIndex: 1,
      style: (f: FeatureLike, res: number) => {
        if (res > LABEL_RES) return this.dot;
        return [
          this.dot,
          new Style({
            text: new Text({
              text: (f.get('z') as number).toFixed(2),
              font: '10px system-ui, sans-serif',
              offsetX: 5,
              textAlign: 'left',
              fill: new Fill({ color: '#fff' }),
              stroke: new Stroke({ color: '#000', width: 2.5 }),
            }),
          }),
        ];
      },
    });
    map.addLayer(this.layer);
  }

  setLevels(levels: SurfaceLevel[]): void {
    this.source.clear(true);
    this.source.addFeatures(
      levels.map((l) => {
        const f = new Feature(new Point([l.x, l.y]));
        f.set('z', l.z);
        return f;
      }),
    );
  }

  setVisible(on: boolean): void {
    this.layer.setVisible(on);
  }
}
