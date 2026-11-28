import { describe, expect, test } from "bun:test";
import { LineEdit, distinctTitles, fit, splitPaths, toUrl, truncate, width } from "../src/text";
import type { KeyEvent } from "../src/input";

const key = (k: string, mods: Partial<KeyEvent["mods"]> = {}, text = ""): KeyEvent => ({
  type: "key", key: k, code: "", vk: 0, text, event: "press", location: 0, legacy: false,
  mods: { shift: false, alt: false, ctrl: false, meta: false, ...mods },
});

describe("toUrl", () => {
  test.each([
    ["example.com", "https://example.com"],
    ["example.com/a?b=c", "https://example.com/a?b=c"],
    ["localhost:3000", "http://localhost:3000"],
    ["127.0.0.1:8080/x", "http://127.0.0.1:8080/x"],
    ["http://foo", "http://foo"],
    ["about:blank", "about:blank"],
    ["hello world", "https://duckduckgo.com/?q=hello%20world"],
    ["what is 2+2", "https://duckduckgo.com/?q=what%20is%202%2B2"],
    ["  ", null],
  ])("%p", (input, expected) => {
    expect(toUrl(input)).toBe(expected);
  });
});

describe("truncate / fit", () => {
  test("cuts by display width with an ellipsis", () => {
    expect(truncate("hello world", 6)).toBe("hello…");
    expect(truncate("日本語テキスト", 5)).toBe("日本…");
    expect(fit("ab", 4)).toBe("ab  ");
  });
});

describe("LineEdit", () => {
  test("typing replaces a selected-all value", () => {
    const e = new LineEdit("https://old.example", true);
    e.key(key("n", {}, "n"));
    expect(e.text).toBe("n");
  });
  test("cursor movement, word delete and submit", () => {
    const e = new LineEdit("", false);
    e.insert("foo bar");
    e.key(key("Backspace", { ctrl: true }));
    expect(e.text).toBe("foo ");
    e.key(key("Home"));
    e.key(key("x", {}, "x"));
    expect(e.text).toBe("xfoo ");
    expect(e.key(key("Enter"))).toBe("submit");
    expect(e.key(key("Escape"))).toBe("cancel");
  });
  test("paste strips newlines", () => {
    const e = new LineEdit("", false);
    e.insert("a\nb\tc");
    expect(e.text).toBe("a b c");
  });
});

describe("splitPaths", () => {
  test("quotes and escapes", () => {
    expect(splitPaths(`a.txt "my file.pdf" b\\ c.png  'd e'`)).toEqual(["a.txt", "my file.pdf", "b c.png", "d e"]);
    expect(splitPaths("   ")).toEqual([]);
  });
});

describe("control characters never reach the terminal", () => {
  test("C0 and C1 controls are replaced", () => {
    expect(fit("evil\x1b]52;c;AAAA\x07title\x9b2J", 30)).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    expect(truncate("a\x1b[31mb", 10)).toBe("a [31mb");
  });
});

