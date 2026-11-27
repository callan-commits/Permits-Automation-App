/** Geometry extracted from a CAD drawing, still in the drawing's own coordinates (e.g. MGA2020). */

export type XY = [number, number];

/**
 * Non-graphical data carried by a CAD object. For geometry and labels that come from a block,
 * this includes the block insert's data (e.g. a pit's OWNER / PIT_ID / RL attributes).
 * The same object is shared by every feature from one entity or block insert.
 */
export interface CadMeta {
  /** Block attribute values by tag, including invisible attributes. */
  attributes?: Record<string, string>;
  /** Extended entity data (XDATA) by application name, values in order. */
  xdata?: Record<string, (string | number)[]>;
  /** Extension dictionary records (XRECORD) by name, values in order. */
  records?: Record<string, (string | number)[]>;
  /** KEY=VALUE pairs found in XDATA and records, collected for convenience. */
  fields?: Record<string, string>;
  /** Linetype set on the object (not ByLayer). */
  lineType?: string;
  /** Elevation (Z / RL) of a flat object, point or block insertion point. */
  elevation?: number;
  /** For objects drawn from a block: where the block was inserted (map coordinates). */
  insertAt?: XY;
  /** Handle of the block insert the data came from, when it was inherited. */
  insertHandle?: string;
}

export interface CadFeatureBase {
  layer: string;
  color: string; // hex
  entityType: string; // CAD entity type, e.g. LWPOLYLINE
  handle: string;
  /** Name of the block this came from, if it was expanded from an INSERT. */
  block?: string;
  meta?: CadMeta;
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
