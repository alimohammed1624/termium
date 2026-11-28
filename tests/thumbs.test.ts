import { describe, expect, test } from "bun:test";
import { decodePng, encodeRegion, type Raster } from "../src/png";
import { SHEET_MAX, THUMB_MAX_H, THUMB_MAX_W, THUMB_WORST_BYTES, ThumbCache, downscale, fitCells, makeThumb, sheetLayout } from "../src/thumbs";

function solid(width: number, height: number, rgba: [number, number, number, number]): Raster {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(rgba, i * 4);
  return { width, height, channels: 4, data };
}

describe("downscale", () => {
  test("fits the box, keeps the aspect and averages colours", () => {
    const r = solid(1600, 1000, [200, 100, 50, 255]);
    const s = downscale(r, 320, 320);
    expect(s.width).toBe(320);
    expect(s.height).toBe(200);
    expect(s.channels).toBe(3);
    expect([...s.data.subarray(0, 3)]).toEqual([200, 100, 50]);
  });

  test("averages a checkerboard to grey and never scales up", () => {
    const r: Raster = { width: 2, height: 2, channels: 3, data: new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 0]) };
    expect([...downscale(r, 1, 1).data]).toEqual([128, 128, 128]);
    const small = downscale(r, 100, 100);
    expect([small.width, small.height]).toEqual([2, 2]);
  });
});

test("makeThumb turns a big frame into a small PNG", () => {
  const frame = encodeRegion(solid(2560, 1440, [10, 20, 30, 255]), 0, 0, 2560, 1440).toString("base64");
  const t = makeThumb(frame)!;
  expect(t.w).toBeLessThanOrEqual(THUMB_MAX_W);
  expect(t.h).toBeLessThanOrEqual(THUMB_MAX_H);
  const back = decodePng(Buffer.from(t.png, "base64"))!;
  expect([back.width, back.height]).toEqual([t.w, t.h]);
  expect([...back.data.subarray(0, 3)]).toEqual([0x45, 0x47, 0x5a]); // the frame
  const mid = (Math.floor(t.h / 2) * t.w + Math.floor(t.w / 2)) * 3;
  expect([...back.data.subarray(mid, mid + 3)]).toEqual([10, 20, 30]);
  expect(makeThumb("bm90IGEgcG5n")).toBeNull();
});

describe("ThumbCache", () => {
  const thumb = (n: number) => ({ png: "x".repeat(n), w: 1, h: 1, seq: 0, at: 0 });

  test("evicts the least recently used past the entry limit", () => {
    const c = new ThumbCache<string>(2, 1 << 20);
    c.set("a", thumb(1));
    c.set("b", thumb(1));
    c.get("a");
    c.set("c", thumb(1));
    expect(c.get("b")).toBeUndefined();
    expect(c.get("a")).toBeDefined();
    expect(c.entries).toBe(2);
  });

  test("evicts past the byte limit and keeps the count right", () => {
    const c = new ThumbCache<string>(10, 100);
    c.set("a", thumb(60));
    c.set("b", thumb(60));
    expect(c.get("a")).toBeUndefined();
    expect(c.bytes).toBe(60);
    c.set("b", thumb(30));
    expect(c.bytes).toBe(30);
    c.delete("b");
    expect([c.entries, c.bytes]).toEqual([0, 0]);
  });
});

test("the cache holds two whole sheets of the largest thumbnails", () => {
  // Noise doesn't compress: the biggest a thumbnail gets.
  const noise: Raster = { width: 1920, height: 1200, channels: 3, data: new Uint8Array(1920 * 1200 * 3) };
  for (let i = 0; i < noise.data.length; i++) noise.data[i] = (i * 2654435761) >>> 24 ^ (i * 40503) & 0xff;
  const t = makeThumb(encodeRegion(noise, 0, 0, 1920, 1200).toString("base64"))!;
  expect([t.w, t.h]).toEqual([THUMB_MAX_W, THUMB_MAX_H]);
  expect(t.png.length).toBeGreaterThan(THUMB_WORST_BYTES * 0.8); // really incompressible
  expect(t.png.length).toBeLessThanOrEqual(THUMB_WORST_BYTES);
  const c = new ThumbCache<number>();
  for (let i = 0; i < SHEET_MAX * 2; i++) c.set(i, { ...t, seq: 0, at: 0 });
  for (let i = 0; i < SHEET_MAX * 2; i++) expect(c.get(i)).toBeDefined();
});

test("fitCells keeps the picture undistorted inside the box", () => {
  // 16:10 picture in a 40x16 box of 10x20 cells: 40 cols x 12.5 rows -> 13 rows.
  expect(fitCells({ col: 5, row: 3, cols: 40, rows: 16 }, 320, 200, 10, 20)).toEqual({ col: 5, row: 3, cols: 40, rows: 13 });
  // Too tall: limited by rows.
  expect(fitCells({ col: 1, row: 1, cols: 40, rows: 5 }, 320, 200, 10, 20)).toEqual({ col: 1, row: 1, cols: 16, rows: 5 });
});

describe("sheetLayout", () => {
  const area = { col: 23, row: 3, cols: 138, rows: 43 };

  test("lays tabs out in rows inside the area, level with the anchor", () => {
    const l = sheetLayout(area, 5, 10, 20, 8)!;
    expect(l.more).toBe(0);
    expect(l.cells.length).toBe(5);
    expect(l.panel.col).toBe(area.col);
    expect(l.panel.row).toBeLessThanOrEqual(8);
    expect(l.panel.row + l.panel.rows).toBeGreaterThan(8);
    for (const c of l.cells) {
      expect(c.col).toBeGreaterThanOrEqual(l.panel.col);
      expect(c.col + c.cols).toBeLessThanOrEqual(l.panel.col + l.panel.cols);
      expect(c.row + c.rows).toBeLessThan(l.panel.row + l.panel.rows); // title row fits
      expect(c.row + c.rows).toBeLessThanOrEqual(area.row + area.rows);
    }
  });

  test("counts tabs that don't fit, and gives up when nothing fits", () => {
    const l = sheetLayout({ col: 1, row: 3, cols: 80, rows: 22 }, 40, 10, 20)!;
    expect(l.more).toBe(40 - l.cells.length);
    expect(l.more).toBeGreaterThan(0);
    expect(l.panel.rows).toBeLessThanOrEqual(22);
    expect(sheetLayout({ col: 1, row: 3, cols: 80, rows: 5 }, 3, 10, 20)).toBeNull();
    expect(sheetLayout(area, 0, 10, 20)).toBeNull();
  });
});
