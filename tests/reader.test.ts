import { describe, expect, test } from "bun:test";
import { parseCtl } from "../src/ctl";
import { BOLD, CODE, EXTRACT_JS, READERABLE_JS, ReaderView, columnWidth, layout, parseArticle, toMarkdown, type Article } from "../src/reader";
import { width } from "../src/text";

const text = (l: { cells: { t: string }[] }) => l.cells.map((c) => c.t).join("");

const article: Article = {
  title: "A title",
  byline: "Ada",
  site: "Blog",
  blocks: [
    { k: "h", lv: 1, c: [{ t: "A title" }], ind: 0, q: 0 },
    { k: "p", c: [{ t: "Some " }, { t: "bold", s: BOLD }, { t: " and a " }, { t: "link here", h: "https://example.com/x" }, { t: "." }], ind: 0, q: 0 },
    { k: "h", lv: 2, c: [{ t: "Section" }], ind: 0, q: 0 },
    { k: "p", c: [{ t: "first" }], ind: 1, q: 0, mk: "*" },
    { k: "p", c: [{ t: "second item that is long enough to wrap onto another line" }], ind: 1, q: 0, mk: "*" },
    { k: "p", c: [{ t: "quoted" }], ind: 0, q: 1 },
    { k: "pre", text: "let x = 1;\n\tindented();", lang: "js", ind: 0, q: 0 },
  ],
};

describe("parseArticle", () => {
  test("keeps good blocks and makes text safe to print", () => {
    const a = parseArticle({
      title: "T\x1b[31m‮",
      blocks: [
        { k: "p", c: [{ t: "hi\x07 there", s: BOLD | 64, h: "javascript:alert(1)" }], ind: 99, q: -3 },
        { k: "p", c: [{ t: "go", h: "https://ok.example/" }], ind: 0, q: 0, mk: "\x1b[2J", a: ["top", 7, "", "x".repeat(300)] },
        { k: "pre", text: "a\tb\x1b[0m\r\n", ind: 0, q: 0, lang: "bad lang!" },
        { k: "script", c: [] },
        { k: "p", c: [] },
      ],
    })!;
    expect(a.title).toBe("T[31m");
    expect(a.blocks).toEqual([
      { k: "p", c: [{ t: "hi there", s: BOLD }], ind: 8, q: 0 },
      { k: "p", c: [{ t: "go", s: 0, h: "https://ok.example/" }], ind: 0, q: 0, a: ["top"] },
      { k: "pre", text: "a\tb[0m\n", ind: 0, q: 0 },
    ]);
  });

  test("nothing usable is no article", () => {
    expect(parseArticle(null)).toBeNull();
    expect(parseArticle({ blocks: "x" })).toBeNull();
    expect(parseArticle({ blocks: [{ k: "p", c: [{ t: "" }] }] })).toBeNull();
  });
});

describe("layout", () => {
  test("lines never pass the column, and the title isn't shown twice", () => {
    for (const w of [8, 20, 40, 80]) {
      const lay = layout(article, w);
      for (const l of lay.lines) expect(width(text(l))).toBeLessThanOrEqual(w);
      expect(lay.lines.filter((l) => text(l) === "A title").length).toBe(1);
    }
  });

  test("headings, bullets, quotes and code", () => {
    const lines = layout(article, 40).lines.map(text);
    expect(lines[0]).toBe("A title");
    expect(lines[1]).toBe("━━━━━━━");
    expect(lines[2]).toBe("Ada · Blog");
    expect(lines).toContain("• first");
    expect(lines).toContain("• second item that is long enough to");
    expect(lines).toContain("  wrap onto another line");
    expect(lines).toContain("│ quoted");
    expect(lines).toContain("▏ js");
    expect(lines).toContain("▏     indented();");
    // List items sit together; other blocks have a blank line between.
    expect(lines.indexOf("• first") + 1).toBe(lines.indexOf("• second item that is long enough to"));
  });

  test("links are recorded where they're drawn, and wrapped links keep their target", () => {
    const lay = layout(article, 14);
    expect(lay.links).toEqual([{ href: "https://example.com/x", line: expect.any(Number) }]);
    const at = lay.lines[lay.links[0]!.line]!;
    expect(at.cells.some((c) => c.link === 0)).toBe(true);
    const linked = lay.lines.flatMap((l) => l.cells.filter((c) => c.link === 0).map((c) => c.t.trim())).join(" ");
    expect(linked).toBe("link here");
  });

  test("a word longer than the line is cut", () => {
    const lay = layout({ title: "", byline: "", site: "", blocks: [{ k: "p", c: [{ t: "abcdefghijkl" }], ind: 0, q: 0 }] }, 5);
    expect(lay.lines.map(text)).toEqual(["abcde", "fghij", "kl"]);
  });

  test("table rows line up in columns when they fit, else wrap", () => {
    const sep = { t: " │ ", s: 8 };
    const rows: Article["blocks"] = [
      { k: "tr", c: [{ t: "Key", s: BOLD }, sep, { t: "Default", s: BOLD }], ind: 0, q: 0 },
      { k: "tr", c: [{ t: " log_requests ", s: CODE }, sep, { t: "false" }], ind: 0, q: 0 },
    ];
    const a = { title: "", byline: "", site: "", blocks: rows };
    expect(layout(a, 40).lines.map(text)).toEqual(["Key          │ Default", "log_requests │ false"]);
    expect(layout(a, 12).lines.map(text)).toEqual(["Key │", "Default", "log_requests", "│ false"]);
  });

  test("code style is kept", () => {
    const lay = layout({ title: "", byline: "", site: "", blocks: [{ k: "p", c: [{ t: "x" }, { t: "y()", s: CODE }], ind: 0, q: 0 }] }, 20);
    expect(lay.lines[0]!.cells.map((c) => c.sgr)).toEqual(["", "33"]);
  });
});

