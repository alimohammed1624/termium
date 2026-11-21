// Small text helpers: URL guessing, display-width-aware truncation and a
// single-line editor used for the URL bar and other prompts.

import type { KeyEvent } from "./input";

export const DEFAULT_SEARCH = "https://duckduckgo.com/?q=%s";

/** Turns what the user typed into a URL: a URL, a bare host, or a search. */
export function toUrl(input: string, search = DEFAULT_SEARCH): string | null {
  const s = input.trim();
  if (!s) return null;
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?([/?#].*)?$/i.test(s)) return `http://${s}`;
  if (/^(https?|file|about|chrome|data|view-source|ftp):/i.test(s)) return s;
  if (!/\s/.test(s) && /^[^\s/?#:]+\.[a-z][a-z0-9-]*\.?(:\d+)?([/?#].*)?$/i.test(s)) return `https://${s}`;
  if (!/\s/.test(s) && /^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
  return search.replace("%s", encodeURIComponent(s));
}

const segmenter = new Intl.Segmenter();

export function width(s: string): number {
  return Bun.stringWidth(s);
}

/** Cuts `s` to at most `max` display columns, adding an ellipsis when it had to cut. */
export function truncate(s: string, max: number): string {
  if (max <= 0) return "";
  if (width(s) <= max) return s;
  let outStr = "";
  let w = 0;
  for (const { segment } of segmenter.segment(s)) {
    const sw = width(segment);
    if (w + sw > max - 1) break;
    outStr += segment;
    w += sw;
  }
  return outStr + "…";
}

/** Truncates or pads `s` to exactly `n` display columns. */
export function fit(s: string, n: number): string {
  const t = truncate(s.replace(/[\x00-\x1f\x7f]/g, " "), n);
  return t + " ".repeat(Math.max(0, n - width(t)));
}

export class LineEdit {
  cursor: number;
  selectAll: boolean;

  constructor(
    public text: string,
    selectAll = true,
  ) {
    this.cursor = text.length;
    this.selectAll = selectAll && text.length > 0;
  }

  insert(s: string): void {
    const clean = s.replace(/[\r\n\t]+/g, " ").replace(/[\x00-\x1f\x7f]/g, "");
    if (this.selectAll) {
      this.text = "";
      this.cursor = 0;
      this.selectAll = false;
    }
    this.text = this.text.slice(0, this.cursor) + clean + this.text.slice(this.cursor);
    this.cursor += clean.length;
  }

  private prevBoundary(): number {
    let prev = 0;
    for (const { index } of segmenter.segment(this.text)) {
      if (index >= this.cursor) break;
      prev = index;
    }
    return prev;
  }

  private nextBoundary(): number {
    for (const { index, segment } of segmenter.segment(this.text)) {
      if (index >= this.cursor) return index + segment.length;
    }
    return this.text.length;
  }

  private wordLeft(): number {
    let i = this.cursor;
    while (i > 0 && /\s/.test(this.text[i - 1]!)) i--;
    while (i > 0 && !/[\s/.?=&:#-]/.test(this.text[i - 1]!)) i--;
    return i === this.cursor && i > 0 ? i - 1 : i;
  }

  private wordRight(): number {
    let i = this.cursor;
    while (i < this.text.length && /[\s/.?=&:#-]/.test(this.text[i]!)) i++;
    while (i < this.text.length && !/[\s/.?=&:#-]/.test(this.text[i]!)) i++;
    return i;
  }

  /** Handles a key press; returns "submit", "cancel" or null. */
  key(ev: KeyEvent): "submit" | "cancel" | null {
    if (ev.event === "release") return null;
    const { ctrl, alt } = ev.mods;
    const k = ev.key;
    const hadSelection = this.selectAll;
    const clearSel = () => (this.selectAll = false);

    if (k === "Enter") return "submit";
    if (k === "Escape") return "cancel";

    if (hadSelection && (k === "Backspace" || k === "Delete" || (ctrl && (k === "u" || k === "k")))) {
      this.text = "";
      this.cursor = 0;
      clearSel();
      return null;
    }
    if (k === "ArrowLeft" || (ctrl && k === "b")) {
      clearSel();
      this.cursor = ctrl || alt ? this.wordLeft() : hadSelection ? 0 : this.prevBoundary();
    } else if (k === "ArrowRight" || (ctrl && k === "f")) {
      clearSel();
      this.cursor = ctrl || alt ? this.wordRight() : this.nextBoundary();
    } else if (k === "Home" || (ctrl && k === "a")) {
      clearSel();
      this.cursor = 0;
    } else if (k === "End" || (ctrl && k === "e")) {
      clearSel();
      this.cursor = this.text.length;
    } else if (k === "Backspace") {
      const to = ctrl || alt ? this.wordLeft() : this.prevBoundary();
      this.text = this.text.slice(0, to) + this.text.slice(this.cursor);
      this.cursor = to;
    } else if (ctrl && k === "w") {
      const to = this.wordLeft();
      this.text = this.text.slice(0, to) + this.text.slice(this.cursor);
      this.cursor = to;
    } else if (k === "Delete" || (ctrl && k === "d")) {
      const to = this.nextBoundary();
      this.text = this.text.slice(0, this.cursor) + this.text.slice(to);
    } else if (ctrl && k === "u") {
      this.text = this.text.slice(this.cursor);
      this.cursor = 0;
    } else if (ctrl && k === "k") {
      this.text = this.text.slice(0, this.cursor);
    } else if (ev.text && !ctrl && !alt && !ev.mods.meta) {
      this.insert(ev.text);
    }
    return null;
  }

  /**
   * The visible slice for a field `n` columns wide, and where the cursor sits
   * in it (0-based column).
   */
  view(n: number): { text: string; cursorCol: number } {
    if (n <= 0) return { text: "", cursorCol: 0 };
    const before = this.text.slice(0, this.cursor);
    const after = this.text.slice(this.cursor);
    let shownBefore = before;
    while (width(shownBefore) > n - 1) {
      shownBefore = shownBefore.slice(Math.max(1, Math.ceil(shownBefore.length / 8)));
    }
    const cursorCol = width(shownBefore);
    const shown = truncate(shownBefore + after, n);
    return { text: shown, cursorCol };
  }
}
