// Hover thumbnails: small copies of pages' frames for the tab preview, the
// space contact sheet and the spaces picker. Frames are scaled down once and
// cached; the cache is bounded both in entries and in bytes.

import { decodePng, encodeRegion, type Raster } from "./png";
import type { Rect } from "./layout";

/** Largest thumbnail, in pixels (the terminal scales it to its cells). */
export const THUMB_MAX_W = 384;
export const THUMB_MAX_H = 240;
/** How long the pointer rests on a tab or space before its preview shows. */
export const HOVER_DWELL_MS = 450;
/** Width of a tab's preview, in cells. */
export const PREVIEW_COLS = 40;
/** Most pictures in one contact sheet (the rest are counted as "+N more"). */
export const SHEET_MAX = 24;
/** The most base64 PNG bytes one thumbnail can take (incompressible pixels, plus headers). */
export const THUMB_WORST_BYTES = Math.ceil(((THUMB_MAX_W * 3 + 1) * THUMB_MAX_H * 1.01 + 1024) * 4 / 3);
/**
 * The cache holds two full sheets at their worst, so drawing one never
 * evicts a picture the same sheet shows (it would capture it again, and
 * evict another: round and round).
 */
export const CACHE_ENTRIES = SHEET_MAX * 2;
export const CACHE_BYTES = SHEET_MAX * 2 * THUMB_WORST_BYTES;
/** Thumbnails stack above the pages' pictures (z-index 0). */
export const THUMB_Z = 1;

/**
 * TERMIUM_THUMBNAILS: "off" shows no previews, "text" shows titles and
 * addresses only (no pictures); anything else shows pictures.
 */
export function thumbsMode(): "on" | "text" | "off" {
  const v = process.env.TERMIUM_THUMBNAILS;
  return v === "off" || v === "text" ? v : "on";
}

/** Area-averaged downscale to fit within maxW x maxH (never up); RGB out. */
export function downscale(r: Raster, maxW: number, maxH: number): Raster {
  const s = Math.min(1, maxW / r.width, maxH / r.height);
  const w = Math.max(1, Math.round(r.width * s));
  const h = Math.max(1, Math.round(r.height * s));
  const ch = r.channels;
  const src = r.data;
  const dst = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * r.height) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * r.height) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * r.width) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * r.width) / w));
      let red = 0, green = 0, blue = 0;
      for (let sy = y0; sy < y1; sy++) {
        let i = (sy * r.width + x0) * ch;
        for (let sx = x0; sx < x1; sx++, i += ch) {
          red += src[i]!;
          green += src[i + 1]!;
          blue += src[i + 2]!;
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (y * w + x) * 3;
      dst[o] = Math.round(red / n);
      dst[o + 1] = Math.round(green / n);
      dst[o + 2] = Math.round(blue / n);
    }
  }
  return { width: w, height: h, channels: 3, data: dst };
}

export interface Thumb {
  /** Base64 PNG. */
  png: string;
  w: number;
  h: number;
  /** The page's frameSeq it was made from, or -1 for a screenshot taken for it. */
  seq: number;
  /** When it was made (0: from a frame that may be old). */
  at: number;
}

/** Paints a border `px` wide around an RGB raster (so a white page stands out on another). */
export function frame(r: Raster, rgb: [number, number, number], px = 2): Raster {
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      if (x >= px && y >= px && x < r.width - px && y < r.height - px) continue;
      r.data.set(rgb, (y * r.width + x) * r.channels);
    }
  }
  return r;
}

/** Border of thumbnails (the UI's surface1). */
const FRAME: [number, number, number] = [0x45, 0x47, 0x5a];

/** A framed thumbnail of a base64 PNG frame, or null if it can't be decoded. */
export function makeThumb(base64Png: string, maxW = THUMB_MAX_W, maxH = THUMB_MAX_H): { png: string; w: number; h: number } | null {
  const r = decodePng(Buffer.from(base64Png, "base64"));
  if (!r) return null;
  const s = frame(downscale(r, maxW, maxH), FRAME);
  return { png: encodeRegion(s, 0, 0, s.width, s.height).toString("base64"), w: s.width, h: s.height };
}

