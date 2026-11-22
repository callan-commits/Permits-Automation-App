import { describe, expect, it } from 'vitest';
import { SpatialGrid } from '../src/analysis/spatialIndex';
import { pointToFeatureDistance } from '../src/analysis/geometry';
import { maxVisibleResolution } from '../src/map/utilityLayer';
import type { CadFeature } from '../src/cad/types';

describe('spatial grid', () => {
  it('finds items by bounding box and matches a brute-force search', () => {
    const grid = new SpatialGrid<number>([0, 0, 1000, 1000], 10);
    const boxes: [number, number, number, number][] = [];
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 1000;
    for (let i = 0; i < 2000; i++) {
      const x = rnd();
      const y = rnd();
      const b: [number, number, number, number] = [x, y, x + rnd() / 50, y + rnd() / 50];
      boxes.push(b);
      grid.insert(b, i);
    }
    // a huge item lands in the oversize list
    grid.insert([-5000, -5000, 5000, 5000], 9999);
    const q: [number, number, number, number] = [400, 400, 450, 470];
    const expected = boxes
      .map((b, i) => (b[0] <= q[2] && b[2] >= q[0] && b[1] <= q[3] && b[3] >= q[1] ? i : -1))
      .filter((i) => i >= 0)
      .concat(9999);
    expect(grid.query(q).sort((a, b) => a - b)).toEqual(expected.sort((a, b) => a - b));
  });
});

describe('level of detail', () => {
  const base = { layer: 'L', color: '#fff', handle: '1' };
  it('always draws ordinary lines', () => {
    const f: CadFeature = { ...base, kind: 'line', entityType: 'LWPOLYLINE', coords: [[0, 0], [0.1, 0]] };
    expect(maxVisibleResolution(f, [0, 0, 0.1, 0])).toBe(Infinity);
  });
  it('hides small block symbols until they are a couple of pixels wide', () => {
    const f: CadFeature = { ...base, kind: 'line', entityType: 'LINE', block: 'SPT', coords: [[0, 0], [0.3, 0]] };
    expect(maxVisibleResolution(f, [0, 0, 0.3, 0])).toBeCloseTo(0.15);
  });
  it('shows text once it is readable', () => {
    const f: CadFeature = { ...base, kind: 'text', entityType: 'TEXT', coord: [0, 0], text: 'X', height: 0.72, rotation: 0, hAlign: 'left', vAlign: 'baseline' };
    expect(maxVisibleResolution(f, [0, 0, 0, 0])).toBeCloseTo(0.2); // 5 px tall at 0.2 m/px
  });
});

describe('click distance', () => {
  it('measures from a point to a polyline', () => {
    const f: CadFeature = { kind: 'line', layer: 'L', color: '#fff', entityType: 'LINE', handle: '1', coords: [[0, 0], [10, 0]] };
    expect(pointToFeatureDistance([5, 3], f)).toBe(3);
    expect(pointToFeatureDistance([13, 4], f)).toBe(5);
  });
});
