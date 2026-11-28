// Split-pane layout tree (herdr/tmux style) and its geometry.

export interface Rect {
  col: number; // 1-based
  row: number; // 1-based
  cols: number;
  rows: number;
}

export type Dir = "h" | "v"; // h: side by side, v: stacked

export interface Leaf<T> {
  kind: "leaf";
  item: T;
}
export interface Split<T> {
  kind: "split";
  dir: Dir;
  ratio: number; // share of the first child, 0..1
  a: Node<T>;
  b: Node<T>;
}
export type Node<T> = Leaf<T> | Split<T>;

export interface PaneGeom<T> {
  item: T;
  rect: Rect; // whole pane, header included
  header: Rect | null;
  content: Rect;
}

export interface SepGeom<T> {
  split: Split<T>;
  parent: Rect; // the area the split divides
  rect: Rect; // grab handle
}

export function leaf<T>(item: T): Leaf<T> {
  return { kind: "leaf", item };
}

export function leaves<T>(node: Node<T>): T[] {
  return node.kind === "leaf" ? [node.item] : [...leaves(node.a), ...leaves(node.b)];
}

export function contains<T>(node: Node<T>, item: T): boolean {
  return node.kind === "leaf" ? node.item === item : contains(node.a, item) || contains(node.b, item);
}

/**
 * Replaces the leaf holding `item` with a split of it and `added`
 * (`added` right of / below it; with `before`, left of / above it).
 */
export function splitLeaf<T>(node: Node<T>, item: T, added: T, dir: Dir, before = false): Node<T> {
  if (node.kind === "leaf") {
    if (node.item !== item) return node;
    return before
      ? { kind: "split", dir, ratio: 0.5, a: leaf(added), b: node }
      : { kind: "split", dir, ratio: 0.5, a: node, b: leaf(added) };
  }
  return { ...node, a: splitLeaf(node.a, item, added, dir, before), b: splitLeaf(node.b, item, added, dir, before) };
}

/** A side of a pane to split it on: the new pane goes there. */
export type Side = "left" | "right" | "up" | "down";

export function sideDir(side: Side): { dir: Dir; before: boolean } {
  return { dir: side === "left" || side === "right" ? "h" : "v", before: side === "left" || side === "up" };
}

/** Panes in a row along `dir` (a split the other way counts as one). */
function span<T>(node: Node<T>, dir: Dir): number {
  return node.kind === "split" && node.dir === dir ? span(node.a, dir) + span(node.b, dir) : 1;
}

/**
 * Gives the panes in a row (or column) under `node`, laid out in `area`,
 * the same share of it, tmux's even layout: three panes side by side get
 * a third each, not a half and two quarters. Whole cells: the separators
 * between them are counted, and what doesn't divide evenly is at most one
 * cell. Splits the other way inside are left as they are, unless `deep`
 * (then every row and column is evened out). Changes the ratios in place.
 */
export function equalize<T>(node: Node<T>, area: Rect, deep = false): void {
  if (node.kind === "leaf") return;
  const na = span(node.a, node.dir);
  const n = na + span(node.b, node.dir);
  let ra: Rect;
  let rb: Rect;
  if (node.dir === "h") {
    // n panes and n-1 one-column separators: the first child gets na panes' share and its own separators.
    const avail = area.cols - 1;
    if (avail < 2) return;
    const aw = clamp(Math.round(((area.cols - (n - 1)) * na) / n + (na - 1)), 1, avail - 1);
    node.ratio = aw / avail;
    ra = { ...area, cols: aw };
    rb = { ...area, col: area.col + aw + 1, cols: avail - aw };
  } else {
    // Stacked panes have no separator (each pane's header divides it from the one above).
    if (area.rows < 2) return;
    const ah = clamp(Math.round((area.rows * na) / n), 1, area.rows - 1);
    node.ratio = ah / area.rows;
    ra = { ...area, rows: ah };
    rb = { ...area, row: area.row + ah, rows: area.rows - ah };
  }
  if (node.a.kind === "split" && (deep || node.a.dir === node.dir)) equalize(node.a, ra, deep);
  if (node.b.kind === "split" && (deep || node.b.dir === node.dir)) equalize(node.b, rb, deep);
}

/**
 * Where the divider would go if the pane in `rect` (header included) were
 * split in two along `dir`: the cells of the new divider inside `content`,
 * as computeLayout would place it.
 */
export function splitPreview(rect: Rect, content: Rect, dir: Dir): Rect | null {
  if (dir === "h") {
    const avail = rect.cols - 1;
    if (avail < 2) return null;
    const col = rect.col + clamp(Math.round(avail * 0.5), 1, avail - 1);
    return { col, row: content.row, cols: 1, rows: content.rows };
  }
  if (rect.rows < 2) return null;
  const row = rect.row + clamp(Math.round(rect.rows * 0.5), 1, rect.rows - 1);
  return row >= content.row && row < content.row + content.rows ? { col: content.col, row, cols: content.cols, rows: 1 } : null;
}

