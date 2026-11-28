import { describe, expect, test } from "bun:test";
import { InputParser, type InputEvent } from "../src/input";
import { selectPopupColors } from "../src/select-popup";
import {
  CATPPUCCIN_LATTE,
  CATPPUCCIN_MOCHA,
  contrast,
  fromTerminal,
  luminance,
  parseColorSpec,
  resolvePalette,
  termColors,
  type Palette,
  type TermColors,
} from "../src/theme";

// Terminal themes as they'd answer OSC 10/11/4.
const SOLARIZED_LIGHT: TermColors = {
  fg: "657b83", bg: "fdf6e3",
  ansi: { 1: "dc322f", 2: "859900", 3: "b58900", 4: "268bd2", 9: "cb4b16", 10: "586e75", 11: "657b83", 12: "839496" },
};
const XTERM_LIGHT: TermColors = { fg: "000000", bg: "ffffff", ansi: { 9: "ff0000", 10: "00ff00", 11: "ffff00", 12: "5c5cff" } };
const GRUVBOX_DARK: TermColors = { fg: "ebdbb2", bg: "282828", ansi: { 9: "fb4934", 10: "b8bb26", 11: "fabd2f", 12: "83a598" } };
const BLACK: TermColors = { fg: "c0c0c0", bg: "000000" };

/**
 * Every pairing the chrome draws, with the contrast it needs. Text on the
 * terminal's own background is as readable as the terminal makes it
 * (Solarized's is 4.1:1); the chrome's shades keep most of that.
 */
function checkReadable(p: Palette, derived = true) {
  const base = Math.min(4.5, contrast(p.text, p.background));
  const pairs: [string, string, string, number][] = [
    ["text/background", p.text, p.background, base],
    ["text/panel", p.text, p.panel, base * 0.9],
    ["text/surface", p.text, p.surface, base * 0.8],
    ["text/hover", p.text, p.hover, base * 0.7],
    ["muted/background", p.muted, p.background, Math.min(4, base * 0.9)],
    ["dim/background", p.dim, p.background, 2.8],
    // (Catppuccin's own dim on its hover color is fainter: it's kept as it is.)
    ["dim/hover", p.dim, p.hover, derived ? Math.min(2.8, base * 0.85) : 1],
    ["accent/background", p.accent, p.background, 2.8],
    ["onAccent/accent", p.onAccent, p.accent, Math.min(4.4, base * 0.85)],
    ["onYellow/yellow", p.onYellow, p.yellow, 2.8],
    ["red/background", p.red, p.background, 2.8],
    ["green/background", p.green, p.background, 2.8],
    ["yellow/background", p.yellow, p.background, 2.8],
  ];
  for (const [name, a, b, min] of pairs) expect({ name, ratio: contrast(a, b) >= min }).toEqual({ name, ratio: true });
}

describe("parseColorSpec", () => {
  test("xterm rgb: replies with 1–4 digits a channel", () => {
    expect(parseColorSpec("rgb:ffff/8080/0000")).toBe("ff8000");
    expect(parseColorSpec("rgb:1e1e/1e1e/2e2e")).toBe("1e1e2e");
    expect(parseColorSpec("rgb:f/8/0")).toBe("ff8800");
    expect(parseColorSpec("rgb:ff/80/00")).toBe("ff8000");
    expect(parseColorSpec("rgba:ffff/0000/0000/ffff")).toBe("ff0000");
  });
  test("#hex", () => {
    expect(parseColorSpec("#FDF6E3")).toBe("fdf6e3");
    expect(parseColorSpec("#fff")).toBe("ffffff");
  });
  test("garbage", () => {
    expect(parseColorSpec("?")).toBeNull();
    expect(parseColorSpec("rgb:zz/00/00")).toBeNull();
    expect(parseColorSpec("")).toBeNull();
  });
});

