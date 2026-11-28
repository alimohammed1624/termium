// Reader mode: a page's article shown as terminal text instead of a picture.
//
// Mozilla's Readability (the library behind Firefox Reader View, Apache-2.0,
// bundled as text) runs in an isolated world of the page, on a copy of its
// DOM; a small walker turns the article it finds into blocks (headings,
// paragraphs, lists, quotes, code, table rows) of styled runs. Those are
// wrapped to a comfortable width here and drawn as text cells in the pane,
// in the terminal's own font and colours, so the terminal can select,
// copy and search them like any other output.

import type { CDP } from "./cdp";
import type { MouseEvent } from "./input";
import type { Rect } from "./layout";
import { width } from "./text";
import READABILITY from "@mozilla/readability/Readability.js" with { type: "text" };
import READERABLE from "@mozilla/readability/Readability-readerable.js" with { type: "text" };

// ---------------------------------------------------------------- model

/** Inline style bits of a run. */
export const BOLD = 1;
export const ITALIC = 2;
export const CODE = 4;
export const DIM = 8;

export interface Run {
  t: string;
  /** Style bits (BOLD | ITALIC | CODE | DIM). */
  s?: number;
  /** Link target (absolute http(s) or file URL). */
  h?: string;
}

/** `ind`: list nesting depth; `q`: blockquote depth; `mk`: list marker ("*" bullet, or "3."). */
export type Block =
  | { k: "p" | "h" | "tr"; c: Run[]; lv?: number; ind: number; q: number; mk?: string }
  | { k: "pre"; text: string; lang?: string; ind: number; q: number; mk?: string }
  | { k: "hr"; ind: number; q: number };

export interface Article {
  title: string;
  byline: string;
  site: string;
  blocks: Block[];
}

// ---------------------------------------------------------------- page side

// The walker below runs in the page (see EXTRACT_JS). Its output is
// checked again here (see parseArticle): the page could have changed it.
const WALKER = String.raw`
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "MATH", "CANVAS", "IFRAME", "OBJECT", "EMBED",
    "BUTTON", "INPUT", "SELECT", "TEXTAREA", "SOURCE", "TRACK", "HEAD", "LINK", "META", "DIALOG"]);
  const BLOCK = new Set(["P", "DIV", "SECTION", "ARTICLE", "MAIN", "HEADER", "FOOTER", "ASIDE", "NAV", "FIGURE",
    "DETAILS", "SUMMARY", "DL", "ADDRESS", "CENTER", "FORM", "FIELDSET", "HGROUP", "CAPTION", "LEGEND"]);
  // Inside a table row everything is one line of text.
  const FLATTEN = new Set(["PRE", "UL", "OL", "MENU", "HR", "TABLE", "BLOCKQUOTE", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "DT", "DD"]);
  const MAX_BLOCKS = 6000, MAX_CHARS = 1500000;
  const out = [];
  let chars = 0, cur = null, mark = null, ind = 0, q = 0, flat = 0;
  const linkOf = (a) => { const h = String(a.href || ""); return /^(https?|file):/i.test(h) ? h : ""; };
  const push = (b) => { if (out.length < MAX_BLOCKS && chars < MAX_CHARS) out.push(b); };
  const takeMark = () => { const m = mark; mark = null; return m === null ? undefined : m; };
  const flush = () => {
    if (!cur || flat) return;
    const b = cur, c = b.c;
    cur = null;
    while (c.length) { const l = c[c.length - 1]; l.t = l.t.replace(/[ \n]+$/, ""); if (l.t) break; c.pop(); }
    if (!c.some((r) => r.t.trim())) { if (b.mk !== undefined && mark === null) mark = b.mk; return; }
    push(b);
  };
  const open = (k, lv) => {
    if (flat) { if (!cur) open1("tr"); return; }
    flush();
    open1(k, lv);
  };
  const open1 = (k, lv) => {
    cur = { k, ind, q, c: [] };
    if (lv) cur.lv = lv;
    const m = takeMark();
    if (m !== undefined) cur.mk = m;
  };
  const text = (t, s, h) => {
    if (!cur) open("p");
    const c = cur.c, last = c[c.length - 1];
    if (!last || /[ \n]$/.test(last.t)) t = t.replace(/^ +/, "");
    if (!t) return;
    chars += t.length;
    if (last && last.s === s && last.h === h) last.t += t;
    else c.push(h ? { t, s, h } : { t, s });
  };
  const kids = (n, s, h) => { for (let k = n.firstChild; k; k = k.nextSibling) walk(k, s, h); };
  const walk = (n, s, h) => {
    if (out.length >= MAX_BLOCKS || chars >= MAX_CHARS) return;
    if (n.nodeType === 3) { const t = n.data.replace(/\s+/g, " "); if (t) text(t, s, h); return; }
    if (n.nodeType !== 1) return;
    const tag = String(n.tagName).toUpperCase();
    if (SKIP.has(tag) || n.hidden || n.getAttribute("aria-hidden") === "true") return;
    if (flat && FLATTEN.has(tag)) { text(" ", s, h); kids(n, s, h); text(" ", s, h); return; }
    switch (tag) {
      case "BR": if (cur) text(flat ? " " : "\n", s, h); return;
      case "H1": case "H2": case "H3": case "H4": case "H5": case "H6":
        open("h", Number(tag[1])); kids(n, s, h); flush(); return;
      case "PRE": {
        flush();
        const code = n.querySelector("code");
        const m = /(?:^|\s)(?:lang|language)-([\w+#.-]+)/.exec(String((code && code.className) || n.className || ""));
        const t = String(n.textContent || "").replace(/\r\n?/g, "\n").replace(/^\n+/, "").replace(/\s+$/, "");
        const mk = takeMark();
        if (t) { chars += t.length; const b = { k: "pre", text: t, ind, q }; if (m) b.lang = m[1]; if (mk !== undefined) b.mk = mk; push(b); }
        return;
      }
      case "UL": case "OL": case "MENU": {
        flush();
        let i = Number(n.getAttribute("start")) || 1;
        for (let li = n.firstChild; li; li = li.nextSibling) {
          if (li.nodeType !== 1 || String(li.tagName).toUpperCase() !== "LI") { walk(li, s, h); continue; }
          flush();
          mark = tag === "OL" ? (i++) + "." : "*";
          ind++; kids(li, s, h); flush(); ind--;
          mark = null;
        }
        return;
      }
      case "LI": flush(); mark = "*"; ind++; kids(n, s, h); flush(); ind--; mark = null; return;
      case "BLOCKQUOTE": flush(); q++; kids(n, s, h); flush(); q--; return;
      case "HR": flush(); push({ k: "hr", ind, q }); return;
      case "IMG": {
        const alt = String(n.getAttribute("alt") || "").replace(/\s+/g, " ").trim();
        text((cur && cur.c.length ? " " : "") + "[image" + (alt ? ": " + alt : "") + "]", s | 8, h);
        return;
      }
      case "VIDEO": case "AUDIO": text(" [" + tag.toLowerCase() + "] ", s | 8, h); return;
      case "TABLE": {
        flush();
        for (const row of Array.from(n.rows || [])) {
          open("tr"); flat++;
          Array.from(row.cells).forEach((cell, i) => {
            if (i) { cur.c.push({ t: " │ ", s: 8 }); }
            kids(cell, String(cell.tagName).toUpperCase() === "TH" ? s | 1 : s, h);
          });
          flat--; flush();
        }
        return;
      }
      case "A": { const href = linkOf(n); kids(n, s, href || h); return; }
      case "B": case "STRONG": kids(n, s | 1, h); return;
      case "I": case "EM": case "CITE": case "DFN": kids(n, s | 2, h); return;
      case "CODE": case "KBD": case "SAMP": case "TT": case "VAR": kids(n, s | 4, h); return;
      case "DT": open("p"); kids(n, s | 1, h); flush(); return;
      case "DD": flush(); ind++; kids(n, s, h); flush(); ind--; return;
      case "FIGCAPTION": open("p"); kids(n, s | 2 | 8, h); flush(); return;
    }
    if (BLOCK.has(tag)) { if (!flat) flush(); kids(n, s, h); if (!flat) flush(); else text(" ", s, h); return; }
    kids(n, s, h);
  };
`;

