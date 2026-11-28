// Text-cell menus (context menus, dropdowns) and clickable areas for
// termium's own chrome. Pure layout and drawing: the app owns what the
// items do, where a menu opens and when it goes away.

import type { Rect } from "./layout";
import { fit, truncate, width } from "./text";

export interface MenuItem {
  label: string;
  /** The keybind that does the same thing, shown right-aligned (so people learn it). */
  key?: string;
  /** Greyed out and not clickable. */
  disabled?: boolean;
  run: () => void;
}

/** "-" draws a separator line. */
export type MenuEntry = MenuItem | "-";

export interface MenuStyle {
  /** Panel background and text. */
  panel: string;
  /** The highlighted row. */
  active: string;
  /** Keybind hints. */
  key: string;
  disabled: string;
  separator: string;
  title: string;
}

const RESET = "\x1b[0m";
const at = (row: number, col: number) => `\x1b[${row};${col}H`;

/**
 * A list of clickable rows with keybind hints, drawn in text cells over
 * whatever is below. It opens at a point (a context menu: its top-left
 * corner there, flipped to stay inside `bounds`) or under a button
 * (`align: "right"`: its right edge at the point). A menu taller than
 * `bounds` scrolls (wheel, arrows), with ▲/▼ marks where rows are hidden.
 */
export class Menu {
  readonly rect: Rect;
  /** The highlighted entry (keyboard or pointer), or -1. */
  active = -1;
  /** First entry shown (scrolled). */
  offset = 0;
  private readonly labelW: number;
  private readonly keyW: number;

  readonly title: string;

  constructor(
    readonly entries: MenuEntry[],
    point: { col: number; row: number },
    bounds: Rect,
    opts: { title?: string; align?: "left" | "right" } = {},
  ) {
    this.title = opts.title ?? "";
    const items = entries.filter((e): e is MenuItem => e !== "-");
    this.labelW = Math.max(0, ...items.map((i) => width(i.label)), width(this.title) - 1);
    this.keyW = Math.max(0, ...items.map((i) => (i.key ? width(i.key) : 0)));
    const wantW = 2 + this.labelW + (this.keyW ? 3 + this.keyW : 0) + 2;
    const cols = Math.max(1, Math.min(bounds.cols, wantW));
    // The title row (blank without a title) and a bottom row: both hold the scroll marks.
    const rows = Math.max(3, Math.min(bounds.rows, entries.length + 2));
    const right = bounds.col + bounds.cols; // first column past the bounds
    const bottom = bounds.row + bounds.rows;
    let col = opts.align === "right" ? point.col - cols + 1 : point.col;
    // A context menu that would run off the right flips to the pointer's left.
    if (col + cols > right) col = opts.align === "right" ? right - cols : Math.max(bounds.col, point.col - cols + 1);
    col = Math.max(bounds.col, Math.min(col, right - cols));
    let row = point.row;
    if (row + rows > bottom) row = point.row - rows + (opts.align === "right" ? 0 : 1);
    row = Math.max(bounds.row, Math.min(row, bottom - rows));
    this.rect = { col, row, cols, rows };
  }

  /** Entry rows that fit between the top and bottom rows. */
  get visible(): number {
    return Math.max(0, this.rect.rows - 2);
  }

  contains(col: number, row: number): boolean {
    const r = this.rect;
    return col >= r.col && col < r.col + r.cols && row >= r.row && row < r.row + r.rows;
  }

  /** The entry at a cell (a clickable item's index), or -1. */
  hit(col: number, row: number): number {
    if (!this.contains(col, row)) return -1;
    const i = this.offset + row - this.rect.row - 1;
    if (row === this.rect.row || i >= this.entries.length || i - this.offset >= this.visible) return -1;
    return this.enabled(i) ? i : -1;
  }

  item(i: number): MenuItem | null {
    return this.enabled(i) ? (this.entries[i] as MenuItem) : null;
  }

  private enabled(i: number): boolean {
    const e = this.entries[i];
    return !!e && e !== "-" && !e.disabled;
  }

  /** Moves the highlight by `delta` enabled items (wrapping), keeping it in view. */
  move(delta: number): void {
    const n = this.entries.length;
    if (!this.entries.some((_, i) => this.enabled(i))) return;
    let i = this.active < 0 ? (delta > 0 ? -1 : n) : this.active;
    do i = (i + delta + n) % n;
    while (!this.enabled(i));
    this.active = i;
    if (i < this.offset) this.offset = i;
    else if (i >= this.offset + this.visible) this.offset = i - this.visible + 1;
  }

  /** Scrolls by `delta` rows (a no-op when everything fits). */
  scroll(delta: number): void {
    this.offset = Math.max(0, Math.min(this.entries.length - this.visible, this.offset + delta));
    // A highlight scrolled out of view is dropped: Enter never runs what isn't shown.
    if (this.active < this.offset || this.active >= this.offset + this.visible) this.active = -1;
  }

