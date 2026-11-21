import { describe, expect, test } from "bun:test";
import { computeLayout, enclosingSplit, leaf, leaves, neighbor, removeLeaf, splitLeaf, type Node } from "../src/layout";

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
});
