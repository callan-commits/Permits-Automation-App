/**
 * Coordinate reference systems used by utility surveys in Victoria.
 *
 * The map view itself runs in the drawing's projected CRS (e.g. MGA2020 Zone 55),
 * so drawing coordinates are used directly, distances are true grid metres and the
 * box corners come out in survey coordinates. Imagery tiles are reprojected to fit.
 *
 * GDA2020 is treated as equal to WGS84 (they differ by < 0.5 m in 2026, less than the
 * positional accuracy of free imagery). GDA94 uses the official 7-parameter
 * GDA94 -> GDA2020 transformation (EPSG:8048, conformal).
 */
import proj4 from 'proj4';
import { register } from 'ol/proj/proj4';
import { get as getProjection } from 'ol/proj';
import type { Projection } from 'ol/proj';

export interface CrsOption {
  code: string;
  label: string;
  zone: number;
}

const GDA94_TO_GDA2020 = '+towgs84=0.06155,-0.01087,-0.04019,0.0394924,0.0327221,0.0328979,-0.009994';

export const CRS_OPTIONS: CrsOption[] = [
  { code: 'EPSG:7855', label: 'MGA2020 Zone 55 (Melbourne, central & east VIC)', zone: 55 },
  { code: 'EPSG:7854', label: 'MGA2020 Zone 54 (western VIC)', zone: 54 },
  { code: 'EPSG:7856', label: 'MGA2020 Zone 56', zone: 56 },
  { code: 'EPSG:28355', label: 'MGA94 Zone 55 (older surveys)', zone: 55 },
  { code: 'EPSG:28354', label: 'MGA94 Zone 54 (older surveys)', zone: 54 },
];

export const DEFAULT_CRS = 'EPSG:7855';

let registered = false;

export function registerCrs(): void {
  if (registered) return;
  for (const zone of [54, 55, 56]) {
    proj4.defs(`EPSG:78${zone}`, `+proj=utm +zone=${zone} +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs`);
    proj4.defs(`EPSG:283${zone}`, `+proj=utm +zone=${zone} +south +ellps=GRS80 ${GDA94_TO_GDA2020} +units=m +no_defs +type=crs`);
  }
  register(proj4);
  // Valid area of each zone (6 degrees wide, Australia's latitude range), so OpenLayers can limit tiles.
  for (const zone of [54, 55, 56]) {
    for (const code of [`EPSG:78${zone}`, `EPSG:283${zone}`]) {
      const p = getProjection(code);
      if (!p) continue;
      const central = zone * 6 - 183;
      const sw = proj4('EPSG:4326', code, [central - 3, -45]);
      const ne = proj4('EPSG:4326', code, [central + 3, -9]);
      const nw = proj4('EPSG:4326', code, [central - 3, -9]);
      const se = proj4('EPSG:4326', code, [central + 3, -45]);
      p.setExtent([Math.min(sw[0], nw[0]), sw[1], Math.max(ne[0], se[0]), ne[1]]);
    }
  }
  registered = true;
}

export function projection(code: string): Projection {
  registerCrs();
  const p = getProjection(code);
  if (!p) throw new Error(`Unknown CRS ${code}`);
  return p;
}

/** Convert projected coordinates to [lon, lat]. */
export function toLonLat(code: string, xy: [number, number]): [number, number] {
  registerCrs();
  return proj4(code, 'EPSG:4326', xy) as [number, number];
}

/**
 * Rough check that an extent looks like MGA coordinates in Australia.
 * Returns a warning message, or null if it looks fine.
 */
export function checkExtentLooksLikeMga(extent: [number, number, number, number] | null): string | null {
  if (!extent) return null;
  const [minX, minY, maxX, maxY] = extent;
  const eastingOk = minX > 100_000 && maxX < 900_000;
  const northingOk = minY > 4_800_000 && maxY < 9_000_000;
  if (eastingOk && northingOk) return null;
  if (Math.abs(minX) <= 180 && Math.abs(maxY) <= 90) {
    return 'Coordinates look like latitude/longitude rather than MGA. The drawing will not line up with the imagery.';
  }
  return (
    'Drawing coordinates do not look like MGA eastings/northings (expected E 100,000-900,000, N 4,800,000-9,000,000). ' +
    'It may be on a local site grid, which needs a transformation before it will line up with the imagery.'
  );
}
