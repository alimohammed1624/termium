import { describe, expect, test } from "bun:test";
import { LineEdit, fit, toUrl, truncate } from "../src/text";
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
    e.key(key("w", { ctrl: true }));
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
