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

/** C0 and C1 control characters: page-supplied text must never reach the terminal as controls. */
const CONTROLS = /[\x00-\x1f\x7f-\x9f]/g;

/** Splits "a b 'c d' e\\ f" into paths, honouring quotes and backslash escapes. */
export function splitPaths(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let any = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      any = true;
    } else if (ch === "\\" && i + 1 < s.length) {
      cur += s[++i];
      any = true;
    } else if (/\s/.test(ch)) {
      if (cur || any) out.push(cur);
      cur = "";
      any = false;
    } else {
      cur += ch;
    }
  }
  if (cur || any) out.push(cur);
  return out;
}

export function width(s: string): number {
  return Bun.stringWidth(s);
}

/** Cuts `s` to at most `max` display columns, adding an ellipsis when it had to cut. */
export function truncate(s: string, max: number): string {
  if (max <= 0) return "";
  s = s.replace(CONTROLS, " ");
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
  const t = truncate(s, n);
  return t + " ".repeat(Math.max(0, n - width(t)));
}

/** Between a title and the part of its URL that tells it apart. */
const TITLE_SEP = " · ";
/** Columns of the title kept before a long distinguishing part is cut instead. */
const MIN_TITLE = 8;

/**
 * Parts of a URL that can tell it apart: host (and its labels), port and path segments first,
 * then query and fragment. `whole` is the URL as shown, `id` the URL itself.
 */
function urlParts(url: string): { parts: string[]; extra: string[]; whole: string; id: string } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { parts: [], extra: [], whole: "", id: "" };
  }
  const clean = (s: string) => {
    try {
      s = decodeURIComponent(s);
    } catch {}
    return s.replace(CONTROLS, "");
  };
  const host = u.hostname.replace(/^www\./, "");
  const parts: string[] = [host, u.hostname];
  // A name's labels (not the top-level one): "eu" in eu.example.com.
  if (!/^[\d.]+$|^\[/.test(host)) parts.push(...host.split(".").slice(0, -1));
  if (u.port) parts.push(`:${u.port}`, `${host}:${u.port}`);
  for (const seg of u.pathname.split("/")) parts.push(clean(seg));
  const whole = clean(u.host + u.pathname.replace(/\/$/, "") + u.search + u.hash);
  return { parts: parts.filter(Boolean), extra: [clean(u.search), clean(u.hash)].filter(Boolean), whole, id: u.href };
}

/** `title · suffix` in at most `max` columns; the title gives way first, down to MIN_TITLE. */
function withSuffix(title: string, suffix: string, max: number, keepEnd: boolean): string {
  const tw = width(title.replace(CONTROLS, " "));
  const titleRoom = Math.max(Math.min(tw, MIN_TITLE), max - width(TITLE_SEP) - width(suffix));
  const suffixRoom = max - width(TITLE_SEP) - titleRoom;
  if (suffixRoom < Math.min(2, width(suffix))) return truncate(title, max);
  let tail = suffix;
  if (width(suffix) > suffixRoom) {
    if (!keepEnd) tail = truncate(suffix, suffixRoom);
    else {
      const segs = [...segmenter.segment(suffix)].map((s) => s.segment);
      tail = "";
      while (segs.length && width(segs[segs.length - 1]! + tail) <= suffixRoom - 1) tail = segs.pop()! + tail;
      tail = "…" + tail;
    }
  }
  return truncate(title, titleRoom).replace(/\s+…$/, "…") + TITLE_SEP + tail;
}

/**
 * Labels for a row of tabs whose titles are cut to `max` columns. Tabs that
 * would look the same get the shortest part of their URL that no other of
 * them has (host, port or path segment; else query or fragment; else the
 * whole URL), after a " · ", all within `max` columns. If cutting that part
 * makes two labels (or a label and another tab's title) look the same, the
 * part's end or another part is shown instead. Every other title comes back
 * unchanged; tabs on the very same URL can't be told apart by it.
 */
export function distinctTitles(tabs: readonly { title: string; url: string }[], max: number): string[] {
  const out = tabs.map((t) => t.title);
  const key = (s: string) => truncate(s, max);
  const groups = new Map<string, number[]>();
  tabs.forEach((t, i) => groups.set(key(t.title), [...(groups.get(key(t.title)) ?? []), i]));
  // Each disambiguated tab's labels, best first.
  const options = new Map<number, string[]>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const info = group.map((i) => urlParts(tabs[i]!.url));
    group.forEach((i, k) => {
      const mine = info[k]!;
      const others = info.filter((o) => o.id !== mine.id);
      if (!mine.whole || !others.length) return;
      const taken = new Set(others.flatMap((o) => [...o.parts, ...o.extra]));
      const byWidth = (ps: string[]) => ps.filter((p) => !taken.has(p)).sort((a, b) => width(a) - width(b));
      const title = tabs[i]!.title;
      const labels = [...byWidth(mine.parts), ...byWidth(mine.extra)].flatMap((p) => [
        withSuffix(title, p, max, false),
        withSuffix(title, p, max, true),
      ]);
      labels.push(withSuffix(title, mine.whole, max, true));
      options.set(i, [...new Set(labels)]);
      out[i] = labels[0]!;
    });
  }
  // Labels that still look alike (a part cut short, or another tab's title):
  // those tabs move on together to the first labels that all look different.
  const clashes = new Map<string, number[]>();
  out.forEach((o, i) => clashes.set(key(o), [...(clashes.get(key(o)) ?? []), i]));
  for (const clash of clashes.values()) {
    const movers = clash.filter((i) => options.has(i));
    if (clash.length < 2 || !movers.length) continue;
    const rest = new Set(out.filter((_, i) => !movers.includes(i)).map(key));
    const steps = Math.max(...movers.map((i) => options.get(i)!.length));
    for (let step = 1; step < steps; step++) {
      const labels = movers.map((i) => options.get(i)![Math.min(step, options.get(i)!.length - 1)]!);
      const keys = labels.map(key);
      if (new Set(keys).size < keys.length || keys.some((k) => rest.has(k))) continue;
      movers.forEach((i, m) => (out[i] = labels[m]!));
      break;
    }
  }
  return out;
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
    const clean = s.replace(/[\r\n\t]+/g, " ").replace(CONTROLS, "");
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
    if (k === "ArrowLeft") {
      clearSel();
      this.cursor = ctrl || alt ? this.wordLeft() : hadSelection ? 0 : this.prevBoundary();
    } else if (k === "ArrowRight") {
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
