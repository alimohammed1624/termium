// Changed regions between two frames (issue #5): a frame is cut into tiles
// of whole cells, and only the tiles whose pixels changed are sent, as
// small pictures placed over the last full frame.

import type { Raster } from "./png";

/** About 64 px each way, in whole cells (patches sit on the cell grid). */
export function tileCells(cellW: number, cellH: number): { cols: number; rows: number } {
  return { cols: Math.max(1, Math.round(64 / Math.max(1, cellW))), rows: Math.max(1, Math.round(64 / Math.max(1, cellH))) };
}

export interface Tile {
  /** Index in the grid, row-major: a tile keeps its index from frame to frame. */
  index: number;
  /** Pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Cells, from the frame's top-left. */
  col: number;
  row: number;
  cols: number;
  rows: number;
}

/**
 * The tiles of a cols x rows cell grid (cellW x cellH px each) whose pixels
 * differ between `a` and `b`, or null if the two can't be compared (another
 * size or format, or not exactly the grid's size in pixels).
 */
export function changedTiles(a: Raster, b: Raster, cols: number, rows: number, cellW: number, cellH: number): Tile[] | null {
  if (a.width !== b.width || a.height !== b.height || a.channels !== b.channels) return null;
  if (a.width !== cols * cellW || a.height !== rows * cellH) return null;
  const t = tileCells(cellW, cellH);
  const nx = Math.ceil(cols / t.cols);
  const ny = Math.ceil(rows / t.rows);
  const stride = a.width * a.channels;
  const out: Tile[] = [];
  const changed = new Uint8Array(nx);
  for (let ty = 0; ty < ny; ty++) {
    const row = ty * t.rows;
    const trows = Math.min(t.rows, rows - row);
    const y0 = row * cellH;
    const y1 = y0 + trows * cellH;
    changed.fill(0);
    let left = nx;
    for (let y = y0; y < y1 && left > 0; y++) {
      // Whole rows first: most are unchanged, and one compare says so.
      if (sameBytes(a.data, b.data, y * stride, stride)) continue;
      for (let tx = 0; tx < nx; tx++) {
        if (changed[tx]) continue;
        const x0 = tx * t.cols * cellW * a.channels;
        const len = Math.min(t.cols, cols - tx * t.cols) * cellW * a.channels;
        if (!sameBytes(a.data, b.data, y * stride + x0, len)) {
          changed[tx] = 1;
          left--;
        }
      }
    }
    for (let tx = 0; tx < nx; tx++) {
      if (!changed[tx]) continue;
      const col = tx * t.cols;
      const tcols = Math.min(t.cols, cols - col);
      out.push({ index: ty * nx + tx, x: col * cellW, y: y0, w: tcols * cellW, h: trows * cellH, col, row, cols: tcols, rows: trows });
    }
  }
  return out;
}

/** A base64 PNG's size from its header, without decoding it (null if it isn't one). */
export function pngSize(base64Png: string): { w: number; h: number } | null {
  const head = Buffer.from(base64Png.slice(0, 44), "base64");
  if (head.length < 24 || head.readUInt32BE(12) !== 0x49484452) return null; // "IHDR"
  return { w: head.readUInt32BE(16), h: head.readUInt32BE(20) };
}

/** How many tiles a cols x rows grid has. */
export function tileCount(cols: number, rows: number, cellW: number, cellH: number): number {
  const t = tileCells(cellW, cellH);
  return Math.ceil(cols / t.cols) * Math.ceil(rows / t.rows);
}

function sameBytes(a: Uint8Array, b: Uint8Array, o: number, len: number): boolean {
  return Buffer.compare(a.subarray(o, o + len), b.subarray(o, o + len)) === 0;
}
