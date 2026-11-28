import { describe, expect, test } from "bun:test";
import { LineEdit, fade, fadeFit, fit, splitPaths, toUrl, truncate, width } from "../src/text";
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

describe("fade", () => {
  const sgr = (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`;
  test("text that fits is unchanged", () => {
    expect(fade("hello", 5, "ffffff", "000000")).toBe("hello");
  });
  test("cut-off text ends in 3 cells shading toward the background", () => {
    // The cut lands on the blank after "hello": the fade covers letters, not the blank.
    const out = fade("hello world", 6, "ffffff", "000000");
    expect(out).toBe(`he${sgr(191, 191, 191)}l${sgr(128, 128, 128)}l${sgr(64, 64, 64)}o${sgr(255, 255, 255)}`);
    expect(width(out)).toBe(5);
    expect(out).not.toContain("…");
  });
  test("fills the full width when the cut lands on a letter", () => {
    const out = fade("abcdefghij", 6, "ffffff", "000000");
    expect(out).toBe(`abc${sgr(191, 191, 191)}d${sgr(128, 128, 128)}e${sgr(64, 64, 64)}f${sgr(255, 255, 255)}`);
    expect(width(out)).toBe(6);
  });
  test("wide characters and short fields", () => {
    expect(width(fade("日本語テキスト", 5, "ffffff", "000000"))).toBe(4);
    // Wide letters: the fade covers about 3 columns, not 3 letters.
    expect(fade("日本語テキスト", 8, "ffffff", "000000")).toBe(`日本${sgr(170, 170, 170)}語${sgr(85, 85, 85)}テ${sgr(255, 255, 255)}`);
    expect(fade("abc", 2, "ffffff", "000000")).toBe(`a${sgr(128, 128, 128)}b${sgr(255, 255, 255)}`);
    expect(fade("abc", 0, "ffffff", "000000")).toBe("");
  });
  test("controls are blanked and fadeFit pads to the width", () => {
    expect(fade("a\x1bb", 5, "ffffff", "000000")).toBe("a b");
    const out = fadeFit("hello world", 6, "ffffff", "000000");
    expect(width(out)).toBe(6);
    expect(out.endsWith(" ")).toBe(true);
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
