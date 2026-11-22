import { describe, expect, it } from 'vitest';
import { boxDimensions, nearbyByLayer, polygonToLineDistance, rectangleFromBaseline, signedOffset } from '../src/analysis/geometry';
import type { CadFeature, XY } from '../src/cad/types';
import { checkExtentLooksLikeMga, toLonLat } from '../src/geo/crs';
import proj4 from 'proj4';

describe('rotated box', () => {
  it('builds a rectangle from a baseline and width', () => {
    const r = rectangleFromBaseline([0, 0], [10, 0], 4);
    expect(r).toEqual([[0, 0], [10, 0], [10, 4], [0, 4], [0, 0]]);
    const d = boxDimensions(r);
    expect(d.length).toBe(10);
    expect(d.width).toBe(4);
    expect(d.area).toBe(40);
    expect(d.bearing).toBe(90);
  });

  it('measures signed offsets', () => {
    expect(signedOffset([0, 0], [10, 0], [3, 2])).toBe(2);
    expect(signedOffset([0, 0], [10, 0], [3, -2])).toBe(-2);
  });
});

describe('distances', () => {
  const box: XY[] = [[0, 0], [10, 0], [10, 4], [0, 4], [0, 0]];
  it('is zero for a line crossing the box', () => {
    expect(polygonToLineDistance(box, [[5, -10], [5, 10]])).toBe(0);
  });
  it('is zero for a line inside the box', () => {
    expect(polygonToLineDistance(box, [[2, 2], [3, 2]])).toBe(0);
  });
  it('measures the gap to a parallel line', () => {
    expect(polygonToLineDistance(box, [[-5, 7], [15, 7]])).toBeCloseTo(3);
  });
  it('groups nearby features by layer', () => {
    const f = (layer: string, coords: XY[]): CadFeature => ({ kind: 'line', layer, color: '#fff', entityType: 'LINE', handle: '1', coords });
    const res = nearbyByLayer(box, [f('GAS', [[5, -10], [5, 10]]), f('COMMS', [[-5, 7], [15, 7]]), f('FAR', [[100, 100], [101, 100]])], 5);
    expect(res.map((r) => [r.layer, Math.round(r.minDistance * 100) / 100])).toEqual([
      ['GAS', 0],
      ['COMMS', 3],
    ]);
  });
});

describe('coordinate systems', () => {
  it('converts MGA2020 z55 to lon/lat', () => {
    const [lon, lat] = toLonLat('EPSG:7855', [327842.91, 5805970.46]);
    expect(lon).toBeCloseTo(145.0425, 5);
    expect(lat).toBeCloseTo(-37.8775, 5);
  });
  it('applies the GDA94 -> GDA2020 shift for MGA94 (matches PROJ to < 1 mm)', () => {
    const out = proj4('EPSG:28355', 'EPSG:7855', [327842.9, 5805970.5]);
    expect(out[0]).toBeCloseTo(327843.3897, 3);
    expect(out[1]).toBeCloseTo(5805971.9709, 3);
  });
  it('flags non-MGA extents', () => {
    expect(checkExtentLooksLikeMga([327_000, 5_805_000, 328_000, 5_806_000])).toBeNull();
    expect(checkExtentLooksLikeMga([0, 0, 500, 500])).toMatch(/local site grid/);
    expect(checkExtentLooksLikeMga([144.9, -37.9, 145.1, -37.8])).toMatch(/latitude/);
  });
});