/** Least recently used thumbnails go first, past maxEntries or maxBytes. */
export class ThumbCache<K> {
  private map = new Map<K, Thumb>();
  private size = 0;

  constructor(
    private maxEntries = CACHE_ENTRIES,
    private maxBytes = CACHE_BYTES,
  ) {}

  get(k: K): Thumb | undefined {
    const t = this.map.get(k);
    if (t) {
      this.map.delete(k);
      this.map.set(k, t);
    }
    return t;
  }

  set(k: K, t: Thumb): void {
    this.delete(k);
    this.map.set(k, t);
    this.size += t.png.length;
    while ((this.map.size > this.maxEntries || this.size > this.maxBytes) && this.map.size > 1) {
      this.delete(this.map.keys().next().value as K);
    }
  }

  delete(k: K): void {
    const t = this.map.get(k);
    if (!t) return;
    this.map.delete(k);
    this.size -= t.png.length;
  }

  get entries(): number {
    return this.map.size;
  }

  get bytes(): number {
    return this.size;
  }
}

/** The largest w x h cells inside `box` showing a picture of w x h pixels undistorted. */
export function fitCells(box: Rect, w: number, h: number, cellW: number, cellH: number): Rect {
  let cols = box.cols;
  let rows = Math.max(1, Math.round((cols * cellW * h) / w / cellH));
  if (rows > box.rows) {
    rows = box.rows;
    cols = Math.max(1, Math.min(box.cols, Math.round((rows * cellH * w) / h / cellW)));
  }
  return { col: box.col, row: box.row, cols, rows };
}

export interface SheetLayout {
  panel: Rect;
  /** Picture area of each tab shown (its title goes on the row below). */
  cells: Rect[];
  /** Tabs that didn't fit. */
  more: number;
}

/**
 * A contact sheet of n thumbnails in `area`: a panel with a header row,
 * then rows of pictures with a title under each, level with row `anchor`
 * where it fits (so the pointer can move straight across onto it). Null if
 * not even one fits (the caller lists the tabs as text instead).
 */
export function sheetLayout(area: Rect, n: number, cellW: number, cellH: number, anchor = area.row): SheetLayout | null {
  if (n < 1) return null;
  const gap = 2;
  const tw = Math.max(12, Math.min(30, Math.floor((area.cols - gap - 2) / Math.min(n, 3)) - gap));
  const th = Math.max(2, Math.round((tw * cellW * 10) / 16 / cellH));
  const perRow = Math.max(1, Math.min(n, 4, Math.floor((area.cols - 2) / (tw + gap))));
  const rowH = th + 2; // picture, title, gap
  const fitRows = Math.floor((area.rows - 2) / rowH); // under the header and a blank row
  if (fitRows < 1 || area.cols < tw + gap + 2) return null;
  // At most SHEET_MAX pictures, well under the cache's size: a sheet never evicts its own.
  const shown = Math.min(n, perRow * fitRows, SHEET_MAX);
  // ("+N more" goes on the last row: the gap under the last titles.)
  const lines = Math.ceil(shown / perRow);
  const rows = 2 + lines * rowH;
  const panel = {
    col: area.col,
    row: Math.max(area.row, Math.min(anchor - 1, area.row + area.rows - rows)),
    cols: Math.min(area.cols, perRow * (tw + gap) + gap),
    rows,
  };
  const cells: Rect[] = [];
  for (let i = 0; i < shown; i++) {
    const c = i % perRow;
    const r = Math.floor(i / perRow);
    cells.push({ col: panel.col + gap + c * (tw + gap), row: panel.row + 2 + r * rowH, cols: tw, rows: th });
  }
  return { panel, cells, more: n - shown };
}
