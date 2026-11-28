// Reopening closed tabs and spaces: what's kept of them, and how a
// reopened page gets its back/forward list again.
import type { SavedNode } from "./session";

/** Closed tabs and spaces kept for reopening; the oldest goes past this. */
export const CLOSED_MAX = 20;
/** History entries rebuilt behind and ahead of a reopened page's current one. */
export const REPLAY_BACK = 9;
export const REPLAY_FORWARD = 3;

/** A page's history as Page.getNavigationHistory gives it. */
export interface NavHistory {
  currentIndex: number;
  entries: { url: string }[];
}

/** A closed tab: its splits with their addresses, and each page's history (leftmost first) where it could be read. */
export interface ClosedTab {
  root: SavedNode;
  focus: number;
  zoomed: boolean;
  history: (Promise<NavHistory | null> | undefined)[];
  /** Its order key in its space (see Tab.pos in app.ts). */
  pos: number;
}

/**
 * The addresses to load into a fresh page, oldest first, so its history
 * comes back around the entry it was on: the page opens at the first, the
 * rest load in turn, then it goes `forward` entries back to where it was.
 * Entries `skip` says aren't real pages (termium's blank placeholder) are
 * left out, and repeats in a row (which would load as one) are merged.
 * Null if the current entry is one of those.
 */
export function replayPlan(h: NavHistory, skip: (url: string) => boolean): { urls: string[]; forward: number } | null {
  const urls: string[] = [];
  let current = -1;
  h.entries.forEach((e, i) => {
    if (typeof e?.url !== "string" || skip(e.url)) return;
    if (urls[urls.length - 1] !== e.url) urls.push(e.url);
    if (i === h.currentIndex) current = urls.length - 1;
  });
  if (current < 0) return null;
  const start = Math.max(0, current - REPLAY_BACK);
  const end = Math.min(urls.length - 1, current + REPLAY_FORWARD);
  return { urls: urls.slice(start, end + 1), forward: end - current };
}

/** Each leaf's address in `n`, replaced by `url(i, old)` (leaves numbered from the left). */
export function mapLeaves(n: SavedNode, url: (i: number, old: string) => string, first = 0): SavedNode {
  if ("url" in n) return { url: url(first, n.url) };
  return { ...n, a: mapLeaves(n.a, url, first), b: mapLeaves(n.b, url, first + countLeaves(n.a)) };
}

export function countLeaves(n: SavedNode): number {
  return "url" in n ? 1 : countLeaves(n.a) + countLeaves(n.b);
}
