// Chrome colors: the palette the sidebar, tab strip, address bar, dialogs
// and <select> popups are drawn with. By default ("auto") it follows the
// terminal's own colors, which the client asks for as it attaches (OSC 10,
// 11 and 4); a fixed theme can be chosen with --theme or $TERMIUM_THEME.

/** Every chrome color, as 6-digit hex without "#". */
export interface Palette {
  /** Bars, dialogs and the active tab (the terminal's background in "auto"). */
  background: string;
  /** Behind everything else: the tab strip, around dialogs, between panes. */
  backdrop: string;
  /** The sidebar and unfocused pane titles. */
  panel: string;
  /** Text fields (the address bar). */
  surface: string;
  /** Hovered, selected or focused items; separators. */
  hover: string;
  /** Text: the main color. */
  text: string;
  /** Secondary text. */
  muted: string;
  /** Hints and inactive items. */
  dim: string;
  /** The accent: the termium title, headings, the mode badge. */
  accent: string;
  /** Text on an accent background. */
  onAccent: string;
  /** Commands to copy, links. */
  link: string;
  green: string;
  red: string;
  yellow: string;
  /** Text on a yellow background. */
  onYellow: string;
  orange: string;
}

/** What the terminal said about its colors: hex strings, any of them missing. */
export interface TermColors {
  fg?: string;
  bg?: string;
  /** ANSI palette entries by index (0–15). */
  ansi?: Record<number, string>;
}

export const THEMES = ["auto", "catppuccin", "catppuccin-mocha", "catppuccin-latte"] as const;
export type ThemeName = (typeof THEMES)[number];

export function isTheme(name: unknown): name is ThemeName {
  return typeof name === "string" && (THEMES as readonly string[]).includes(name);
}

/** ANSI palette entries the chrome uses (asked for at attach). */
export const ANSI_QUERIED = [1, 2, 3, 4, 9, 10, 11, 12] as const;

/** Catppuccin Mocha: termium's original look, and "auto"'s when the terminal doesn't say. */
export const CATPPUCCIN_MOCHA: Palette = {
  background: "1e1e2e",
  backdrop: "11111b",
  panel: "181825",
  surface: "313244",
  hover: "45475a",
  text: "cdd6f4",
  muted: "a6adc8",
  dim: "6c7086",
  accent: "cba6f7",
  onAccent: "11111b",
  link: "89b4fa",
  green: "a6e3a1",
  red: "f38ba8",
  yellow: "f9e2af",
  onYellow: "11111b",
  orange: "fab387",
};

/** Catppuccin Latte, the light flavor (yellow, green and orange a shade darker, to read on its light background). */
export const CATPPUCCIN_LATTE: Palette = {
  background: "eff1f5",
  backdrop: "dce0e8",
  panel: "e6e9ef",
  surface: "ccd0da",
  hover: "bcc0cc",
  text: "4c4f69",
  muted: "6c6f85",
  dim: "7c7f93",
  accent: "8839ef",
  onAccent: "eff1f5",
  link: "1e66f5",
  green: "38962a",
  red: "d20f39",
  yellow: "c27a10",
  onYellow: "eff1f5",
  orange: "e0560a",
};

/** The palette for `theme` ("auto" if unset) in a terminal with `colors`. */
export function resolvePalette(theme: string | undefined, colors: TermColors | undefined): Palette {
  if (theme === "catppuccin-latte") return CATPPUCCIN_LATTE;
  if (theme === "catppuccin" || theme === "catppuccin-mocha") return CATPPUCCIN_MOCHA;
  return (colors && fromTerminal(colors)) ?? CATPPUCCIN_MOCHA;
}

/**
 * Chrome colors derived from the terminal's: its background and text, with
 * shades between them for panels and fields (darker panels on a dark
 * background, as Catppuccin has them), the accent from palette 12 (bright
 * blue) and red/green/yellow from 9–11. Colors too faint against the
 * background are moved toward the text color until they read. Null if the
 * terminal didn't give its background.
 */
