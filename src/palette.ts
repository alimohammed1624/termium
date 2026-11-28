/**
 * The popup address bar's list (Ctrl+L): open or search what's typed, the
 * actions termium has (each with its shortcut), open tabs, and pages seen
 * before, filtered by what's typed. Pure: the app supplies the entries.
 */

export type PaletteKind = "go" | "action" | "tab" | "history";

export interface PaletteItem {
  kind: PaletteKind;
  /** What the row says. */
  text: string;
  /** Shown dimmed at the right (an action's shortcut, a tab's place...). */
  hint?: string;
  /** Also matched, never shown (an address, other words for an action). */
  keywords?: string;
  run: () => void;
}

/** An action and its shortcut (see App.commandActions). */
export interface PaletteAction {
  label: string;
  keys: string;
  keywords?: string;
  run: () => void;
}

export function actionItem(a: PaletteAction): PaletteItem {
  return { kind: "action", text: a.label, hint: a.keys, keywords: a.keywords, run: a.run };
}

/** Every word of `query` appears in the item's text, hint or keywords (case-insensitive). */
export function itemMatches(item: PaletteItem, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${item.text} ${item.hint ?? ""} ${item.keywords ?? ""}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

const ORDER: PaletteKind[] = ["action", "tab", "history"];

/**
 * The rows for `query`: `go` (open or search the typed text) first, so
 * Enter does what the address bar always did; then the actions, tabs and
 * history that match, in that order, each group's matches at the start of
 * their text first.
 */
export function paletteRows(query: string, go: PaletteItem | null, items: PaletteItem[]): PaletteItem[] {
  const q = query.trim().toLowerCase();
  const starts = (it: PaletteItem) => (q && it.text.toLowerCase().startsWith(q) ? 0 : 1);
  const found = items
    .filter((it) => itemMatches(it, q))
    .map((it, i) => ({ it, i }))
    .sort((a, b) => ORDER.indexOf(a.it.kind) - ORDER.indexOf(b.it.kind) || starts(a.it) - starts(b.it) || a.i - b.i)
    .map(({ it }) => it);
  return go ? [go, ...found] : found;
}
