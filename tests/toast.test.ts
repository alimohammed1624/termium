import { describe, expect, test } from "bun:test";
import { TOAST_MAX_COLS, layoutToasts, pause, remaining, resume, timerBar, wrap, type Toast } from "../src/toast";
import { width } from "../src/text";

const toast = (id: number, text: string, ms = 3000, label?: string): Toast => ({
  id, text, ms, left: ms, since: 0, action: label ? { label, run: () => {} } : undefined,
});

describe("timerBar", () => {
  test("is always as wide as asked, shrinking a column at a time, gone only at 0", () => {
    for (let f = 0; f <= 1; f += 0.01) expect(width(timerBar(f, 10))).toBe(10);
    expect(timerBar(1, 4)).toBe("▂▂▂▂");
    expect(timerBar(0, 4)).toBe("    ");
    expect(timerBar(0.5, 4)).toBe("▂▂  ");
    expect(timerBar(0.01, 4)).toBe("▂   ");
    expect(timerBar(1.5, 2)).toBe("▂▂");
    expect(timerBar(-1, 2)).toBe("  ");
  });
});

describe("timer", () => {
  test("counts down, and waits while paused", () => {
    const t = toast(1, "a", 1000);
    expect(remaining(t, 400)).toBe(600);
    pause(t, 400);
    expect(remaining(t, 5000)).toBe(600);
    pause(t, 6000); // already paused: unchanged
    resume(t, 5000);
    expect(remaining(t, 5100)).toBe(500);
  });
});

describe("wrap", () => {
  test("wraps at spaces, cuts long words, ends with … past the last line", () => {
    expect(wrap("hello world", 20, 3)).toEqual(["hello world"]);
    expect(wrap("hello world", 7, 3)).toEqual(["hello", "world"]);
    expect(wrap("abcdefghij", 4, 3)).toEqual(["abcd", "efgh", "ij"]);
    const w = wrap("one two three four five six seven", 9, 2);
    expect(w.length).toBe(2);
    expect(w[1]!.endsWith("…")).toBe(true);
    for (const l of w) expect(width(l)).toBeLessThanOrEqual(9);
  });
});

describe("layoutToasts", () => {
  const area = { row: 3, col: 1, cols: 100, rows: 30 };

  test("stacks the newest at the bottom right, older above, a row apart", () => {
    const boxes = layoutToasts([toast(1, "first"), toast(2, "second")], area, 1);
    expect(boxes.map((b) => b.toast.id)).toEqual([2, 1]);
    const [newest, older] = boxes;
    expect(newest!.row + newest!.rows - 1).toBe(area.row + area.rows - 1);
    expect(newest!.col + newest!.cols).toBe(area.col + area.cols - 1);
    expect(older!.row + older!.rows).toBe(newest!.row - 1);
    expect(newest!.rows).toBe(2); // one line of text and the timer line
  });

  test("keeps within the area and its width limit; what doesn't fit isn't shown", () => {
    const long = "word ".repeat(60);
    const many = Array.from({ length: 10 }, (_, i) => toast(i, long));
    const small = { row: 3, col: 31, cols: 50, rows: 10 };
    const boxes = layoutToasts(many, small, 0);
    expect(boxes.length).toBeGreaterThan(0);
    expect(boxes.length).toBeLessThan(10);
    for (const b of boxes) {
      expect(b.row).toBeGreaterThanOrEqual(small.row);
      expect(b.col).toBeGreaterThanOrEqual(small.col);
      expect(b.col + b.cols).toBe(small.col + small.cols);
      expect(b.cols).toBeLessThanOrEqual(TOAST_MAX_COLS);
      for (const l of b.lines) expect(width(l)).toBeLessThan(b.cols);
    }
    expect(layoutToasts(many, { row: 3, col: 1, cols: 8, rows: 10 }, 0)).toEqual([]);
  });

  test("an action's label is a hit target on the first row", () => {
    const [b] = layoutToasts([toast(1, "Closed tab", 5000, "Undo")], area, 1);
    expect(b!.actionHit).not.toBeNull();
    const [start, end] = b!.actionHit!;
    expect(end - start).toBe(width(" Undo "));
    expect(end).toBeLessThan(b!.col + b!.cols);
    expect(layoutToasts([toast(2, "plain")], area, 1)[0]!.actionHit).toBeNull();
    // A label too long for the toast is cut: the text and the close mark keep their room.
    const narrow = { row: 3, col: 1, cols: 30, rows: 10 };
    const [w] = layoutToasts([toast(3, "Closed tab", 5000, "x".repeat(60))], narrow, 0);
    expect(width(w!.action)).toBeLessThanOrEqual(15);
    expect(w!.col + w!.cols).toBe(narrow.col + narrow.cols);
    expect(1 + width(w!.lines[0]!) + width(w!.action) + width(w!.close)).toBeLessThanOrEqual(w!.cols);
    expect(w!.actionHit![1]).toBeLessThanOrEqual(w!.col + w!.cols - width(w!.close));
  });
});