export function fromTerminal(t: TermColors): Palette | null {
  const bgc = hex(t.bg);
  if (!bgc) return null;
  let fgc = hex(t.fg);
  const dark = fgc ? luminance(bgc) < luminance(fgc) : luminance(bgc) < 0.18;
  fgc ??= dark ? "d8d8d8" : "282828";
  const ansi = (...ix: number[]) => ix.map((i) => hex(t.ansi?.[i])).find((c) => c) ?? null;

  let background = bgc;
  let backdrop: string;
  let panel: string;
  if (dark) {
    backdrop = mix(bgc, "000000", 0.45);
    panel = mix(bgc, "000000", 0.2);
    // Near-black: nothing darker to put behind, so the chrome is lifted instead.
    if (contrast(bgc, backdrop) < 1.08) {
      backdrop = bgc;
      panel = mix(bgc, fgc, 0.05);
      background = mix(bgc, fgc, 0.1);
    }
  } else {
    backdrop = mix(bgc, fgc, 0.12);
    panel = mix(bgc, fgc, 0.055);
  }
  // Text on the chrome needs contrast, but never more than the terminal's own text has.
  const most = contrast(fgc, background) * 0.9;
  const read = (c: string, min = 3, on = background) => readable(c, on, fgc, Math.min(min, most));
  // Fields and hovered items: shades of the background, kept light enough in a light theme for text to read on them.
  const surface = mix(background, fgc, dark ? 0.12 : 0.08);
  const hover = mix(background, fgc, dark ? 0.2 : 0.14);
  const red = read(ansi(9, 1) ?? (dark ? CATPPUCCIN_MOCHA.red : CATPPUCCIN_LATTE.red));
  const yellow = read(ansi(11, 3) ?? (dark ? CATPPUCCIN_MOCHA.yellow : CATPPUCCIN_LATTE.yellow));
  // The accent also carries text (the mode badge, the selected <select> item).
  const accent = read(ansi(12, 4) ?? (dark ? CATPPUCCIN_MOCHA.link : CATPPUCCIN_LATTE.link), 4.5);
  const ink = (on: string) => [backdrop, background, fgc].reduce((a, b) => (contrast(b, on) > contrast(a, on) ? b : a));
  return {
    background,
    backdrop,
    panel,
    surface,
    hover,
    text: fgc,
    muted: read(mix(background, fgc, 0.75), 4.5),
    // Labels in fields (the address bar's "upload:" prompt) are dim on hover.
    dim: read(mix(background, fgc, 0.45), 3, hover),
    accent,
    onAccent: ink(accent),
    link: read(ansi(4, 12) ?? accent),
    green: read(ansi(10, 2) ?? (dark ? CATPPUCCIN_MOCHA.green : CATPPUCCIN_LATTE.green)),
    red,
    yellow,
    onYellow: ink(yellow),
    orange: read(mix(red, yellow, 0.5)),
  };
}

/** `v` (from a client) as TermColors, keeping only well-formed colors. */
export function termColors(v: unknown): TermColors | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const out: TermColors = {};
  const fgc = hex(o.fg);
  const bgc = hex(o.bg);
  if (fgc) out.fg = fgc;
  if (bgc) out.bg = bgc;
  if (o.ansi && typeof o.ansi === "object") {
    for (const [k, c] of Object.entries(o.ansi as Record<string, unknown>)) {
      const i = Number(k);
      const h = hex(c);
      if (Number.isInteger(i) && i >= 0 && i < 16 && h) (out.ansi ??= {})[i] = h;
    }
  }
  return out;
}

/**
 * A color from a terminal's OSC 4/10/11 reply ("rgb:RRRR/GGGG/BBBB" with 1–4
 * hex digits per channel, "rgba:…" or "#RRGGBB"), as 6-digit hex.
 */
export function parseColorSpec(spec: string): string | null {
  const m = /^rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})(?:\/[0-9a-f]{1,4})?$/i.exec(spec.trim());
  if (m) return [m[1]!, m[2]!, m[3]!].map((c) => byte(Math.round((parseInt(c, 16) / (16 ** c.length - 1)) * 255))).join("");
  const h = /^#((?:[0-9a-f]{3}){1,4})$/i.exec(spec.trim());
  if (h) {
    const n = h[1]!.length / 3;
    return [0, 1, 2].map((i) => h[1]!.slice(i * n, i * n + n)).map((c) => byte(Math.round((parseInt(c, 16) / (16 ** n - 1)) * 255))).join("");
  }
  return null;
}

/** `c` if it's 6-digit hex (lowercased), else null. */
export function hex(c: unknown): string | null {
  return typeof c === "string" && /^[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : null;
}

const byte = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0");
const channels = (c: string) => [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16));

/** `a` moved toward `b` by `t` (0–1). */
export function mix(a: string, b: string, t: number): string {
  const x = channels(a);
  const y = channels(b);
  return x.map((v, i) => byte(Math.round(v + (y[i]! - v) * t))).join("");
}

/** WCAG relative luminance. */
export function luminance(c: string): number {
  const [r, g, b] = channels(c).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** WCAG contrast ratio (1–21). */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** `c`, moved toward `toward` until its contrast with `bg` is at least `min`. */
function readable(c: string, bg: string, toward: string, min: number): string {
  for (let i = 0; i < 12 && contrast(c, bg) < min; i++) c = mix(c, toward, 0.2);
  return c;
}