describe("distinctTitles", () => {
  const tab = (title: string, url: string) => ({ title, url });

  test("unique titles stay unchanged", () => {
    expect(distinctTitles([tab("A", "https://a.com/"), tab("B", "https://a.com/")], 22)).toEqual(["A", "B"]);
  });

  test("adds the shortest part that differs", () => {
    expect(
      distinctTitles(
        [
          tab("Pull requests", "https://github.com/me/termium/pulls"),
          tab("Pull requests", "https://github.com/me/herdr/pulls"),
          tab("Other", "https://github.com/me/x"),
        ],
        30,
      ),
    ).toEqual(["Pull requests · termium", "Pull requests · herdr", "Other"]);
  });

  test("hosts and ports", () => {
    expect(distinctTitles([tab("T", "http://127.0.0.1:8000/"), tab("T", "http://localhost:8000/")], 22)).toEqual([
      "T · 127.0.0.1",
      "T · localhost",
    ]);
    expect(distinctTitles([tab("T", "http://localhost:3000/"), tab("T", "http://localhost:3001/")], 22)).toEqual([
      "T · :3000",
      "T · :3001",
    ]);
  });

  test("query and fragment", () => {
    expect(distinctTitles([tab("S", "https://a.com/?q=1"), tab("S", "https://a.com/?q=2")], 22)).toEqual([
      "S · ?q=1",
      "S · ?q=2",
    ]);
  });

  test("titles that only differ past the cut count as the same", () => {
    const out = distinctTitles(
      [tab("A very long page title one", "https://a.com/x"), tab("A very long page title two", "https://a.com/y")],
      22,
    );
    expect(out).toEqual(["A very long page… · x", "A very long page… · y"]);
    for (const s of out) expect(width(s)).toBeLessThanOrEqual(22);
  });

  test("the title gives way to the part, which is cut only past a minimum title", () => {
    expect(
      distinctTitles([tab("Dashboard overview", "https://one.example.com/"), tab("Dashboard overview", "https://two.example.com/")], 22),
    ).toEqual(["Dashboard overv… · one", "Dashboard overv… · two"]);
    const out = distinctTitles(
      [tab("Dashboard overview", "https://a.com/production-west"), tab("Dashboard overview", "https://a.com/staging-north")],
      22,
    );
    expect(out).toEqual(["Dashboa… · production…", "Dashboa… · staging-no…"]);
  });

  test("hosts that differ in a label", () => {
    expect(
      distinctTitles([tab("G", "https://metrics-production-eu.example.com/"), tab("G", "https://metrics-production-us.example.com/")], 22),
    ).toEqual(["G · …ics-production-eu", "G · …ics-production-us"]);
  });

  test("same parts in another order fall back to the whole URL, keeping its end", () => {
    const out = distinctTitles([tab("T", "https://a.com/x/y"), tab("T", "https://a.com/y/x")], 12);
    expect(out).toEqual(["T · …com/x/y", "T · …com/y/x"]);
  });

  test("a part cut short that no longer differs shows its end instead", () => {
    const a = "a".repeat(30);
    const out = distinctTitles([tab("Docs", `http://h/docs${a}1`), tab("Docs", `http://h/docs${a}2`)], 22);
    expect(out).toEqual([`Docs · …${"a".repeat(13)}1`, `Docs · …${"a".repeat(13)}2`]);
  });

  test("a label never copies another tab's title", () => {
    const out = distinctTitles(
      [tab("Docs", "http://h:1/docs/a"), tab("Docs", "http://h:1/docs/b"), tab("Docs · a", "http://h:1/literal")],
      22,
    );
    expect(out[2]).toBe("Docs · a");
    expect(new Set(out).size).toBe(3);
  });

  test("prefers host and path over query and fragment", () => {
    expect(
      distinctTitles([tab("Docs", "https://a.com/project-alpha?a"), tab("Docs", "https://a.com/project-bravo?b")], 22),
    ).toEqual(["Docs · project-alpha", "Docs · project-bravo"]);
  });

  test("www and bare host are different URLs", () => {
    expect(distinctTitles([tab("D", "https://www.x.com/d"), tab("D", "https://x.com/d")], 22)).toEqual([
      "D · www.x.com",
      "D · x.com/d",
    ]);
  });

  test("tabs on the same URL, or with no URL, are left alone", () => {
    expect(distinctTitles([tab("T", "https://a.com/"), tab("T", "https://a.com/")], 22)).toEqual(["T", "T"]);
    expect(distinctTitles([tab("New Tab", ""), tab("New Tab", "")], 22)).toEqual(["New Tab", "New Tab"]);
    // Two on one URL and a third elsewhere: the third still stands out.
    expect(
      distinctTitles([tab("T", "https://a.com/"), tab("T", "https://a.com/"), tab("T", "https://b.com/")], 22),
    ).toEqual(["T · a", "T · a", "T · b"]);
  });

  test("decodes the part and strips controls", () => {
    expect(distinctTitles([tab("T", "https://a.com/caf%C3%A9"), tab("T", "https://a.com/x%07y")], 22)).toEqual([
      "T · café",
      "T · xy",
    ]);
  });
});
