import { describe, expect, test } from "bun:test";
import { ClickAreas, Menu, around, type MenuEntry } from "../src/menu";

const screen = { col: 1, row: 1, cols: 80, rows: 24 };
const noop = () => {};
const items = (n: number): MenuEntry[] => Array.from({ length: n }, (_, i) => ({ label: `item ${i}`, key: `^B ${i}`, run: noop }));
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "\n");

describe("menu", () => {
  test("opens at the point, sized to its widest label and key", () => {
    const m = new Menu([{ label: "Split right", key: "^B v", run: noop }, "-", { label: "Close", run: noop }], { col: 10, row: 5 }, screen);
    // 2 pad + "Split right" + 3 + "^B v" + 2; 3 entries + title row + bottom row
    expect(m.rect).toEqual({ col: 10, row: 5, cols: 2 + 11 + 3 + 4 + 2, rows: 5 });
  });

  test("flips left and up to stay on screen", () => {
    const m = new Menu(items(5), { col: 79, row: 23 }, screen);
    expect(m.rect.col + m.rect.cols - 1).toBeLessThanOrEqual(80);
    expect(m.rect.col + m.rect.cols - 1).toBe(79); // right edge at the pointer
    expect(m.rect.row + m.rect.rows - 1).toBe(23); // bottom edge at the pointer
  });

  test("a dropdown's right edge is at its button", () => {
    const m = new Menu(items(3), { col: 80, row: 3 }, screen, { align: "right" });
    expect(m.rect.col + m.rect.cols - 1).toBe(80);
    expect(m.rect.row).toBe(3);
  });

  test("rows map to items; separators, disabled items and the edges aren't clickable", () => {
    const entries: MenuEntry[] = [{ label: "a", run: noop }, "-", { label: "b", disabled: true, run: noop }, { label: "c", run: noop }];
    const m = new Menu(entries, { col: 1, row: 1 }, screen);
    expect(m.hit(2, 1)).toBe(-1); // title row
    expect(m.hit(2, 2)).toBe(0);
    expect(m.hit(2, 3)).toBe(-1);
    expect(m.hit(2, 4)).toBe(-1);
    expect(m.hit(2, 5)).toBe(3);
    expect(m.hit(2, 6)).toBe(-1); // bottom row
    expect(m.hit(m.rect.cols + 1, 2)).toBe(-1);
    expect(m.contains(m.rect.cols + 1, 2)).toBe(false);
  });

  test("keys move over separators and disabled items, and run the highlighted one", () => {
    let ran = "";
    const entries: MenuEntry[] = [
      { label: "a", run: () => (ran = "a") }, "-", { label: "b", disabled: true, run: noop }, { label: "c", run: () => (ran = "c") },
    ];
    const m = new Menu(entries, { col: 1, row: 1 }, screen);
    expect(m.key("arrowdown")).toBe("handled");
    expect(m.active).toBe(0);
    m.key("arrowdown");
    expect(m.active).toBe(3);
    m.key("arrowdown"); // wraps
    expect(m.active).toBe(0);
    m.key("arrowup");
    const r = m.key("enter");
    expect(r && typeof r === "object" && (r.run.run(), ran)).toBe("c");
    expect(m.key("escape")).toBe("close");
    expect(m.key("x")).toBeNull();
  });

  test("a menu taller than the screen scrolls, with marks for hidden rows", () => {
    const m = new Menu(items(40), { col: 1, row: 1 }, screen);
    expect(m.rect.rows).toBe(24);
    expect(m.visible).toBe(22);
    expect(plain(m.draw({ panel: "", active: "", key: "", disabled: "", separator: "", title: "" }))).toContain("▼");
    m.scroll(100);
    expect(m.offset).toBe(18);
    expect(m.hit(2, 2)).toBe(18);
    m.move(-1); // from nothing highlighted: the last item, scrolled into view
    expect(m.active).toBe(39);
    m.move(1); // wraps to the first, scrolled back
    expect(m.offset).toBe(0);
  });

  test("draws every row the width of the menu, keys right-aligned", () => {
    const m = new Menu([{ label: "Reload", key: "Ctrl+R", run: noop }, "-", { label: "Close tab", key: "^B X", run: noop }], { col: 1, row: 1 }, screen, { title: "tab" });
    const rows = plain(m.draw({ panel: "", active: "", key: "", disabled: "", separator: "", title: "" })).split("\n").filter(Boolean);
    expect(rows).toHaveLength(m.rect.rows);
    for (const r of rows) expect(Bun.stringWidth(r)).toBe(m.rect.cols);
    expect(rows[1]!.trimEnd().endsWith("Ctrl+R")).toBe(true);
    expect(rows[3]!.trimEnd().endsWith("^B X")).toBe(true);
  });
});

describe("click areas", () => {
  test("the newest area under the pointer gets the click and its button", () => {
    const c = new ClickAreas();
    const got: string[] = [];
    c.add(1, 10, 5, (b) => got.push(`wide ${b}`));
    c.add(1, 12, 1, (b) => got.push(`x ${b}`));
    expect(c.click(12, 1, 0)).toBe(true);
    expect(c.click(10, 1, 2)).toBe(true);
    expect(c.click(15, 1, 0)).toBe(false);
    expect(c.click(12, 2, 0)).toBe(false);
    expect(got).toEqual(["x 0", "wide 2"]);
    c.clear();
    expect(c.click(12, 1, 0)).toBe(false);
  });
});

describe("around", () => {
  const pane = { col: 1, row: 3, cols: 80, rows: 20 };
  test("no overlap leaves the pane whole", () => {
    expect(around(pane, { col: 1, row: 1, cols: 10, rows: 2 })).toEqual([pane]);
  });
  test("the pieces cover the pane except the hole", () => {
    const hole = { col: 30, row: 5, cols: 20, rows: 6 };
    const pieces = around(pane, hole);
    let cells = 0;
    for (const p of pieces) {
      cells += p.cols * p.rows;
      for (let r = p.row; r < p.row + p.rows; r++)
        for (let c = p.col; c < p.col + p.cols; c++)
          expect(c >= hole.col && c < hole.col + hole.cols && r >= hole.row && r < hole.row + hole.rows).toBe(false);
    }
    expect(cells).toBe(80 * 20 - 20 * 6);
  });
  test("a hole hanging over the pane's corner", () => {
    const pieces = around(pane, { col: 70, row: 1, cols: 20, rows: 5 });
    expect(pieces.reduce((a, p) => a + p.cols * p.rows, 0)).toBe(80 * 20 - 11 * 3);
  });
});
