/**
 * Uniform grid spatial index over item bounding boxes.
 * Lets clicks and offset checks look at nearby objects only, instead of the whole drawing.
 */
export type BBox = [number, number, number, number];

export class SpatialGrid<T> {
  private cells = new Map<number, number[]>();
  private oversize: number[] = [];
  private readonly items: T[] = [];
  private readonly boxes: number[] = [];
  private readonly x0: number;
  private readonly y0: number;
  private readonly cols: number;

  /** @param extent overall extent of the data; @param cellSize grid cell size in map units */
  constructor(
    extent: BBox,
    private readonly cellSize: number,
    /** Items covering more cells than this go in an always-checked list. */
    private readonly maxCellsPerItem = 256,
  ) {
    this.x0 = extent[0];
    this.y0 = extent[1];
    this.cols = Math.max(1, Math.ceil((extent[2] - extent[0]) / cellSize) + 1);
  }

  get size(): number {
    return this.items.length;
  }

  private col(x: number) {
    return Math.floor((x - this.x0) / this.cellSize);
  }
  private row(y: number) {
    return Math.floor((y - this.y0) / this.cellSize);
  }

  insert(box: BBox, item: T): void {
    const idx = this.items.length;
    this.items.push(item);
    this.boxes.push(box[0], box[1], box[2], box[3]);
    const c0 = this.col(box[0]);
    const c1 = this.col(box[2]);
    const r0 = this.row(box[1]);
    const r1 = this.row(box[3]);
    if (!Number.isFinite(c0 + c1 + r0 + r1) || (c1 - c0 + 1) * (r1 - r0 + 1) > this.maxCellsPerItem) {
      this.oversize.push(idx);
      return;
    }
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const key = r * this.cols + c;
        const list = this.cells.get(key);
        if (list) list.push(idx);
        else this.cells.set(key, [idx]);
      }
    }
  }

  /** Items whose bounding box intersects `box`. */
  query(box: BBox): T[] {
    const seen = new Set<number>();
    const out: T[] = [];
    const test = (i: number) => {
      if (seen.has(i)) return;
      seen.add(i);
      const b = i * 4;
      const bx = this.boxes;
      if (bx[b] <= box[2] && bx[b + 2] >= box[0] && bx[b + 1] <= box[3] && bx[b + 3] >= box[1]) out.push(this.items[i]);
    };
    const c0 = this.col(box[0]);
    const c1 = this.col(box[2]);
    const r0 = this.row(box[1]);
    const r1 = this.row(box[3]);
    if ((c1 - c0 + 1) * (r1 - r0 + 1) > this.cells.size) {
      // Query covers more cells than exist: just scan everything.
      for (let i = 0; i < this.items.length; i++) test(i);
      return out;
    }
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const list = this.cells.get(r * this.cols + c);
        if (list) for (const i of list) test(i);
      }
    }
    for (const i of this.oversize) test(i);
    return out;
  }
}