test("toMarkdown", () => {
  const md = toMarkdown(article);
  expect(md).toContain("# A title\n\n_Ada · Blog_");
  expect(md).toContain("Some **bold** and a [link here](https://example.com/x).");
  expect(md).toContain("## Section");
  expect(md).toContain("- first");
  expect(md).toContain("> quoted");
  expect(md).toContain("```js\nlet x = 1;\n\tindented();\n```");
});

describe("ReaderView", () => {
  const long: Article = {
    title: "Long",
    byline: "",
    site: "",
    blocks: Array.from({ length: 60 }, (_, i) => ({ k: "p" as const, c: [{ t: `para ${i}` }, ...(i % 10 === 5 ? [{ t: ` link${i}`, h: `https://e.x/${i}` }] : [])], ind: 0, q: 0 })),
  };
  const rect = { col: 1, row: 3, cols: 100, rows: 20 };

  test("scrolls within bounds and keeps its place across a resize", () => {
    const v = new ReaderView();
    v.setArticle(long, "https://e.x/");
    v.draw(rect, "hint", false);
    expect(v.scroll(-5)).toBe(false);
    expect(v.scroll(40)).toBe(true);
    const at = v.position();
    v.draw({ ...rect, cols: 40 }, "hint", false);
    expect(v.position()).toEqual(at);
    v.scrollTo(1e9);
    const lines = layout(long, columnWidth(40)).lines.length;
    expect(v.top).toBe(lines - (rect.rows - 1));
  });

  test("Tab walks links in view, and clicks find them", () => {
    const v = new ReaderView();
    v.setArticle(long, "https://e.x/");
    v.draw(rect, "hint", false);
    expect(v.moveFocus(1)).toBe(true);
    expect(v.focusedHref()).toBe("https://e.x/5");
    v.moveFocus(1);
    expect(v.focusedHref()).toBe("https://e.x/15");
    expect(v.top).toBeGreaterThan(0); // scrolled to show it
    const lay = v.layoutFor(rect.cols)!;
    const line = lay.links[1]!.line;
    const left = rect.col + Math.floor((rect.cols - lay.width) / 2);
    const row = rect.row + line - v.top;
    expect(v.linkAt(rect, left + width("para 15 "), row)).toBe("https://e.x/15");
    expect(v.linkAt(rect, left, row)).toBeNull();
  });

  test("the position keeps the place inside a long block, across reflows and visits", () => {
    const code: Article = {
      title: "",
      byline: "",
      site: "",
      blocks: [
        { k: "p", c: [{ t: "intro" }], ind: 0, q: 0 },
        { k: "pre", text: Array.from({ length: 60 }, (_, i) => `line ${String(i).padStart(3, "0")}`).join("\n"), ind: 0, q: 0 },
        { k: "p", c: [{ t: "outro" }], ind: 0, q: 0 },
      ],
    };
    const v = new ReaderView();
    v.setArticle(code, "u");
    v.draw(rect, "hint", false);
    v.scroll(29);
    const top = () => (v.layoutFor(rect.cols)!.lines[v.top]!.cells.map((c) => c.t).join(""));
    expect(top()).toBe("▏ line 027");
    // A narrower pane wraps nothing here: the same line stays on top.
    v.draw({ ...rect, cols: 60 }, "hint", false);
    expect(v.layoutFor(60)!.lines[v.top]!.cells.map((c) => c.t).join("")).toBe("▏ line 027");
    // A later visit starts where it was left.
    const w = new ReaderView();
    w.setArticle(code, "u", v.position());
    w.draw(rect, "hint", false);
    expect(w.layoutFor(rect.cols)!.lines[w.top]!.cells.map((c) => c.t).join("")).toBe("▏ line 027");
  });

  test("#fragments scroll to the block holding the id", () => {
    const withIds: Article = { ...long, blocks: long.blocks.map((b, i) => (i === 42 ? { ...b, a: ["closing"] } : b)) };
    const v = new ReaderView();
    v.setArticle(withIds, "u");
    v.draw(rect, "hint", false);
    expect(v.scrollToId("nope")).toBe(false);
    expect(v.scrollToId("closing")).toBe(true);
    expect(v.layoutFor(rect.cols)!.lines[v.top]!.cells.map((c) => c.t).join("")).toBe("para 42");
    // Before it's laid out too (an address with a #fragment).
    const w = new ReaderView();
    w.setArticle(withIds, "u");
    w.scrollToId("closing");
    w.draw(rect, "hint", false);
    expect(w.layoutFor(rect.cols)!.lines[w.top]!.cells.map((c) => c.t).join("")).toBe("para 42");
  });

  test("resizing back and forth never moves the reading position", () => {
    const words: Article = {
      title: "",
      byline: "",
      site: "",
      blocks: [{ k: "p", c: [{ t: Array.from({ length: 400 }, (_, i) => `word${String(i).padStart(3, "0")}`).join(" ") }], ind: 0, q: 0 }],
    };
    const v = new ReaderView();
    v.setArticle(words, "u");
    v.draw({ ...rect, cols: 140 }, "h", false);
    v.scroll(15);
    const first = () => v.layoutFor(140)!.lines[v.top]!.cells.map((c) => c.t).join("").split(" ")[0];
    const was = first();
    for (let i = 0; i < 5; i++) {
      v.draw({ ...rect, cols: 88 }, "h", false);
      v.draw({ ...rect, cols: 140 }, "h", false);
    }
    expect(first()).toBe(was);
  });

  test("# and #top go to the top; an unknown id stays put", () => {
    const v = new ReaderView();
    v.setArticle(long, "u");
    v.draw(rect, "h", false);
    v.scroll(30);
    expect(v.scrollToId("missing")).toBe(false);
    expect(v.top).toBe(30);
    expect(v.scrollToId("")).toBe(true);
    expect(v.top).toBe(0);
    v.scroll(30);
    expect(v.scrollToId("top")).toBe(true);
    expect(v.top).toBe(0);
  });

  test("the status line hides the row under it from clicks", () => {
    const v = new ReaderView();
    v.setArticle(long, "u");
    v.draw(rect, "hint", false);
    const lay = v.layoutFor(rect.cols)!;
    const left = rect.col + Math.floor((rect.cols - lay.width) / 2);
    // Scroll so a link sits on the last row, under the status line.
    const link = lay.links[1]!;
    v.scrollTo(link.line - (rect.rows - 1));
    const statusRow = rect.row + rect.rows - 1;
    expect(v.linkAt(rect, left + width("para 15 "), statusRow)).toBeNull();
    expect(v.linkAt(rect, left + width("para 15 "), statusRow - 1)).toBeNull(); // para 14
    v.scroll(1);
    expect(v.linkAt(rect, left + width("para 15 "), statusRow - 1)).toBe("https://e.x/15");
  });

  test("output has no stray controls beyond SGR, cursor moves and OSC 8", () => {
    const v = new ReaderView();
    v.setArticle(long, "https://e.x/");
    const s = v.draw(rect, "hint", false);
    const stripped = s.replace(/\x1b\[[0-9;]*[mH]/g, "").replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "");
    expect(stripped).not.toMatch(/[\x00-\x1f\x7f]/);
  });
});

test("injected scripts are self-contained expressions", () => {
  // Parsed (not run): Bun has no DOM.
  expect(() => new Function(`return ${EXTRACT_JS}`)).not.toThrow();
  expect(() => new Function(`return ${READERABLE_JS}`)).not.toThrow();
  expect(EXTRACT_JS).toContain("function Readability(");
  expect(READERABLE_JS).toContain("function isProbablyReaderable(");
});

test("ctl reader", () => {
  expect(parseCtl(["reader"]).req).toMatchObject({ cmd: "reader", reader: "toggle" });
  expect(parseCtl(["reader", "on", "3"]).req).toMatchObject({ cmd: "reader", reader: "on", tab: 3 });
  expect(parseCtl(["reader", "2"]).req).toMatchObject({ cmd: "reader", reader: "toggle", tab: 2 });
  expect(parseCtl(["reader", "off", "--tab", "4"]).req).toMatchObject({ reader: "off", tab: 4 });
});
