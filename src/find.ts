// Find in page: the scripts termium runs in a page to find text, highlight
// the matches and say where they are (for the find bar's count and the
// scrollbar's landmarks).

/** Highlight names (the CSS Custom Highlight API: nothing is added to the page's DOM). */
const ALL = "termium-find";
const CURRENT = "termium-find-current";

/** At most this many matches are found (the count then reads "N+"). */
export const FIND_LIMIT = 10000;

/**
 * Run in every new document (in termium's isolated world): how the
 * highlights look. A constructed stylesheet, which a page's Content-
 * Security-Policy can't block and which adds nothing to the page's DOM.
 */
export const FIND_STYLE = `(() => {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync("::highlight(${ALL}) { background-color: #f9e2af; color: #11111b; } ::highlight(${CURRENT}) { background-color: #fab387; color: #11111b; }");
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  } catch {}
})();`;

/** What a find in the page answers. */
export interface FindResult {
  /** Matches found (at most FIND_LIMIT). */
  total: number;
  /** The current match (0-based), -1 if none. */
  index: number;
  /** Each match's document position (CSS px from the top), in document order. */
  ys: number[];
}

/**
 * An expression that finds `query` in the page's document (case-insensitive,
 * within single text nodes, rendered text only), highlights every match and
 * the current one, and returns a FindResult. The current match is:
 * - "near": the first one at or below the top of the viewport (as you type);
 * - "goto": match `index` (wrapping around), scrolled into view if it isn't;
 * - "keep": match `index` again, without scrolling (the layout changed).
 */
export function findScript(query: string, mode: "near" | "goto" | "keep", index = 0): string {
  return `(() => {
  const reg = CSS.highlights;
  const out = { total: 0, index: -1, ys: [] };
  const q = ${JSON.stringify(query)};
  if (!reg || !q) { reg?.delete(${JSON.stringify(ALL)}); reg?.delete(${JSON.stringify(CURRENT)}); return out; }
  const re = new RegExp(q.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&"), "gi");
  const skip = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|TEXTAREA|SELECT|OPTION)$/;
  const ranges = [];
  const tops = [];
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  outer: for (let n; (n = walker.nextNode()); ) {
    if (n.parentElement && skip.test(n.parentElement.tagName)) continue;
    re.lastIndex = 0;
    let shown = null; // visibility checked once per node, only when it matches
    for (let m; (m = re.exec(n.data)); ) {
      if (!m[0]) { re.lastIndex++; continue; }
      shown ??= !n.parentElement || getComputedStyle(n.parentElement).visibility === "visible";
      if (!shown) break;
      const r = new Range();
      r.setStart(n, m.index);
      r.setEnd(n, m.index + m[0].length);
      const rect = r.getBoundingClientRect();
      if (!rect.width && !rect.height) continue; // not rendered
      ranges.push(r);
      tops.push(rect.top);
      if (ranges.length >= ${FIND_LIMIT}) break outer;
    }
  }
  if (!ranges.length) { reg.delete(${JSON.stringify(ALL)}); reg.delete(${JSON.stringify(CURRENT)}); return out; }
  // Document positions, before any scrolling below moves the viewport.
  out.ys = tops.map((t) => Math.round(t + scrollY));
  const mode = ${JSON.stringify(mode)};
  const n = ranges.length;
  let i = mode === "near" ? tops.findIndex((t) => t >= 0) : ((${Math.trunc(index)} % n) + n) % n;
  if (i < 0) i = 0;
  reg.set(${JSON.stringify(ALL)}, new Highlight(...ranges));
  const cur = new Highlight(ranges[i]);
  cur.priority = 1;
  reg.set(${JSON.stringify(CURRENT)}, cur);
  if (mode !== "keep") {
    const off = (c) => c.top < 0 || c.bottom > innerHeight || c.left < 0 || c.right > innerWidth;
    if (off(ranges[i].getBoundingClientRect())) {
      // Its element into view (that scrolls any boxes it's inside), then the
      // match itself, which can be far down a tall element.
      ranges[i].startContainer.parentElement?.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
      const c = ranges[i].getBoundingClientRect();
      if (off(c)) scrollBy({ top: c.top + c.height / 2 - innerHeight / 2, behavior: "instant" });
    }
  }
  out.total = n;
  out.index = i;
  return out;
})()`;
}

/** An expression that removes find's highlights from the page. */
export const CLEAR_FIND = `CSS.highlights?.delete(${JSON.stringify(ALL)}), CSS.highlights?.delete(${JSON.stringify(CURRENT)}), undefined`;

/** The find bar's count: "3/17", "No matches", or "" before the first answer. */
export function findCount(r: FindResult | undefined): string {
  if (!r) return "";
  if (!r.total) return "No matches";
  return `${r.index + 1}/${r.total}${r.total >= FIND_LIMIT ? "+" : ""}`;
}
