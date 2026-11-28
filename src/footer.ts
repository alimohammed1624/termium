// The hint footer: one row listing what can be done right now, each action
// with its key and clickable. A click presses the action's keys, so it runs
// exactly what the keybind runs. The actions and their key labels all live
// here, in one table (a command palette, mouse menus or a configurable
// prefix key can read or rewrite them from this one place).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { printableKey, type KeyEvent } from "./input";
import { width } from "./text";

/**
 * "on": a footer row under the panes, always (the default until the person
 * picks another). "auto": the row belongs to the page; the actions show in
 * the address line only while a key prefix or mode (^B, resize, spaces)
 * waits for a key. "off": never.
 */
export type FooterMode = "on" | "auto" | "off";
export const FOOTER_MODES: FooterMode[] = ["on", "auto", "off"];

export type FooterContext =
  | "normal" | "prefix" | "resize" | "spaces" | "help"
  | "url" | "rename" | "file" | "confirm" | "dialog" | "alert" | "leave";

export interface FooterAction {
  label: string;
  /** The key as shown ("^Bv", "Enter"). */
  key: string;
  /** The keys a click presses, space-separated combos as comboOf names them ("ctrl+b v"). */
  combo: string;
  /** Kept when space runs out (the way to everything else, or out of the mode). */
  pin?: boolean;
  /** Only offered where it does something (see FooterState). */
  needs?: keyof FooterState;
}

/** Which actions do something right now. */
export interface FooterState {
  /** More than one pane in the tab. */
  panes: boolean;
  /** More than one tab in the space. */
  tabs: boolean;
  /** More than one space. */
  spaces: boolean;
  /** The focused pane is in a side-by-side split (left/right resize it). */
  sideBySide: boolean;
  /** The focused pane is in a stacked split (up/down resize it). */
  stacked: boolean;
}
const EVERYTHING: FooterState = { panes: true, tabs: true, spaces: true, sideBySide: true, stacked: true };

/** The layout key prefix. */
export const PREFIX = { combo: "ctrl+b", label: "^B" };

const act = (label: string, key: string, combo: string): FooterAction => ({ label, key, combo });
const pin = (a: FooterAction): FooterAction => ({ ...a, pin: true });
const needs = (n: FooterAction["needs"], a: FooterAction): FooterAction => ({ ...a, needs: n });
/** An action behind the prefix (as typed from normal mode). */
const pre = (label: string, k: string, combo = k): FooterAction => act(label, PREFIX.label + k, `${PREFIX.combo} ${combo}`);
/** A key once the prefix (or another mode) is waiting for one. */
const key = (label: string, k: string, combo = k.toLowerCase()): FooterAction => act(label, k, combo);

/** What each context offers, most useful first (what doesn't fit is left off the end, pinned ones last). */
export const FOOTER_ACTIONS: Record<FooterContext, FooterAction[]> = {
  normal: [
    act("Address", "^L", "ctrl+l"),
    act("New tab", "^T", "ctrl+t"),
    pre("Split", "v"),
    act("Close", "^W", "ctrl+w"),
    act("Back", "Alt←", "alt+arrowleft"),
    act("Reload", "^R", "ctrl+r"),
    pre("Spaces", "w"),
    pin(pre("Keys", "?")),
    pin(pre("Hide", "i")),
  ],
  prefix: [
    key("Split→", "v"),
    key("Split↓", "-"),
    key("New tab", "c"),
    key("Close", "x"),
    needs("panes", key("Zoom", "z")),
    needs("panes", key("Resize", "r")),
    key("Spaces", "w"),
    pin(key("Footer", "i")),
    pin(key("Keys", "?")),
    pin(key("Cancel", "Esc", "escape")),
    needs("tabs", key("Next", "n")),
    needs("tabs", key("Prev", "p")),
    key("Sidebar", "b"),
  ],
  resize: [
    needs("sideBySide", key("Left", "h")),
    needs("stacked", key("Down", "j")),
    needs("stacked", key("Up", "k")),
    needs("sideBySide", key("Right", "l")),
    pin(key("Done", "Esc", "escape")),
  ],
  spaces: [
    key("Open", "Enter"),
    key("New", "N", "shift+n"),
    needs("spaces", key("Down", "j")),
    needs("spaces", key("Up", "k")),
    pin(key("Cancel", "Esc", "escape")),
  ],
  help: [key("Close", "Esc", "escape")],
  url: [key("Go", "Enter"), key("Cancel", "Esc", "escape")],
  rename: [key("Rename", "Enter"), key("Cancel", "Esc", "escape")],
  file: [key("Upload", "Enter"), key("Cancel", "Esc", "escape")],
  confirm: [key("Yes", "Enter"), key("No", "Esc", "escape")],
  dialog: [key("OK", "Enter"), key("Cancel", "Esc", "escape")],
  alert: [key("OK", "Enter")],
  leave: [key("Leave", "Enter"), key("Stay", "Esc", "escape")],
};

