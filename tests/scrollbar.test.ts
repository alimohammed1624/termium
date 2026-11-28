import { describe, expect, test } from "bun:test";
import { computeLayout, leaf, splitLeaf } from "../src/layout";
import { barCells, offsetFor, scrolls, thumb } from "../src/scrollbar";

describe("scrollbar", () => {
  test("no bar when the page doesn't scroll", () => {
    expect(scrolls({ y: 0, view: 800, total: 800 })).toBe(false);
    expect(thumb({ y: 0, view: 800, total: 800.5 }, 10)).toBeNull();
    expect(barCells(undefined, 10)).toBeNull();
  });

  test("thumb size and position in eighths", () => {
    // 10 rows = 80 eighths; a quarter of the page shows: a 20-eighth thumb.
    expect(thumb({ y: 0, view: 100, total: 400 }, 10)).toEqual({ top: 0, len: 20 });
    expect(thumb({ y: 300, view: 100, total: 400 }, 10)).toEqual({ top: 60, len: 20 });
    expect(thumb({ y: 150, view: 100, total: 400 }, 10)).toEqual({ top: 30, len: 20 });
    // Never shorter than a cell.
    expect(thumb({ y: 0, view: 10, total: 100000 }, 10)!.len).toBe(8);
    // Overscroll is clamped.
    expect(thumb({ y: 999, view: 100, total: 400 }, 10)!.top).toBe(60);
  });

  test("cells use eighth blocks at the thumb's ends", () => {
    // Thumb from eighth 30 to 50: rows 3 (30..32 track then thumb), 4, 5 (48..50 thumb).
    const cells = barCells({ y: 150, view: 100, total: 400 }, 10)!;
    expect(cells.length).toBe(10);
    expect(cells[2]).toEqual({ ch: " ", fg: "track", bg: "track" });
    expect(cells[3]).toEqual({ ch: "▂", fg: "thumb", bg: "track" });
    expect(cells[4]).toEqual({ ch: " ", fg: "thumb", bg: "thumb" });
    expect(cells[5]).toEqual({ ch: " ", fg: "thumb", bg: "thumb" });
    expect(cells[6]).toEqual({ ch: "▆", fg: "track", bg: "thumb" });
    expect(cells[7]).toEqual({ ch: " ", fg: "track", bg: "track" });
  });

  test("dragging maps the thumb back to an offset", () => {
    const m = { y: 0, view: 100, total: 400 };
    expect(offsetFor(m, 10, 0)).toBe(0);
    expect(offsetFor(m, 10, 30)).toBe(150);
    expect(offsetFor(m, 10, 60)).toBe(300);
    expect(offsetFor(m, 10, 500)).toBe(300);
    expect(offsetFor(m, 10, -5)).toBe(0);
    // A thumb that fills the track can't move: the offset stays.
    expect(offsetFor({ y: 1, view: 1520, total: 1522 }, 38, 300)).toBe(1);
    expect(offsetFor({ y: 5, view: 100, total: 400 }, 1, 8)).toBe(5);
    // Round trip.
    expect(thumb({ ...m, y: offsetFor(m, 10, 42) }, 10)!.top).toBe(42);
  });

  test("marks land in their row", () => {
    const cells = barCells({ y: 0, view: 100, total: 400 }, 10, [0, 390, 200])!;
    expect(cells[0]).toEqual({ ch: "━", fg: "mark", bg: "thumb" });
    expect(cells[9]).toEqual({ ch: "━", fg: "mark", bg: "track" });
    expect(cells[5]).toEqual({ ch: "━", fg: "mark", bg: "track" });
  });

  test("layout keeps the last column of each pane for the bar", () => {
    const area = { col: 1, row: 1, cols: 101, rows: 40 };
    const root = splitLeaf(leaf("a"), "a", "b", "h");
    const { panes } = computeLayout(root, area, true, true);
    const [a, b] = panes;
    expect(a!.content).toEqual({ col: 1, row: 2, cols: 49, rows: 39 });
    expect(a!.bar).toEqual({ col: 50, row: 2, cols: 1, rows: 39 });
    expect(b!.bar).toEqual({ col: 101, row: 2, cols: 1, rows: 39 });
    // Too narrow for one: the pane keeps every column.
    const narrow = computeLayout(leaf("a"), { col: 1, row: 1, cols: 1, rows: 5 }, false, true).panes[0]!;
    expect(narrow.bar).toBeUndefined();
    expect(narrow.content.cols).toBe(1);
    expect(computeLayout(leaf("a"), { col: 1, row: 1, cols: 2, rows: 5 }, false, true).panes[0]!.bar).toEqual({ col: 2, row: 1, cols: 1, rows: 5 });
  });
});
