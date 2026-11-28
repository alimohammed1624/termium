// The scrollbar drawn in one cell column at the right edge of each pane.
// Positions along the track are in eighths of a cell, so the thumb can
// move smoothly using the lower eighth-block characters.

/** How far a page is scrolled, in CSS px. */
export interface ScrollMetrics {
  /** Scroll offset from the top. */
  y: number;
  /** Height of the viewport. */
  view: number;
  /** Height of the whole document. */
  total: number;
}

/** The thumb along a track, in eighths of a cell from the top. */
export interface Thumb {
  top: number;
  len: number;
}

/**
 * One cell of the bar. `fg` and `bg` name what the colours stand for
 * (the caller picks the colours). `mark` is a landmark, such as a
 * find-in-page match.
 */
export interface BarCell {
  ch: string;
  fg: "thumb" | "track" | "mark";
  bg: "thumb" | "track";
}

/**
 * Run in every new document (in termium's isolated world): hides the
 * browser's own scrollbar of the top document, which would sit next to
 * termium's. Only the viewport's: scroll boxes inside the page and frames
 * keep theirs. A constructed stylesheet, which a page's Content-Security-
 * Policy can't block and which adds nothing to the page's DOM.
 */
export const HIDE_PAGE_SCROLLBAR = `(() => {
  if (window !== window.top) return;
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(":root { scrollbar-width: none !important; }");
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  } catch {}
})();`;

/** Lower eighth blocks: LOWER[k] fills the bottom k/8 of a cell. */
const LOWER = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/** The page scrolls (by more than a pixel). */
export function scrolls(m: ScrollMetrics | null | undefined): m is ScrollMetrics {
  return !!m && m.view > 0 && m.total - m.view > 1;
}

/** Where the thumb sits on a track `rows` cells tall, or null if there's nothing to scroll. */
export function thumb(m: ScrollMetrics | null | undefined, rows: number): Thumb | null {
  if (!scrolls(m) || rows < 1) return null;
  const track = rows * 8;
  // At least a whole cell, so its two ends never fall in the same cell.
  const len = Math.min(track, Math.max(8, Math.round((track * m.view) / m.total)));
  const max = m.total - m.view;
  const top = Math.round(((track - len) * Math.max(0, Math.min(max, m.y))) / max);
  return { top, len };
}

/** The scroll offset that puts the thumb's top at `top` (eighths); unchanged if the thumb can't move. */
export function offsetFor(m: ScrollMetrics, rows: number, top: number): number {
  const t = thumb(m, rows);
  const room = rows * 8 - (t?.len ?? 0);
  if (!t || room <= 0) return m.y;
  const max = m.total - m.view;
  return Math.round((Math.max(0, Math.min(room, top)) * max) / room);
}

/**
 * An expression that scrolls the page's document: to `n` (CSS px), by `n`,
 * or by `n` pages (7/8 of the viewport, as a browser's track click). Relative
 * steps are worked out in the page, from where it is then. Nothing happens
 * while the page has locked scrolling (overflow hidden on the root, or on
 * the body when the root leaves it to the body), as the wheel does nothing then.
 */
export function scrollScript(how: "to" | "by" | "pages", n: number): string {
  const top = how === "to" ? `${n}` : how === "by" ? `scrollY + ${n}` : `scrollY + ${n} * innerHeight * 0.875`;
  return `(() => {
  const root = document.documentElement;
  const of = (e) => (e ? getComputedStyle(e).overflowY : "visible");
  const v = of(root) === "visible" ? of(document.body) : of(root);
  if (v === "hidden" || v === "clip") return;
  (document.scrollingElement || root).scrollTo({ top: ${top}, behavior: "instant" });
})()`;
}

/**
 * The bar's cells from top to bottom, or null if the page doesn't scroll.
 * `marks` are document positions (CSS px from the top) to show as landmarks.
 */
export function barCells(m: ScrollMetrics | null | undefined, rows: number, marks: readonly number[] = []): BarCell[] | null {
  const t = thumb(m, rows);
  if (!t) return null;
  const end = t.top + t.len;
  const cells: BarCell[] = [];
  for (let r = 0; r < rows; r++) {
    const a = r * 8;
    const b = a + 8;
    if (end <= a || t.top >= b) cells.push({ ch: " ", fg: "track", bg: "track" });
    else if (t.top <= a && end >= b) cells.push({ ch: " ", fg: "thumb", bg: "thumb" });
    // The thumb starts inside this cell: its lower part is thumb.
    else if (t.top > a) cells.push({ ch: LOWER[b - t.top]!, fg: "thumb", bg: "track" });
    // The thumb ends inside this cell: its upper part is thumb, so the
    // lower part is track drawn over a thumb-coloured cell.
    else cells.push({ ch: LOWER[b - end]!, fg: "track", bg: "thumb" });
  }
  for (const y of marks) {
    const r = Math.min(rows - 1, Math.max(0, Math.floor((y / m!.total) * rows)));
    const mid = r * 8 + 4;
    cells[r] = { ch: "━", fg: "mark", bg: mid >= t.top && mid < end ? "thumb" : "track" };
  }
  return cells;
}
