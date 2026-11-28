// Toasts: short notes stacked in the bottom-right corner of the pages, each
// with a line along its bottom that shrinks until the toast goes. Hovering
// one pauses its timer; clicking it dismisses it (or runs its action).
import type { Rect } from "./layout";
import { truncate, width } from "./text";

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: number;
  text: string;
  /** Its full time, ms. */
  ms: number;
  /** Time left when the timer last (re)started or paused, ms. */
  left: number;
  /** When the timer last started; null while paused (hovered). */
  since: number | null;
  action?: ToastAction;
}

/** Where a toast is drawn: rows of text, then its timer line. */
export interface ToastBox {
  toast: Toast;
  row: number;
  col: number;
  cols: number;
  rows: number;
  lines: string[];
  /** What ends the first row: the action's label as shown ("" if none), then the close mark. */
  action: string;
  close: string;
  /** Columns [start, end) of the action label on the first row. */
  actionHit: [number, number] | null;
}

export const TOAST_MAX_COLS = 60;
export const TOAST_MAX_LINES = 3;
/** Most toasts kept at once; the oldest goes when another comes. */
export const TOAST_MAX = 5;
const CLOSE = " ✕ ";


export function remaining(t: Toast, now: number): number {
  return t.since === null ? t.left : t.left - (now - t.since);
}

export function pause(t: Toast, now: number): void {
  if (t.since === null) return;
  t.left = remaining(t, now);
  t.since = null;
}

export function resume(t: Toast, now: number): void {
  if (t.since !== null) return;
  t.since = now;
}

/** Wraps text at spaces into lines at most `max` columns wide; past `most` lines, the last ends with "…". */
export function wrap(text: string, max: number, most: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (let word of text.replace(/\s+/g, " ").trim().split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (width(next) <= max) {
      line = next;
      continue;
    }
    if (line) lines.push(line);
    // A word longer than a line is cut over several.
    while (width(word) > max) {
      let cut = "";
      for (const ch of word) {
        if (width(cut + ch) > max) break;
        cut += ch;
      }
      if (!cut) break;
      lines.push(cut);
      word = word.slice(cut.length);
    }
    line = word;
  }
  if (line) lines.push(line);
  if (lines.length <= most) return lines;
  const kept = lines.slice(0, most);
  kept[most - 1] = truncate(`${kept[most - 1]} ${lines[most]}`, max);
  return kept;
}

/**
 * Lays toasts out in the bottom-right corner of `area`, the newest at the
 * bottom, older ones above; those that don't fit aren't shown.
 */
export function layoutToasts(toasts: Toast[], area: Rect, margin: number): ToastBox[] {
  const boxes: ToastBox[] = [];
  const maxCols = Math.min(TOAST_MAX_COLS, area.cols - margin);
  if (maxCols < 12 || area.rows < 2) return boxes;
  const right = area.col + area.cols - margin; // one past the last column
  let bottom = area.row + area.rows - 1; // last row free for a toast
  for (let i = toasts.length - 1; i >= 0; i--) {
    const t = toasts[i]!;
    // The label gets at most half the room, the text the rest.
    const action = t.action ? ` ${truncate(t.action.label, Math.floor((maxCols - 1 - width(CLOSE)) / 2) - 2)} ` : "";
    const close = CLOSE;
    const tail = action + close;
    const textMax = maxCols - 1 - width(tail);
    const lines = wrap(t.text, Math.max(4, textMax), TOAST_MAX_LINES);
    const cols = Math.min(maxCols, 1 + Math.max(...lines.map(width)) + width(tail));
    const rows = lines.length + 1;
    const row = bottom - rows + 1;
    if (row < area.row) break;
    const col = right - cols;
    const actionStart = col + cols - width(tail);
    boxes.push({
      toast: t,
      row,
      col,
      cols,
      rows,
      lines,
      action,
      close,
      actionHit: action ? [actionStart, actionStart + width(action)] : null,
    });
    bottom = row - 2; // a blank row between toasts
  }
  return boxes;
}

/**
 * The timer line: a thin line `fraction` of `cols` columns long, padded
 * with spaces. A full-height bar in eighths of a column would shrink more
 * finely, but it's a block, not a line; a toast is at most 60 columns
 * across, so a column at a time still goes smoothly.
 */
export function timerBar(fraction: number, cols: number): string {
  const n = Math.ceil(Math.max(0, Math.min(1, fraction)) * cols);
  return "▂".repeat(n) + " ".repeat(cols - n);
}
