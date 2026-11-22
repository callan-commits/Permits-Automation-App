/** Geometry extracted from a CAD drawing, still in the drawing's own coordinates (e.g. MGA2020). */

export type XY = [number, number];

export interface CadFeatureBase {
  layer: string;
  color: string; // hex
  entityType: string; // CAD entity type, e.g. LWPOLYLINE
  handle: string;
  /** Name of the block this came from, if it was expanded from an INSERT. */
  block?: string;
}

export interface CadLine extends CadFeatureBase {
  kind: 'line';
  coords: XY[];
  /** Elevations per vertex where the source carried them (3D polylines etc.). */
  z?: number[];
}

export interface CadPolygon extends CadFeatureBase {
  kind: 'polygon';
  rings: XY[][];
}

export interface CadPoint extends CadFeatureBase {
  kind: 'point';
  coord: XY;
}

export interface CadText extends CadFeatureBase {
  kind: 'text';
  coord: XY;
  text: string;
  /** Text height in drawing units (metres). */
  height: number;
  /** Rotation in radians, counter-clockwise from east (CAD convention). */
  rotation: number;
  hAlign: 'left' | 'center' | 'right';
  vAlign: 'top' | 'middle' | 'bottom' | 'baseline';
}

export type CadFeature = CadLine | CadPolygon | CadPoint | CadText;

export interface CadLayer {
  name: string;
  color: string;
  /** Layer was off or frozen in the drawing. */
  hiddenInDrawing: boolean;
  featureCount: number;
}

export interface CadDrawing {
  fileName: string;
  layers: CadLayer[];
  features: CadFeature[];
  /** [minX, minY, maxX, maxY] in drawing units, or null if empty. */
  extent: [number, number, number, number] | null;
  /** Extent of the bulk of the drawing, ignoring stray far-away objects (e.g. blocks left at 0,0). */
  focusExtent: [number, number, number, number] | null;
  /** Entity types that were present but not drawn, with counts. */
  skipped: Record<string, number>;
  /** Non-fatal messages for the user. */
  warnings: string[];
  /** DXF INSUNITS header value (6 = metres). */
  insUnits?: number;
}