/** Shown when ^B i picks a mode. */
export const FOOTER_TOAST: Record<FooterMode, string> = {
  on: "Hint footer on (^B i: only with ^B)",
  auto: "Hint footer shows only while ^B waits for a key (^B i: off)",
  off: "Hint footer off (^B i: on)",
};

export const SEPARATOR = "·";

/** The text of one action in the footer. */
export function chipText(a: FooterAction): string {
  return ` ${a.label} ${a.key} `;
}

/**
 * The actions that do something in `state` and fit in `w` columns, in
 * order, each with its offset from the row's start (chips are separated by
 * SEPARATOR). Short of room, unpinned actions go first, from the end.
 */
export function layoutFooter(
  actions: FooterAction[],
  w: number,
  state: FooterState = EVERYTHING,
): { action: FooterAction; start: number; end: number }[] {
  const shown = actions.filter((a) => !a.needs || state[a.needs]);
  const total = (list: FooterAction[]) => list.reduce((n, a, i) => n + width(chipText(a)) + (i ? width(SEPARATOR) : 0), 0);
  while (total(shown) > w) {
    const drop = shown.findLastIndex((a) => !a.pin);
    shown.splice(drop >= 0 ? drop : shown.length - 1, 1);
  }
  const out: { action: FooterAction; start: number; end: number }[] = [];
  let used = 0;
  for (const action of shown) {
    const start = used + (out.length ? width(SEPARATOR) : 0);
    const end = start + width(chipText(action));
    if (end > w) break;
    out.push({ action, start, end });
    used = end;
  }
  return out;
}

const NAMED: Record<string, { key: string; code: string; vk: number; text?: string }> = {
  enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  escape: { key: "Escape", code: "Escape", vk: 27 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
};
/** Symbols typed with Shift (US layout). */
const SHIFTED = "?~!@#$%^&*()_+{}|:\"<>";

/** The key press a combo names (comboOf's inverse, for the keys the footer uses). */
export function keyOf(combo: string): KeyEvent {
  const parts = combo.split("+");
  const name = parts.pop()!;
  const shift = parts.includes("shift") || SHIFTED.includes(name);
  const mods = { ctrl: parts.includes("ctrl"), alt: parts.includes("alt"), meta: parts.includes("super"), shift };
  const named = NAMED[name];
  const key = named?.key ?? (/^[a-z]$/.test(name) && shift ? name.toUpperCase() : name);
  const { code, vk } = named ?? printableKey(key);
  const text = named ? (named.text ?? "") : mods.ctrl || mods.alt || mods.meta ? "" : key;
  return { type: "key", key, code, vk, text, mods, event: "press", location: 0, legacy: true };
}

/** The saved mode, unless TERMIUM_FOOTER picks one; "on" for someone who never picked. */
export function loadFooterMode(file: string, env: Record<string, string | undefined> = process.env): FooterMode {
  const forced = env.TERMIUM_FOOTER as FooterMode;
  if (FOOTER_MODES.includes(forced)) return forced;
  try {
    const saved = JSON.parse(readFileSync(file, "utf8"))?.footer;
    if (FOOTER_MODES.includes(saved)) return saved;
  } catch {}
  return "on";
}

/** Remembers the mode for later sessions; false if it couldn't be saved. */
export function saveFooterMode(file: string, mode: FooterMode): boolean {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ footer: mode }) + "\n", { mode: 0o600 });
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}