  /** Keys while the menu is open: what to do (or null when the key isn't the menu's). */
  key(combo: string): { run: MenuItem } | "close" | "handled" | null {
    switch (combo) {
      case "arrowdown": case "j": case "tab": this.move(1); return "handled";
      case "arrowup": case "k": case "shift+tab": this.move(-1); return "handled";
      case "pagedown": this.scroll(this.visible); return "handled";
      case "pageup": this.scroll(-this.visible); return "handled";
      case "enter": case "space": {
        const item = this.item(this.active);
        return item ? { run: item } : "handled";
      }
      case "escape": return "close";
    }
    return null;
  }

  draw(style: MenuStyle): string {
    const { col, row, cols } = this.rect;
    const inner = Math.max(0, cols - 2);
    const more = (n: boolean, mark: string) => (n ? mark : " ");
    const above = this.offset > 0;
    const below = this.offset + this.visible < this.entries.length;
    let s = at(row, col) + style.panel + style.title + fit(` ${truncate(this.title, inner)}`, cols - 1) + style.panel + more(above, "▲") + RESET;
    for (let r = 0; r < this.visible; r++) {
      const i = this.offset + r;
      const e = this.entries[i];
      s += at(row + 1 + r, col);
      if (e === undefined) {
        s += style.panel + " ".repeat(cols) + RESET;
      } else if (e === "-") {
        s += style.panel + " " + style.separator + "─".repeat(inner) + style.panel + " " + RESET;
      } else {
        const keyText = e.key ? truncate(e.key, Math.max(0, inner - 4)) : "";
        const labelRoom = Math.max(0, inner - (keyText ? width(keyText) + 2 : 0));
        const label = fit(` ${truncate(e.label, Math.max(0, labelRoom - 1))}`, labelRoom);
        const base = i === this.active && !e.disabled ? style.active : style.panel + (e.disabled ? style.disabled : "");
        s += base + " " + label + (keyText ? "  " + (i === this.active ? "" : style.key) + keyText : "") + base;
        s += " ".repeat(Math.max(0, cols - 1 - width(label) - (keyText ? 2 + width(keyText) : 0))) + RESET;
      }
    }
    s += at(row + this.rect.rows - 1, col) + style.panel + " ".repeat(cols - 1) + more(below, "▼") + RESET;
    return s;
  }
}

/**
 * Clickable cell ranges registered while the chrome is drawn (cleared at
 * the start of each draw), so what's clickable is exactly what's on screen.
 */
export class ClickAreas {
  private areas: { row: number; col: number; cols: number; on: (button: number) => void }[] = [];

  clear(): void {
    this.areas = [];
  }

  /** `on` gets the mouse button (0 left, 1 middle, 2 right). */
  add(row: number, col: number, cols: number, on: (button: number) => void): void {
    if (cols > 0) this.areas.push({ row, col, cols, on });
  }

  /** Runs the area under (col, row); false if there is none. The newest area wins where they overlap. */
  click(col: number, row: number, button: number): boolean {
    for (let i = this.areas.length - 1; i >= 0; i--) {
      const a = this.areas[i]!;
      if (a.row === row && col >= a.col && col < a.col + a.cols) {
        a.on(button);
        return true;
      }
    }
    return false;
  }
}

/**
 * The parts of `r` left showing around `hole` (at most four rectangles):
 * a picture drawn around an open menu, so the menu's text isn't covered.
 */
export function around(r: Rect, hole: Rect): Rect[] {
  const c0 = Math.max(r.col, hole.col);
  const c1 = Math.min(r.col + r.cols, hole.col + hole.cols);
  const r0 = Math.max(r.row, hole.row);
  const r1 = Math.min(r.row + r.rows, hole.row + hole.rows);
  if (c0 >= c1 || r0 >= r1) return [r];
  const out: Rect[] = [
    { col: r.col, row: r.row, cols: r.cols, rows: r0 - r.row },
    { col: r.col, row: r1, cols: r.cols, rows: r.row + r.rows - r1 },
    { col: r.col, row: r0, cols: c0 - r.col, rows: r1 - r0 },
    { col: c1, row: r0, cols: r.col + r.cols - c1, rows: r1 - r0 },
  ];
  return out.filter((p) => p.cols > 0 && p.rows > 0);
}

/**
 * Injected into every page in termium's isolated world (with the select
 * popup): remembers the last right-click, whether the page handled it
 * (called preventDefault, to show its own menu), and what was under it.
 * termium reads it after a right-click to decide whether to show its own
 * page menu. Pages can't see or change it.
 */
export const CONTEXT_PROBE = String.raw`(() => {
  if (window.__termiumContext) return;
  let last = null;
  addEventListener("contextmenu", (e) => {
    const t = e.composedPath()[0];
    const el = t && t.nodeType === 1 ? t : t && t.parentElement;
    // Once every listener has run: whether the page took the right-click for itself.
    setTimeout(() => {
      const a = el && el.closest ? el.closest("a[href], area[href]") : null;
      last = { prevented: e.defaultPrevented, link: a ? a.href : "", selection: String(getSelection()).length > 0 };
    });
  }, true);
  // Each right-click is answered once: reading it forgets it.
  window.__termiumContext = () => { const l = last; last = null; return l; };
})()`;
