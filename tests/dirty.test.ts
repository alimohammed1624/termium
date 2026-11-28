import { describe, expect, test } from "bun:test";
import { changedTiles, pngSize, tileCells, tileCount } from "../src/dirty";
import { encodeRegion } from "../src/png";
import type { Raster } from "../src/png";

function raster(w: number, h: number, channels: 3 | 4 = 3): Raster {
  return { width: w, height: h, channels, data: new Uint8Array(w * h * channels) };
}

function set(r: Raster, x: number, y: number, v: number): void {
  r.data[(y * r.width + x) * r.channels] = v;
}

describe("changed tiles", () => {
  // 10x20 px cells: tiles of 6x3 cells (60x60 px); a 20x7 cell pane is 4x3 tiles.
  const cols = 20, rows = 7, cw = 10, ch = 20;

  test("tile size is about 64 px of whole cells", () => {
    expect(tileCells(10, 20)).toEqual({ cols: 6, rows: 3 });
    expect(tileCells(8, 16)).toEqual({ cols: 8, rows: 4 });
    expect(tileCells(200, 200)).toEqual({ cols: 1, rows: 1 });
    expect(tileCount(cols, rows, cw, ch)).toBe(12);
  });

  test("identical frames: nothing changed", () => {
    expect(changedTiles(raster(200, 140), raster(200, 140), cols, rows, cw, ch)).toEqual([]);
  });

  test("one pixel changed: just its tile, in cells and pixels", () => {
    const a = raster(200, 140);
    const b = raster(200, 140);
    set(b, 65, 70, 255); // tile column 1, tile row 1
    expect(changedTiles(a, b, cols, rows, cw, ch)).toEqual([
      { index: 5, x: 60, y: 60, w: 60, h: 60, col: 6, row: 3, cols: 6, rows: 3 },
    ]);
  });

  test("edge tiles are cut to the pane", () => {
    const a = raster(200, 140, 4);
    const b = raster(200, 140, 4);
    set(b, 199, 139, 1);
    expect(changedTiles(a, b, cols, rows, cw, ch)).toEqual([
      { index: 11, x: 180, y: 120, w: 20, h: 20, col: 18, row: 6, cols: 2, rows: 1 },
    ]);
  });

  test("frames that don't match the grid or each other can't be compared", () => {
    expect(changedTiles(raster(200, 140), raster(201, 140), cols, rows, cw, ch)).toBeNull();
    expect(changedTiles(raster(200, 140), raster(200, 140, 4), cols, rows, cw, ch)).toBeNull();
    // Stretched (another DevTools client holds the page at its own size).
    expect(changedTiles(raster(180, 140), raster(180, 140), cols, rows, cw, ch)).toBeNull();
  });

  test("a PNG's size from its header", () => {
    const png = encodeRegion(raster(200, 140), 0, 0, 200, 140).toString("base64");
    expect(pngSize(png)).toEqual({ w: 200, h: 140 });
    expect(pngSize("bm90IGEgUE5H")).toBeNull();
  });
});
