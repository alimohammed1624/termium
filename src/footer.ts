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
}

/** The layout key prefix. */
export const PREFIX = { combo: "ctrl+b", label: "^B" };

const act = (label: string, key: string, combo: string): FooterAction => ({ label, key, combo });
/** An action behind the prefix (as typed from normal mode). */
const pre = (label: string, k: string, combo = k): FooterAction => act(label, PREFIX.label + k, `${PREFIX.combo} ${combo}`);
/** A key once the prefix (or another mode) is waiting for one. */
const key = (label: string, k: string, combo = k.toLowerCase()): FooterAction => act(label, k, combo);

/** What each context offers, most useful first (what doesn't fit is left off the end). */
export const FOOTER_ACTIONS: Record<FooterContext, FooterAction[]> = {
  normal: [
    act("Address", "^L", "ctrl+l"),
    act("New tab", "^T", "ctrl+t"),
    pre("Split", "v"),
    act("Close", "^W", "ctrl+w"),
    act("Back", "Alt←", "alt+arrowleft"),
    act("Reload", "^R", "ctrl+r"),
    pre("Spaces", "w"),
    pre("Keys", "?"),
    pre("Hide", "f"),
  ],
  prefix: [
    key("Split→", "v"),
    key("Split↓", "-"),
    key("New tab", "c"),
    key("Close", "x"),
    key("Zoom", "z"),
    key("Resize", "r"),
    key("Spaces", "w"),
    key("Footer", "f"),
    key("Keys", "?"),
    key("Cancel", "Esc", "escape"),
    key("Next", "n"),
    key("Prev", "p"),
    key("Sidebar", "b"),
  ],
  resize: [
    key("Left", "h"),
    key("Down", "j"),
    key("Up", "k"),
    key("Right", "l"),
    key("Done", "Esc", "escape"),
  ],
  spaces: [
    key("Down", "j"),
    key("Up", "k"),
    key("Open", "Enter"),
    key("New", "N", "shift+n"),
    key("Cancel", "Esc", "escape"),
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

/** Shown when ^B f picks a mode. */
export const FOOTER_TOAST: Record<FooterMode, string> = {
  on: "Hint footer on (^B f: only with ^B)",
  auto: "Hint footer shows only while ^B waits for a key (^B f: off)",
  off: "Hint footer off (^B f: on)",
};

export const SEPARATOR = "·";

/** The text of one action in the footer. */
export function chipText(a: FooterAction): string {
  return ` ${a.label} ${a.key} `;
}

/**
 * The actions that fit in `w` columns, in order, each with its offset from
 * the row's start (chips are separated by SEPARATOR).
 */
export function layoutFooter(actions: FooterAction[], w: number): { action: FooterAction; start: number; end: number }[] {
  const out: { action: FooterAction; start: number; end: number }[] = [];
  let used = 0;
  for (const action of actions) {
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
