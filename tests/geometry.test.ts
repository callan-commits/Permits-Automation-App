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

describe('free-form shapes', () => {
  it('gives exact side lengths for a rotated rectangle', async () => {
    const { boxDimensions } = await import('../src/analysis/geometry');
    // 18 x 5 m rectangle at bearing 135 deg, on MGA-sized coordinates
    const b = (135 * Math.PI) / 180;
    const u: XY = [Math.sin(b), Math.cos(b)];
    const n: XY = [-u[1], u[0]];
    const o: XY = [327842.9, 5805970.5];
    const p = (s: number, w: number): XY => [o[0] + s * u[0] + w * n[0], o[1] + s * u[1] + w * n[1]];
    const d = boxDimensions([p(0, 0), p(18, 0), p(18, 5), p(0, 5), p(0, 0)]);
    expect(d.length).toBeCloseTo(18, 6);
    expect(d.width).toBeCloseTo(5, 6);
    expect(d.area).toBeCloseTo(90, 6);
    expect(d.perimeter).toBeCloseTo(46, 6);
    expect(d.bearing).toBeCloseTo(135, 6);
    expect(d.centre[0]).toBeCloseTo(p(9, 2.5)[0], 6);
    expect(d.centre[1]).toBeCloseTo(p(9, 2.5)[1], 6);
  });

  it('measures an L-shaped polygon', async () => {
    const { boxDimensions } = await import('../src/analysis/geometry');
    // L shape: 10x10 square minus 6x6 corner = 64 m2
    const ring: XY[] = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10], [0, 0]];
    const d = boxDimensions(ring);
    expect(d.area).toBeCloseTo(64);
    expect(d.perimeter).toBeCloseTo(40);
    expect(d.length).toBeCloseTo(10);
    expect(d.width).toBeCloseTo(10);
    expect(d.vertexCount).toBe(6);
    // centroid of the L (by composite areas)
    expect(d.centre[0]).toBeCloseTo((40 * 5 + 24 * 2) / 64, 6);
  });

  it('rejects crossing edges and degenerate shapes, accepts valid ones', async () => {
    const { invalidShapeReason } = await import('../src/analysis/geometry');
    expect(invalidShapeReason([[0, 0], [10, 10], [10, 0], [0, 10], [0, 0]])).toMatch(/cross/); // bow-tie
    expect(invalidShapeReason([[0, 0], [10, 0], [20, 0], [0, 0]])).toMatch(/no width/);
    expect(invalidShapeReason([[0, 0], [10, 0], [0, 0]])).toMatch(/3 corners/);
    expect(invalidShapeReason([[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10], [0, 0]])).toBeNull();
  });

  it('normalises drawn rings: closed, counter-clockwise, no repeats', async () => {
    const { normaliseRing, signedArea } = await import('../src/analysis/geometry');
    const r = normaliseRing([[0, 10], [10, 10], [10, 10], [10, 0], [0, 0], [0, 10]]);
    expect(r[0]).toEqual(r[r.length - 1]);
    expect(r.length).toBe(5);
    expect(signedArea(r)).toBeGreaterThan(0);
    expect(r[0]).toEqual([0, 0]);
  });

  it('measures distances from a concave shape correctly', () => {
    // A line passing through the notch of the L is outside the shape
    const ring: XY[] = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10], [0, 0]];
    expect(polygonToLineDistance(ring, [[7, 7], [9, 9]])).toBeCloseTo(3);
    expect(polygonToLineDistance(ring, [[2, -5], [2, 15]])).toBe(0);
  });
});
