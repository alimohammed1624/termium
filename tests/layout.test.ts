import { describe, expect, test } from "bun:test";
import { computeLayout, enclosingSplit, equalize, leaf, leaves, neighbor, removeLeaf, sideDir, splitLeaf, splitPreview, type Node, type Split } from "../src/layout";

const area = { col: 1, row: 1, cols: 101, rows: 40 };

describe("layout", () => {
  test("single pane fills the area without a header", () => {
    const { panes, seps } = computeLayout(leaf("a"), area, false);
    expect(panes[0]).toMatchObject({ header: null, content: area });
    expect(seps).toHaveLength(0);
  });

  test("side-by-side split leaves a one-column separator", () => {
    const root = splitLeaf(leaf("a"), "a", "b", "h");
    const { panes, seps } = computeLayout(root, area, true);
    const [a, b] = panes;
    expect(a!.rect.cols + 1 + b!.rect.cols).toBe(101);
    expect(seps[0]!.rect).toEqual({ col: 51, row: 1, cols: 1, rows: 40 });
    expect(a!.content).toEqual({ col: 1, row: 2, cols: 50, rows: 39 });
  });

  test("stacked split shares rows exactly", () => {
    const root = splitLeaf(leaf("a"), "a", "b", "v");
    const { panes } = computeLayout(root, area, true);
    expect(panes[0]!.rect.rows + panes[1]!.rect.rows).toBe(40);
    expect(panes[1]!.header!.row).toBe(21);
  });

  test("remove promotes the sibling", () => {
    let root: Node<string> = splitLeaf(leaf("a"), "a", "b", "h");
    root = splitLeaf(root, "b", "c", "v");
    expect(leaves(root)).toEqual(["a", "b", "c"]);
    root = removeLeaf(root, "b")!;
    expect(leaves(root)).toEqual(["a", "c"]);
    expect(removeLeaf(leaf("a"), "a")).toBeNull();
  });

  test("neighbors and resize targets", () => {
    let root: Node<string> = splitLeaf(leaf("a"), "a", "b", "h");
    root = splitLeaf(root, "b", "c", "v");
    const { panes } = computeLayout(root, area, true);
    expect(neighbor(panes, "a", "l")).toBe("b");
    expect(neighbor(panes, "b", "j")).toBe("c");
    expect(neighbor(panes, "c", "h")).toBe("a");
    expect(neighbor(panes, "a", "h")).toBeNull();
    expect(enclosingSplit(root, "c", "h")!.inA).toBe(false);
    expect(enclosingSplit(root, "c", "v")!.inA).toBe(false);
  });

  test("tiny areas never produce negative sizes", () => {
    const root = splitLeaf(leaf("a"), "a", "b", "h");
    const { panes } = computeLayout(root, { col: 1, row: 1, cols: 2, rows: 1 }, true);
    for (const p of panes) {
      expect(p.content.cols).toBeGreaterThanOrEqual(0);
      expect(p.content.rows).toBeGreaterThanOrEqual(0);
    }
  });

  test("a split on the left or above puts the new pane first", () => {
    expect(leaves(splitLeaf(leaf("a"), "a", "b", "h", true))).toEqual(["b", "a"]);
    expect(sideDir("left")).toEqual({ dir: "h", before: true });
    expect(sideDir("up")).toEqual({ dir: "v", before: true });
    expect(sideDir("right")).toEqual({ dir: "h", before: false });
    expect(sideDir("down")).toEqual({ dir: "v", before: false });
  });

  test("equalize gives panes in a row the same width", () => {
    // a | (b | c), split right twice from the right pane: a half and two quarters.
    let root: Node<string> = splitLeaf(leaf("a"), "a", "b", "h");
    root = splitLeaf(root, "b", "c", "h");
    equalize(root);
    const widths = computeLayout(root, { col: 1, row: 1, cols: 92, rows: 40 }, true).panes.map((p) => p.rect.cols);
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
  });

  test("equalize leaves splits the other way alone unless deep", () => {
    // a | (b over c), with b over c at 0.8.
    let root: Node<string> = splitLeaf(leaf("a"), "a", "b", "h");
    root = splitLeaf(root, "b", "c", "v");
    const outer = root as Split<string>;
    const inner = outer.b as Split<string>;
    outer.ratio = 0.2;
    inner.ratio = 0.8;
    equalize(outer);
    expect(outer.ratio).toBe(0.5);
    expect(inner.ratio).toBe(0.8);
    equalize(outer, true);
    expect(inner.ratio).toBe(0.5);
  });

  test("the split preview is where the new divider will be", () => {
    for (const dir of ["h", "v"] as const) {
      const { panes } = computeLayout(leaf("a"), area, true);
      const p = panes[0]!;
      const preview = splitPreview(p.rect, p.content, dir)!;
      const after = computeLayout(splitLeaf(leaf("a"), "a", "b", dir), area, true);
      const sep = after.seps[0]!.rect;
      if (dir === "h") expect(preview).toEqual({ ...sep, row: p.content.row, rows: p.content.rows });
      else expect(preview.row).toBe(sep.row);
    }
    expect(splitPreview({ col: 1, row: 1, cols: 2, rows: 1 }, { col: 1, row: 1, cols: 2, rows: 1 }, "h")).toBeNull();
  });
});
