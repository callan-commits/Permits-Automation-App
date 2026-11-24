import TileLayer from 'ol/layer/Tile';
import OSM from 'ol/source/OSM';
import XYZ from 'ol/source/XYZ';

export type BasemapId = 'esri-imagery' | 'osm' | 'none';

export const BASEMAPS: { id: BasemapId; label: string }[] = [
  { id: 'esri-imagery', label: 'Aerial imagery (Esri World Imagery)' },
  { id: 'osm', label: 'Street map (OpenStreetMap)' },
  { id: 'none', label: 'None (dark background)' },
];

/**
 * Free basemaps for development. Imagery is reprojected by OpenLayers into the
 * drawing's MGA zone. Swap in Nearmap / Vicmap here once a licence is available.
 */
export function createBasemapLayer(id: BasemapId, className?: string): TileLayer | null {
  switch (id) {
    case 'esri-imagery':
      return new TileLayer({
        ...(className ? { className } : {}),
        source: new XYZ({
          url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
          maxZoom: 19,
          crossOrigin: 'anonymous',
          attributions: 'Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community',
        }),
      });
    case 'osm':
      return new TileLayer({ ...(className ? { className } : {}), source: new OSM({ crossOrigin: 'anonymous' }) });
    default:
      return null;
  }
}
