/** Map markers for the selected box's schedule: "S1", "S2"... where each RL applies. */
import Feature from 'ol/Feature';
import LineString from 'ol/geom/LineString';
import Point from 'ol/geom/Point';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import { Circle as CircleStyle, Fill, Stroke, Style, Text } from 'ol/style';
import type { ScheduleRow } from '../services/scheduleModel';

const markerStyle = (label: string, needsInput: boolean) =>
  new Style({
    image: new CircleStyle({ radius: 5, fill: new Fill({ color: needsInput ? '#ffcc00' : '#ffffff' }), stroke: new Stroke({ color: '#000', width: 1.5 }) }),
    text: new Text({
      text: label,
      font: 'bold 12px system-ui, sans-serif',
      offsetY: -14,
      fill: new Fill({ color: '#000' }),
      backgroundFill: new Fill({ color: needsInput ? '#ffcc00' : '#ffffff' }),
      padding: [1, 3, 0, 3],
    }),
  });
const gapStyle = new Style({ stroke: new Stroke({ color: '#ffffff', width: 1.5, lineDash: [4, 4] }) });

export class ScheduleLayer {
  readonly layer: VectorLayer<VectorSource>;
  private source = new VectorSource();

  constructor() {
    this.layer = new VectorLayer({ source: this.source, zIndex: 20, properties: { name: 'schedule-markers' } });
  }

  show(rows: ScheduleRow[] | null): void {
    this.source.clear(true);
    if (!rows) return;
    const features: Feature[] = [];
    for (const r of rows) {
      if (r.excluded) continue;
      const needs = r.needs.type || r.needs.owner || r.needs.rl;
      r.entry.points.forEach((p, i) => {
        const f = new Feature(new Point(p.at));
        f.setStyle(markerStyle(r.entry.points.length > 1 ? `${r.id}${'abcdefghij'[i] ?? ''}` : r.id, needs));
        features.push(f);
        // Dashed line showing the gap for services that don't cross the box.
        if (r.entry.relation === 'near') {
          const g = new Feature(new LineString([p.onBox, p.at]));
          g.setStyle(gapStyle);
          features.push(g);
        }
      });
    }
    this.source.addFeatures(features);
  }
}