/** Puts `next` where `item` was. */
export function replaceLeaf<T>(node: Node<T>, item: T, next: T): Node<T> {
  if (node.kind === "leaf") return node.item === item ? leaf(next) : node;
  return { ...node, a: replaceLeaf(node.a, item, next), b: replaceLeaf(node.b, item, next) };
}

/** Removes the leaf holding `item`; its sibling takes the parent's place. */
export function removeLeaf<T>(node: Node<T>, item: T): Node<T> | null {
  if (node.kind === "leaf") return node.item === item ? null : node;
  const a = removeLeaf(node.a, item);
  const b = removeLeaf(node.b, item);
  if (!a) return b;
  if (!b) return a;
  return a === node.a && b === node.b ? node : { ...node, a, b };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Lays the tree out in `area`. With `headers`, every pane gets a one-row
 * title bar (it doubles as the divider between stacked panes); side-by-side
 * panes are divided by a one-column separator.
 */
export function computeLayout<T>(
  root: Node<T>,
  area: Rect,
  headers: boolean,
): { panes: PaneGeom<T>[]; seps: SepGeom<T>[] } {
  const panes: PaneGeom<T>[] = [];
  const seps: SepGeom<T>[] = [];

  const walk = (node: Node<T>, r: Rect): void => {
    if (node.kind === "leaf") {
      const header = headers && r.rows > 1 ? { col: r.col, row: r.row, cols: r.cols, rows: 1 } : null;
      const content = header ? { col: r.col, row: r.row + 1, cols: r.cols, rows: r.rows - 1 } : { ...r };
      panes.push({ item: node.item, rect: r, header, content });
      return;
    }
    if (node.dir === "h") {
      const avail = r.cols - 1;
      if (avail < 2) {
        walk(node.a, r);
        walk(node.b, { ...r, cols: 0 });
        return;
      }
      const aw = clamp(Math.round(avail * node.ratio), 1, avail - 1);
      walk(node.a, { ...r, cols: aw });
      seps.push({ split: node, parent: r, rect: { col: r.col + aw, row: r.row, cols: 1, rows: r.rows } });
      walk(node.b, { ...r, col: r.col + aw + 1, cols: avail - aw });
    } else {
      if (r.rows < 2) {
        walk(node.a, r);
        walk(node.b, { ...r, rows: 0 });
        return;
      }
      const ah = clamp(Math.round(r.rows * node.ratio), 1, r.rows - 1);
      walk(node.a, { ...r, rows: ah });
      seps.push({ split: node, parent: r, rect: { col: r.col, row: r.row + ah, cols: r.cols, rows: 1 } });
      walk(node.b, { ...r, row: r.row + ah, rows: r.rows - ah });
    }
  };
  walk(root, area);
  return { panes, seps };
}

export function inRect(r: Rect, col: number, row: number): boolean {
  return col >= r.col && col < r.col + r.cols && row >= r.row && row < r.row + r.rows;
}

/** The pane next to `from` in direction h/j/k/l (left/down/up/right). */
export function neighbor<T>(panes: PaneGeom<T>[], from: T, dir: "h" | "j" | "k" | "l"): T | null {
  const src = panes.find((p) => p.item === from)?.rect;
  if (!src) return null;
  let best: { item: T; dist: number; overlap: number } | null = null;
  for (const p of panes) {
    if (p.item === from || p.rect.cols < 1 || p.rect.rows < 1) continue;
    const r = p.rect;
    let dist: number;
    let overlap: number;
    const hOverlap = Math.min(src.row + src.rows, r.row + r.rows) - Math.max(src.row, r.row);
    const vOverlap = Math.min(src.col + src.cols, r.col + r.cols) - Math.max(src.col, r.col);
    if (dir === "h") { dist = src.col - (r.col + r.cols); overlap = hOverlap; }
    else if (dir === "l") { dist = r.col - (src.col + src.cols); overlap = hOverlap; }
    else if (dir === "k") { dist = src.row - (r.row + r.rows); overlap = vOverlap; }
    else { dist = r.row - (src.row + src.rows); overlap = vOverlap; }
    if (dist < 0 || overlap <= 0) continue;
    if (!best || dist < best.dist || (dist === best.dist && overlap > best.overlap)) {
      best = { item: p.item, dist, overlap };
    }
  }
  return best?.item ?? null;
}

/** The innermost split of direction `dir` that contains `item`, for keyboard resizing. */
export function enclosingSplit<T>(node: Node<T>, item: T, dir: Dir): { split: Split<T>; inA: boolean } | null {
  if (node.kind === "leaf") return null;
  const inA = contains(node.a, item);
  const inB = !inA && contains(node.b, item);
  if (!inA && !inB) return null;
  const deeper = enclosingSplit(inA ? node.a : node.b, item, dir);
  if (deeper) return deeper;
  return node.dir === dir ? { split: node, inA } : null;
}