describe("palettes", () => {
  test("fixed themes ignore the terminal", () => {
    expect(resolvePalette("catppuccin", SOLARIZED_LIGHT)).toBe(CATPPUCCIN_MOCHA);
    expect(resolvePalette("catppuccin-mocha", SOLARIZED_LIGHT)).toBe(CATPPUCCIN_MOCHA);
    expect(resolvePalette("catppuccin-latte", GRUVBOX_DARK)).toBe(CATPPUCCIN_LATTE);
  });
  test("auto without the terminal's background is Catppuccin Mocha, as before", () => {
    expect(resolvePalette("auto", undefined)).toBe(CATPPUCCIN_MOCHA);
    expect(resolvePalette(undefined, {})).toBe(CATPPUCCIN_MOCHA);
    expect(resolvePalette("auto", { fg: "ffffff" })).toBe(CATPPUCCIN_MOCHA);
  });
  test("a light terminal gets a light chrome", () => {
    for (const t of [SOLARIZED_LIGHT, XTERM_LIGHT]) {
      expect(contrast(t.fg!, t.bg!)).toBeGreaterThan(4);
      const p = resolvePalette("auto", t);
      expect(p.background).toBe(t.bg!);
      expect(p.text).toBe(t.fg!);
      expect(luminance(p.background)).toBeGreaterThan(0.5);
      expect(luminance(p.backdrop)).toBeGreaterThan(0.4);
      checkReadable(p);
    }
  });
  test("a dark terminal gets a dark chrome in its own colors", () => {
    const p = resolvePalette("auto", GRUVBOX_DARK);
    expect(p.background).toBe("282828");
    expect(p.text).toBe("ebdbb2");
    expect(p.accent).toBe("83a598");
    expect(p.red).toBe("fb4934");
    expect(luminance(p.backdrop)).toBeLessThan(luminance(p.background));
    checkReadable(p);
  });
  test("a black background still sets the chrome apart", () => {
    const p = fromTerminal(BLACK)!;
    expect(contrast(p.background, p.backdrop)).toBeGreaterThan(1.1);
    checkReadable(p);
  });
  test("the Catppuccin palettes read too", () => {
    checkReadable(CATPPUCCIN_MOCHA, false);
    checkReadable(CATPPUCCIN_LATTE, false);
  });
});

test("termColors keeps only well-formed colors", () => {
  expect(termColors({ fg: "ABCDEF", bg: "nope", ansi: { 12: "123456", 99: "123456", x: "123456", 3: 5 } })).toEqual({
    fg: "abcdef",
    ansi: { 12: "123456" },
  });
  expect(termColors("x")).toBeUndefined();
});

test("selectPopupColors sets the popup's colors from the palette", () => {
  const js = selectPopupColors(CATPPUCCIN_LATTE);
  const w: any = {};
  new Function("window", js)(w);
  expect(w.__termiumColors).toMatchObject({ bg: "#eff1f5", text: "#4c4f69", on: "#8839ef", onText: "#eff1f5" });
});

describe("input parser (legacy keys: ESC ] is also Alt+])", () => {
  const parser = (expectApc = false) => {
    const evs: any[] = [];
    const p = new InputParser((e) => evs.push(e));
    p.expectApc = expectApc;
    return { p, evs };
  };
  const stall = () => Bun.sleep(80);
  const colors = [
    { type: "color", which: "fg", spec: "rgb:cdcd/d6d6/f4f4" },
    { type: "color", which: "bg", spec: "rgb:1e1e/1e1e/2e2e" },
    { type: "color", which: 12, spec: "rgb:89/b4/fa" },
  ];
  const replies = "\x1b]10;rgb:cdcd/d6d6/f4f4\x1b\\\x1b]11;rgb:1e1e/1e1e/2e2e\x07\x1b]4;12;rgb:89/b4/fa\x1b\\";
  test("reads color replies", () => {
    const { p, evs } = parser(true);
    p.feed(replies);
    expect(evs).toEqual(colors);
  });
  test("reads a color reply split across reads", () => {
    const { p, evs } = parser();
    for (const part of ["\x1b]", "11;rgb:fd", "fd/f6f6/e3e3\x1b", "\\x"]) p.feed(part);
    expect(evs.map((e) => e.type === "color" ? e.spec : e.key)).toEqual(["rgb:fdfd/f6f6/e3e3", "x"]);
  });
  test("a color reply split by a pause is still read, not typed", async () => {
    const { p, evs } = parser();
    p.feed("\x1b]11;rgb:fd");
    await Bun.sleep(150);
    p.feed("fd/f6f6/e3e3\x1b\\x");
    expect(evs.map((e) => (e.type === "color" ? e.spec : e.key))).toEqual(["rgb:fdfd/f6f6/e3e3", "x"]);
  });
  test("a lone Alt+] is a key, after a moment", async () => {
    const { p, evs } = parser();
    p.feed("\x1b]");
    await stall();
    expect(evs.map((e) => e.key)).toEqual(["]"]);
    p.feed("\x1b]");
    p.feed("1");
    await stall();
    p.feed("x");
    expect(evs.map((e) => e.key)).toEqual(["]", "]", "1", "x"]);
  });
  test("Alt+] and text typed together are keys", () => {
    const { p, evs } = parser();
    p.feed("\x1b]ab");
    expect(evs.map((e) => e.key)).toEqual(["]", "a", "b"]);
  });
  test("Alt+] while replies are awaited doesn't swallow them", () => {
    const { p, evs } = parser(true);
    p.feed("\x1b]\x1b_Gi=31;OK\x1b\\" + replies);
    expect(evs).toEqual([expect.objectContaining({ type: "key", key: "]" }), { type: "kittyGraphics", id: 31, message: "OK" }, ...colors]);
  });
});