/** Evaluated in the page: the article as { title, byline, site, blocks }, or null. */
export const EXTRACT_JS = String.raw`(() => {
  ${READABILITY}
  const doc = document.cloneNode(true);
  const article = new Readability(doc, { serializer: (el) => el, keepClasses: true }).parse();
  // Scraps (a sign-in form's labels) aren't an article: Firefox wants 140 characters too.
  if (!article || !article.content || (article.length || 0) < 140) return null;
  ${WALKER}
  walk(article.content, 0, "");
  flush();
  return { title: String(article.title || document.title || ""), byline: String(article.byline || ""),
    site: String(article.siteName || ""), blocks: out };
})()`;

/** Evaluated in the page: whether it looks like an article (Firefox's test for its reader button). */
export const READERABLE_JS = String.raw`(() => {
  ${READERABLE}
  try { return !!isProbablyReaderable(document); } catch (e) { return false; }
})()`;

// ---------------------------------------------------------------- checking

/** What terminals must never get from a page: controls, bidi overrides, soft hyphens. */
const UNSAFE = /[\x00-\x09\x0b-\x1f\x7f-\x9f\u00ad\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const clean = (s: unknown, max = 100_000): string => String(s ?? "").slice(0, max).replace(UNSAFE, "");
const okHref = (h: unknown): string | undefined => {
  const s = String(h ?? "");
  return s.length < 4096 && /^(https?|file):/i.test(s) && !/[\x00-\x20\x7f-\x9f]/.test(s) ? s : undefined;
};

/** The page's answer, checked: anything malformed is dropped, strings made safe to print. */
export function parseArticle(v: unknown): Article | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.blocks)) return null;
  const nest = (n: unknown) => Math.max(0, Math.min(8, Math.floor(Number(n) || 0)));
  const runs = (c: unknown): Run[] =>
    (Array.isArray(c) ? c : []).slice(0, 5000).flatMap((r: any) => {
      const t = clean(r?.t).replace(/\t/g, " ");
      if (!t) return [];
      const run: Run = { t, s: Number(r?.s) & (BOLD | ITALIC | CODE | DIM) };
      const h = okHref(r?.h);
      if (h) run.h = h;
      return [run];
    });
  const blocks: Block[] = [];
  for (const b of o.blocks.slice(0, 6000) as any[]) {
    const base = { ind: nest(b?.ind), q: nest(b?.q) };
    const mk = typeof b?.mk === "string" && /^(\*|\d{1,6}\.)$/.test(b.mk) ? b.mk : undefined;
    if (b?.k === "p" || b?.k === "h" || b?.k === "tr") {
      const c = runs(b.c);
      if (!c.length) continue;
      blocks.push({ k: b.k, c, ...base, ...(b.k === "h" ? { lv: Math.max(1, Math.min(6, Number(b.lv) || 2)) } : {}), ...(mk ? { mk } : {}) });
    } else if (b?.k === "pre") {
      // Tabs are kept (expanded when laid out); other controls go.
      const text = String(b.text ?? "").slice(0, 200_000).replace(/\r/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");
      if (!text.trim()) continue;
      const lang = typeof b.lang === "string" && /^[\w+#.-]{1,30}$/.test(b.lang) ? b.lang : undefined;
      blocks.push({ k: "pre", text, ...base, ...(lang ? { lang } : {}), ...(mk ? { mk } : {}) });
    } else if (b?.k === "hr") {
      blocks.push({ k: "hr", ...base });
    }
  }
  if (!blocks.length) return null;
  const line = (s: unknown) => clean(s, 500).replace(/\s+/g, " ").trim();
  return { title: line(o.title), byline: line(o.byline), site: line(o.site), blocks };
}

// ---------------------------------------------------------------- layout

/** A piece of a line: its text, its SGR parameters and, for links, which link. */
export interface Cell {
  t: string;
  sgr: string;
  link?: number;
}

export interface Line {
  cells: Cell[];
  /** The block it belongs to (-1: the title and byline): keeps the place across reflows. */
  block: number;
}

export interface Layout {
  lines: Line[];
  links: { href: string; line: number }[];
  /** Columns of text: the widest a line can be. */
  width: number;
}

/** The widest reading column, in cells. */
export const MAX_WIDTH = 80;

/** How wide the text column is in a pane `cols` wide. */
export function columnWidth(cols: number): number {
  return Math.max(1, Math.min(MAX_WIDTH, cols - (cols > 24 ? 4 : 2)));
}

const segmenter = new Intl.Segmenter();
const BULLETS = ["•", "◦", "▪"];

function sgrOf(s: number, extra: string[] = [], link = false): string {
  const p = [...extra];
  if (s & BOLD) p.push("1");
  if (s & ITALIC) p.push("3");
  if (s & DIM) p.push("2");
  if (s & CODE) p.push("33");
  if (link) p.push("4", "34");
  return p.join(";");
}

/** Lays an article out in lines at most `w` columns wide. */
export function layout(a: Article, w: number): Layout {
  w = Math.max(1, w);
  const lines: Line[] = [];
  const links: Layout["links"] = [];
  let block = -1;
  const blank = () => lines.push({ cells: [], block });

  /** Word-wraps runs into lines of `avail` columns, each line starting with prefix(i). */
  const wrap = (runs: Run[], avail: number, prefix: (i: number) => Cell[], extra: string[]): number => {
    avail = Math.max(1, avail);
    let cur: Cell[] = [];
    let used = 0;
    let n = 0;
    let lastHref = "";
    let linkId = -1;
    const emit = () => {
      lines.push({ cells: [...prefix(n++), ...cur], block });
      cur = [];
      used = 0;
    };
    const add = (c: Cell) => {
      const last = cur[cur.length - 1];
      if (last && last.sgr === c.sgr && last.link === c.link) last.t += c.t;
      else cur.push({ ...c });
    };
    let word: Cell[] = [];
    let wordW = 0;
    let space: Cell | null = null;
    const place = () => {
      if (!word.length) return;
      const sp = space && cur.length ? 1 : 0;
      if (used + sp + wordW <= avail) {
        if (sp) add(space!);
        used += sp;
      } else if (cur.length) {
        emit();
      }
      for (const c of word) {
        if (used + width(c.t) <= avail) {
          add(c);
          used += width(c.t);
          continue;
        }
        // Longer than a line: cut between characters.
        for (const { segment } of segmenter.segment(c.t)) {
          const sw = width(segment);
          if (used + sw > avail && cur.length) emit();
          add({ ...c, t: segment });
          used += sw;
        }
      }
      word = [];
      wordW = 0;
      space = null;
    };
    for (const r of runs) {
      let link: number | undefined;
      if (r.h) {
        if (r.h !== lastHref || linkId < 0) {
          linkId = links.length;
          links.push({ href: r.h, line: -1 });
        }
        link = linkId;
      }
      lastHref = r.h ?? "";
      if (!r.h) linkId = -1;
      const sgr = sgrOf(r.s ?? 0, extra, !!r.h);
      for (const tok of r.t.split(/( |\n)/)) {
        if (tok === " ") {
          place();
          space = r.h ? { t: " ", sgr, link } : { t: " ", sgr: extra.join(";") };
        } else if (tok === "\n") {
          place();
          emit();
        } else if (tok) {
          word.push({ t: tok, sgr, link });
          wordW += width(tok);
        }
      }
    }
    place();
    if (cur.length || n === 0) emit();
    return n;
  };

  // Gutters for quotes, indents for lists.
  const lead = (b: Block): { first: Cell[]; rest: Cell[]; w: number } => {
    const quote: Cell[] = b.q ? [{ t: "│ ".repeat(b.q), sgr: "2" }] : [];
    let first = "";
    let rest = "";
    if (b.ind > 0) {
      const base = "  ".repeat(b.ind - 1);
      const mk = "mk" in b && b.mk ? (b.mk === "*" ? BULLETS[(b.ind - 1) % BULLETS.length]! : b.mk) : "";
      first = base + (mk ? mk + " " : "  ");
      rest = base + " ".repeat(mk ? width(mk) + 1 : 2);
    }
    const qw = b.q * 2;
    return {
      first: [...quote, ...(first ? [{ t: first, sgr: "1" }] : [])],
      rest: [...quote, ...(rest ? [{ t: rest, sgr: "" }] : [])],
      w: qw + width(first),
    };
  };

  const heading = (runs: Run[], lv: number, avail: number, prefix: (i: number) => Cell[]) => {
    const extra = lv === 1 ? ["1", "35"] : lv === 2 ? ["1", "34"] : ["1"];
    const start = lines.length;
    wrap(runs.map((r) => ({ ...r, s: (r.s ?? 0) & ~DIM })), avail, prefix, extra);
    if (lv <= 2) {
      const longest = Math.max(...lines.slice(start).map((l) => l.cells.reduce((a, c) => a + width(c.t), 0)));
      lines.push({ cells: [{ t: (lv === 1 ? "━" : "─").repeat(Math.max(1, Math.min(w, longest))), sgr: lv === 1 ? "35" : "34" }], block });
    }
  };

  // Title and byline.
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  let blocks = a.blocks;
  if (a.title) {
    heading([{ t: a.title }], 1, w, () => []);
    const first = blocks[0];
    if (first && first.k === "h" && norm(first.c.map((r) => r.t).join("")) === norm(a.title)) blocks = blocks.slice(1);
  }
  const by = [a.byline, a.site].filter(Boolean).join(" · ");
  if (by) wrap([{ t: by, s: DIM }], w, () => [], []);

  const columns = tableColumns(blocks, w);
  /** A table row laid out in aligned columns (it fits: see tableColumns). */
  const row = (b: Extract<Block, { c: Run[] }>, widths: number[], first: Cell[]) => {
    const cells: Cell[] = [...first];
    let lastHref = "";
    let linkId = -1;
    splitRow(b.c).forEach((cell, k) => {
      if (k) cells.push({ t: " │ ", sgr: "2" });
      let used = 0;
      for (const r of cell) {
        let link: number | undefined;
        if (r.h) {
          if (r.h !== lastHref || linkId < 0) {
            linkId = links.length;
            links.push({ href: r.h, line: -1 });
          }
          link = linkId;
        } else linkId = -1;
        lastHref = r.h ?? "";
        cells.push({ t: r.t, sgr: sgrOf(r.s ?? 0, [], !!r.h), link });
        used += width(r.t);
      }
      if (k < widths.length - 1) cells.push({ t: " ".repeat(Math.max(0, widths[k]! - used)), sgr: "" });
    });
    lines.push({ cells, block });
  };

  let prev: Block | null = null;
  const offset = a.blocks.length - blocks.length;
  blocks.forEach((b, i) => {
    block = i + offset;
    const tight = prev && ((prev.ind > 0 && b.ind > 0 && prev.k !== "pre" && b.k !== "pre" && b.k !== "h") || (prev.k === "tr" && b.k === "tr"));
    if (lines.length && !tight) blank();
    prev = b;
    const l = lead(b);
    const avail = Math.max(1, w - l.w);
    const prefix = (n: number) => (n === 0 ? l.first : l.rest);
    switch (b.k) {
      case "h":
        heading(b.c, b.lv ?? 2, avail, prefix);
        break;
      case "tr": {
        const widths = columns.get(b);
        if (widths) row(b, widths, l.first);
        else wrap(b.c, avail, prefix, []);
        break;
      }
      case "p":
        wrap(b.c, avail, prefix, []);
        break;
      case "hr":
        lines.push({ cells: [...l.rest, { t: "─".repeat(Math.min(avail, 40)), sgr: "2" }], block });
        break;
      case "pre": {
        let n = 0;
        const gutter = (i: number): Cell[] => [...(i === 0 ? l.first : l.rest), { t: "▏ ", sgr: "2" }];
        if (b.lang) lines.push({ cells: [...gutter(n++), { t: b.lang, sgr: "2;3" }], block });
        const room = Math.max(1, avail - 2);
        for (const raw of b.text.split("\n")) {
          // Tabs to the next multiple of 4.
          let line = "";
          for (const ch of raw) line += ch === "\t" ? " ".repeat(4 - (width(line) % 4)) : ch;
          let piece = "";
          let pw = 0;
          for (const { segment } of segmenter.segment(line)) {
            const sw = width(segment);
            if (pw + sw > room && piece) {
              lines.push({ cells: [...gutter(n++), { t: piece, sgr: "33" }], block });
              piece = "";
              pw = 0;
            }
            piece += segment;
            pw += sw;
          }
          lines.push({ cells: [...gutter(n++), ...(piece ? [{ t: piece, sgr: "33" }] : [])], block });
        }
        break;
      }
    }
  });
  // Where each link starts (a word can wrap after its link was counted).
  lines.forEach((l, i) => {
    for (const c of l.cells) if (c.link !== undefined && links[c.link] && links[c.link]!.line < 0) links[c.link]!.line = i;
  });
  return { lines, links, width: w };
}

/** A table row's cells (split at the walker's separators), each trimmed and on one line. */
function splitRow(c: Run[]): Run[][] {
  const cells: Run[][] = [[]];
  for (const r of c) {
    if (r.t === " │ " && r.s === DIM && !r.h) cells.push([]);
    else cells[cells.length - 1]!.push({ ...r, t: r.t.replace(/\s+/g, " ") });
  }
  for (const cell of cells) {
    if (cell.length) cell[0]!.t = cell[0]!.t.replace(/^ +/, "");
    if (cell.length) cell[cell.length - 1]!.t = cell[cell.length - 1]!.t.replace(/ +$/, "");
  }
  return cells.map((cell) => cell.filter((r) => r.t));
}

/**
 * Column widths for each run of table rows that fits the column whole
 * when aligned; rows of a table too wide are wrapped as text instead.
 */
function tableColumns(blocks: Block[], w: number): Map<Block, number[]> {
  const out = new Map<Block, number[]>();
  for (let i = 0; i < blocks.length; ) {
    const b = blocks[i]!;
    if (b.k !== "tr") {
      i++;
      continue;
    }
    let j = i;
    while (j < blocks.length && blocks[j]!.k === "tr" && blocks[j]!.ind === b.ind && blocks[j]!.q === b.q) j++;
    const rows = blocks.slice(i, j).map((r) => splitRow((r as Extract<Block, { c: Run[] }>).c));
    const widths: number[] = [];
    for (const r of rows) r.forEach((cell, k) => (widths[k] = Math.max(widths[k] ?? 0, cell.reduce((a, x) => a + width(x.t), 0))));
    const lead = b.q * 2 + (b.ind > 0 ? 2 * b.ind : 0);
    if (widths.reduce((a, x) => a + x, 0) + 3 * (widths.length - 1) <= w - lead) {
      for (let k = i; k < j; k++) out.set(blocks[k]!, widths);
    }
    i = j;
  }
  return out;
}

/** The article as Markdown, for copying. */
export function toMarkdown(a: Article): string {
  const inline = (c: Run[]) => {
    let s = "";
    let i = 0;
    while (i < c.length) {
      const h = c[i]!.h;
      let t = "";
      for (; i < c.length && c[i]!.h === h; i++) {
        const r = c[i]!;
        const m = (r.s ?? 0) & CODE ? "`" : (r.s ?? 0) & BOLD ? "**" : (r.s ?? 0) & ITALIC ? "_" : "";
        const inner = r.t.trim() ? r.t.replace(/^(\s*)(.*?)(\s*)$/s, `$1${m}$2${m}$3`) : r.t;
        t += inner;
      }
      s += h ? `[${t.trim()}](${h})` + (/\s$/.test(t) ? " " : "") : t;
    }
    return s.replace(/\n/g, "  \n");
  };
  const out: string[] = [];
  if (a.title) out.push(`# ${a.title}`);
  if (a.byline || a.site) out.push(`_${[a.byline, a.site].filter(Boolean).join(" · ")}_`);
  for (const b of a.blocks) {
    const q = "> ".repeat(b.q);
    const pad = b.ind > 0 ? "  ".repeat(b.ind - 1) : "";
    const mk = "mk" in b && b.mk ? (b.mk === "*" ? "- " : `${b.mk} `) : b.ind > 0 ? "  " : "";
    let text: string;
    if (b.k === "h") text = `${"#".repeat(b.lv ?? 2)} ${inline(b.c)}`;
    else if (b.k === "pre") text = "```" + (b.lang ?? "") + "\n" + b.text + "\n```";
    else if (b.k === "hr") text = "---";
    else text = inline(b.c);
    out.push(text.split("\n").map((l, i) => q + pad + (i === 0 ? mk : " ".repeat(mk.length)) + l).join("\n"));
  }
  return out.join("\n\n") + "\n";
}

// ---------------------------------------------------------------- view

const CSI = "\x1b[";
const at = (row: number, col: number) => `${CSI}${row};${col}H`;
const osc8 = (href: string) => `\x1b]8;;${href}\x1b\\`;

/** What a reader pane shows: the laid out article and where it's scrolled to. */
export class ReaderView {
  article: Article | null = null;
  url = "";
  top = 0;
  /** The link focused with Tab (-1: none). */
  focus = -1;
  private lay: Layout | null = null;
  /** Lines of text in the pane (its height less the status line). */
  private rows = 1;
  /** The block at the top, to keep across reflows (and between visits). */
  private anchor = -1;

  constructor(public status: "loading" | "ready" = "loading") {}

  setArticle(a: Article, url: string, anchorBlock = -1): void {
    this.article = a;
    this.url = url;
    this.status = "ready";
    this.lay = null;
    this.top = 0;
    this.focus = -1;
    this.anchor = anchorBlock;
  }

  /** The block shown at the top (remembered as the reading position). */
  topBlock(): number {
    return this.lay?.lines[this.top]?.block ?? this.anchor;
  }

  layoutFor(cols: number): Layout | null {
    if (!this.article) return null;
    const w = columnWidth(cols);
    if (!this.lay || this.lay.width !== w) {
      const keep = this.lay ? this.topBlock() : this.anchor;
      this.lay = layout(this.article, w);
      this.top = 0;
      if (keep >= 0) {
        const i = this.lay.lines.findIndex((l) => l.block >= keep);
        if (i >= 0) this.top = i;
      }
    }
    return this.lay;
  }

  private maxTop(): number {
    return Math.max(0, (this.lay?.lines.length ?? 0) - this.rows);
  }

  scroll(by: number): boolean {
    const top = Math.max(0, Math.min(this.maxTop(), this.top + by));
    if (top === this.top) return false;
    this.top = top;
    this.anchor = this.topBlock();
    return true;
  }

  scrollTo(top: number): boolean {
    return this.scroll(top - this.top);
  }

  /** Moves the Tab focus to the next (or previous) link, scrolling it into view. */
  moveFocus(dir: 1 | -1): boolean {
    const links = this.lay?.links ?? [];
    if (!links.length) return false;
    const visible = (i: number) => links[i]!.line >= this.top && links[i]!.line < this.top + this.rows;
    let i = this.focus;
    if (i < 0 || !visible(i)) {
      // Start from the links on screen.
      const on = links.map((_, k) => k).filter(visible);
      i = on.length ? (dir > 0 ? on[0]! : on[on.length - 1]!) : links.findIndex((l) => l.line >= this.top);
      if (i < 0) i = links.length - 1;
    } else {
      i = (i + dir + links.length) % links.length;
    }
    this.focus = i;
    const line = links[i]!.line;
    if (line < this.top) this.scrollTo(line);
    else if (line >= this.top + this.rows) this.scrollTo(line - this.rows + 1);
    return true;
  }

  focusedHref(): string | null {
    return this.focus >= 0 ? (this.lay?.links[this.focus]?.href ?? null) : null;
  }

  /** The link at a cell of the pane, if any. */
  linkAt(r: Rect, col: number, row: number): string | null {
    const lay = this.layoutFor(r.cols);
    if (!lay) return null;
    const line = lay.lines[this.top + row - r.row];
    let x = col - (r.col + Math.floor((r.cols - lay.width) / 2));
    if (!line || x < 0) return null;
    for (const c of line.cells) {
      const cw = width(c.t);
      if (x < cw) return c.link !== undefined ? (lay.links[c.link]?.href ?? null) : null;
      x -= cw;
    }
    return null;
  }

  /** Draws the pane: the text column centred, and a status line at the bottom. */
  draw(r: Rect, hint: string, selecting: boolean): string {
    const statusRows = r.rows >= 4 ? 1 : 0;
    this.rows = Math.max(1, r.rows - statusRows);
    const lay = this.layoutFor(r.cols);
    if (lay) this.top = Math.min(this.top, this.maxTop());
    const left = lay ? Math.floor((r.cols - lay.width) / 2) : 2;
    let s = "";
    for (let i = 0; i < this.rows; i++) {
      s += at(r.row + i, r.col) + CSI + "0m";
      let body = "";
      let used = 0;
      if (lay) {
        for (const c of lay.lines[this.top + i]?.cells ?? []) {
          const sgr = c.link !== undefined && c.link === this.focus ? (c.sgr ? c.sgr + ";7" : "7") : c.sgr;
          const href = c.link !== undefined ? lay.links[c.link]?.href : undefined;
          body += CSI + "0" + (sgr ? ";" + sgr : "") + "m" + (href ? osc8(href) + c.t + osc8("") : c.t);
          used += width(c.t);
        }
      } else if (i === 1) {
        const msg = "Reading the article…";
        body = CSI + "2m" + msg;
        used = width(msg);
      }
      const pad = Math.max(0, Math.min(left, r.cols - used));
      s += " ".repeat(pad) + body + CSI + "0m" + " ".repeat(Math.max(0, r.cols - pad - used));
    }
    if (statusRows) {
      const total = lay?.lines.length ?? 0;
      const pct = total <= this.rows ? 100 : Math.round(((this.top + this.rows) / total) * 100);
      const text = selecting
        ? " SELECT  drag to select text, copy with your terminal · s or Esc: back to reading"
        : ` ${lay ? `${Math.min(100, pct)}%` : "…"}  ${hint}`;
      const shown = fitTo(text, r.cols);
      s += at(r.row + r.rows - 1, r.col) + CSI + (selecting ? "0;7m" : "0;2m") + shown + CSI + "0m";
    }
    return s;
  }
}

function fitTo(s: string, n: number): string {
  let outStr = "";
  let w = 0;
  for (const { segment } of segmenter.segment(s)) {
    const sw = width(segment);
    if (w + sw > n) break;
    outStr += segment;
    w += sw;
  }
  return outStr + " ".repeat(Math.max(0, n - w));
}

// ---------------------------------------------------------------- controller

/** A page, as far as reader mode needs one. */
export interface ReaderPage {
  sessionId: string;
  targetId: string;
  url: string;
}

/** What reader mode asks of the app. */
export interface ReaderHost<P extends ReaderPage> {
  /** The page whose main session this is. */
  page(sessionId: string | undefined): P | undefined;
  isOpen(page: P): boolean;
  /** Reader mode went on (the picture must go) or off (the picture comes back). */
  shown(page: P, on: boolean): void;
  /** The pane's text changed (scrolled, article arrived). */
  redraw(page: P): void;
  /** Whether it looks like an article changed (the address-bar button). */
  chrome(): void;
  navigate(page: P, url: string): void;
  openInBackground(url: string): void;
  toast(text: string): void;
  copy(text: string): void;
  /** Writes to the terminal (mouse reporting on and off). */
  terminal(seq: string): void;
  log(msg: string): void;
}

interface PageState {
  /** Looks like an article (Readability's isProbablyReaderable). */
  readable: boolean;
  /** Bumped by every new document: late answers about an older one are dropped. */
  seq: number;
  view: ReaderView | null;
  /** The document address the readable check and article were for (hash dropped). */
  doc: string;
  /** termium's isolated world in the current document. */
  world?: { seq: number; id: number };
}

/** Mouse reporting as enterTerminal turns it on (see terminal.ts). */
const MOUSE_ON = `${CSI}?1003h`;
const MOUSE_OFF = `${CSI}?1003l`;

const noHash = (url: string) => url.replace(/#.*$/, "");

/** Keys that scroll and leave select mode on. */
const SCROLL_KEYS: Record<string, "line" | "page" | "end"> = {
  arrowdown: "line", arrowup: "line", pagedown: "page", pageup: "page", home: "end", end: "end",
};

export class ReaderMode<P extends ReaderPage> {
  private state = new WeakMap<P, PageState>();
  /** Reading positions by address (top block), most recent last. */
  private positions = new Map<string, number>();
  /** The page whose pane is in select mode (mouse reporting off), if any. */
  selecting: P | null = null;

  constructor(
    private cdp: CDP,
    private host: ReaderHost<P>,
  ) {
    const main = (sid: string | undefined, frameId: unknown) => {
      const page = host.page(sid);
      return page && frameId === page.targetId ? page : undefined;
    };
    cdp.on("Page.frameNavigated", (p, sid) => {
      const page = main(sid, p.frame?.parentId ? null : p.frame?.id);
      if (page) this.newDocument(page, String(p.frame?.url ?? page.url), 0);
    });
    cdp.on("Page.navigatedWithinDocument", (p, sid) => {
      const page = main(sid, p.frameId);
      // A single-page app's new "page": looked at again once it has drawn. (Not a jump to an anchor.)
      if (page && noHash(String(p.url ?? "")) !== this.st(page).doc) this.newDocument(page, String(p.url), 800);
    });
  }

  private st(page: P): PageState {
    let s = this.state.get(page);
    if (!s) this.state.set(page, (s = { readable: false, seq: 0, view: null, doc: "" }));
    return s;
  }

  isOn(page: P): boolean {
    return !!this.state.get(page)?.view;
  }

  /** Whether the page looks like an article (Readability's isProbablyReaderable). */
  readable(page: P): boolean {
    return !!this.state.get(page)?.readable;
  }

  /** Whether to offer reader mode for the page (the address-bar button). */
  offered(page: P): boolean {
    const s = this.state.get(page);
    return !!s && (s.readable || !!s.view);
  }

  /** The page closed. */
  forget(page: P): void {
    if (this.selecting === page) this.selecting = null;
    this.state.delete(page);
  }

  /** A terminal attached or went away: its mouse reporting starts on (see enterTerminal). */
  terminalReset(): void {
    this.selecting = null;
  }

  /** A new document (or a single-page app's new view): check it, and read it if reader mode is on. */
  private newDocument(page: P, url: string, delay: number): void {
    const s = this.st(page);
    const seq = ++s.seq;
    s.doc = noHash(url);
    const wasReadable = s.readable;
    s.readable = false;
    if (s.view) {
      this.remember(s.view);
      s.view.status = "loading";
      s.view.article = null;
      this.host.redraw(page);
    }
    if (wasReadable) this.host.chrome();
    void (async () => {
      if (delay) await Bun.sleep(delay);
      if (!(await this.settled(page, seq))) return;
      const readable = (await this.evaluate(page, READERABLE_JS, 5000).catch(() => false)) === true;
      if (s.seq !== seq || !this.host.isOpen(page)) return;
      if (readable !== s.readable) {
        s.readable = readable;
        this.host.chrome();
      }
      if (s.view) await this.read(page, seq, false);
    })().catch((e) => this.host.log(`reader: ${e}`));
  }

  /** Waits for the document to finish loading (15 s at most); false if another came meanwhile. */
  private async settled(page: P, seq: number): Promise<boolean> {
    const s = this.st(page);
    for (let i = 0; i < 60; i++) {
      if (s.seq !== seq || !this.host.isOpen(page)) return false;
      const state = await this.evaluate(page, "document.readyState", 2000, true).catch(() => null);
      if (state === "complete" || (state === "interactive" && i >= 12)) return s.seq === seq;
      await Bun.sleep(250);
    }
    return s.seq === seq;
  }

  /**
   * Evaluates in termium's isolated world (the page's own scripts can't see
   * or change it), else, or for `main`, in the page's.
   */
  private async evaluate(page: P, expression: string, timeoutMs: number, main = false): Promise<unknown> {
    const sid = page.sessionId;
    const s = this.st(page);
    const world = async (): Promise<number | undefined> => {
      if (s.world?.seq === s.seq) return s.world.id;
      const seq = s.seq;
      const w = await this.cdp.send("Page.createIsolatedWorld", { frameId: page.targetId, worldName: "termium-reader" }, sid).catch(() => null);
      const id = Number(w?.executionContextId) || undefined;
      if (id) s.world = { seq, id };
      return id;
    };
    const once = async (contextId: number | undefined) => {
      const r = await this.cdp.send("Runtime.evaluate", { expression, returnByValue: true, ...(contextId ? { contextId } : {}) }, sid);
      if (r?.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "error"));
      return r?.result?.value;
    };
    const run = async () => {
      if (main) return once(undefined);
      const id = await world();
      try {
        return await once(id);
      } catch (e) {
        // The world went with its document: once more in a new one.
        if (!id || !/context/i.test(String(e))) throw e;
        s.world = undefined;
        return once(await world());
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("timed out")), timeoutMs)));
    return Promise.race([run(), late]).finally(() => clearTimeout(timer));
  }

  /** Extracts the article into the page's view; turns reader mode off if there's none. */
  private async read(page: P, seq: number, asked: boolean): Promise<boolean> {
    const s = this.st(page);
    let article: Article | null = null;
    try {
      article = parseArticle(await this.evaluate(page, EXTRACT_JS, 15_000));
    } catch (e) {
      this.host.log(`reader: ${e}`);
    }
    if (s.seq !== seq || !s.view || !this.host.isOpen(page)) return false;
    if (!article) {
      this.off(page);
      this.host.toast(asked ? "No article found on this page" : "Not an article: showing the page");
      return false;
    }
    const doc = s.doc || noHash(page.url);
    s.view.setArticle(article, doc, this.positions.get(doc) ?? -1);
    this.host.redraw(page);
    return true;
  }

  /** Turns reader mode on (reading the article) or off; resolves to whether it's on. */
  async set(page: P, on: boolean): Promise<boolean> {
    const s = this.st(page);
    if (!on) {
      this.off(page);
      return false;
    }
    if (s.view) return true;
    s.view = new ReaderView("loading");
    this.host.shown(page, true);
    return this.read(page, s.seq, true);
  }

  toggle(page: P): Promise<boolean> {
    return this.set(page, !this.isOn(page));
  }

  private off(page: P): void {
    const s = this.state.get(page);
    if (!s?.view) return;
    if (this.selecting === page) this.select(null);
    this.remember(s.view);
    s.view = null;
    this.host.shown(page, false);
  }

  private remember(v: ReaderView): void {
    if (!v.article || !v.url) return;
    const key = noHash(v.url);
    this.positions.delete(key);
    this.positions.set(key, v.topBlock());
    while (this.positions.size > 200) this.positions.delete(this.positions.keys().next().value!);
  }

  /** Select mode: mouse reporting off so the terminal itself selects (`page`), or back on (null). */
  private select(page: P | null): void {
    if (page === this.selecting) return;
    if (page && !this.selecting) this.host.terminal(MOUSE_OFF);
    if (!page && this.selecting) this.host.terminal(MOUSE_ON);
    const was = this.selecting;
    this.selecting = page;
    if (was && this.isOn(was)) this.host.redraw(was);
    if (page) this.host.redraw(page);
  }

  /**
   * Select mode ends when the page it's for is no longer the focused one
   * on screen (an agent switched tabs, say). Called with the chrome.
   */
  checkSelect(focused: P | undefined, visible: (p: P) => boolean): void {
    const p = this.selecting;
    if (p && (p !== focused || !this.isOn(p) || !visible(p))) this.select(null);
  }

  /**
   * A key while selecting: scroll keys scroll, s and Esc go back to reading
   * (consumed), anything else ends select mode and goes on as usual.
   * True if consumed.
   */
  selectKey(combo: string, rect: Rect | undefined): boolean {
    const page = this.selecting;
    if (!page) return false;
    if (SCROLL_KEYS[combo] && rect) return this.key(page, combo, rect);
    this.select(null);
    return combo === "s" || combo === "escape";
  }

  /** A key for a page in reader mode (it has the focus): true if handled. Every key is, but globals. */
  key(page: P, combo: string, rect: Rect): boolean {
    const v = this.state.get(page)?.view;
    if (!v) return false;
    const rows = Math.max(1, rect.rows - (rect.rows >= 4 ? 1 : 0));
    let moved = false;
    switch (combo) {
      case "j": case "arrowdown": moved = v.scroll(1); break;
      case "k": case "arrowup": moved = v.scroll(-1); break;
      case "space": case "pagedown": case "ctrl+d": case "ctrl+f": moved = v.scroll(Math.max(1, rows - 2)); break;
      case "shift+space": case "pageup": case "ctrl+u": case "b": moved = v.scroll(-Math.max(1, rows - 2)); break;
      case "g": case "home": moved = v.scrollTo(0); break;
      case "shift+g": case "end": moved = v.scrollTo(Number.MAX_SAFE_INTEGER); break;
      case "tab": moved = v.moveFocus(1); break;
      case "shift+tab": moved = v.moveFocus(-1); break;
      case "enter": {
        const href = v.focusedHref();
        if (href) this.host.navigate(page, href);
        break;
      }
      case "ctrl+enter": case "shift+enter": {
        const href = v.focusedHref();
        if (href) this.host.openInBackground(href);
        break;
      }
      case "s":
        if (v.article) this.select(page);
        break;
      case "y":
        if (v.article) {
          this.host.copy(toMarkdown(v.article));
          this.host.toast("Copied the article as Markdown");
        }
        break;
      case "escape":
        if (v.focus >= 0) {
          v.focus = -1;
          moved = true;
        } else this.off(page);
        break;
    }
    if (moved) this.host.redraw(page);
    return true;
  }

  /** A mouse event over a reader pane. */
  mouse(page: P, ev: MouseEvent, col: number, row: number, rect: Rect): void {
    const v = this.state.get(page)?.view;
    if (!v) return;
    if (ev.action === "wheel") {
      if ((ev.wheel === "up" || ev.wheel === "down") && v.scroll(ev.wheel === "up" ? -3 : 3)) this.host.redraw(page);
      return;
    }
    if (ev.action !== "press") return;
    const href = v.linkAt(rect, col, row);
    if (!href) return;
    if (ev.button === 1 || (ev.button === 0 && ev.mods.ctrl)) this.host.openInBackground(href);
    else if (ev.button === 0) this.host.navigate(page, href);
  }

  /** The pane's text. */
  draw(page: P, rect: Rect, hint: string): string {
    const v = this.state.get(page)?.view;
    return v ? v.draw(rect, hint, this.selecting === page) : "";
  }
}

/** The keys a reader pane lists in its status line (`toggle`: how to get back to the page). */
export function readerHint(toggle: string): string {
  return `j/k Space scroll · Tab/Enter links · s select · y copy · Esc or ${toggle}: page`;
}

