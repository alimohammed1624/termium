import { describe, expect, test } from "bun:test";
import { CLEAR_FIND, FIND_LIMIT, FIND_STYLE, findCount, findScript } from "../src/find";
import { barCells, markRow } from "../src/scrollbar";

describe("find in page", () => {
  test("the count reads n/total", () => {
    expect(findCount(undefined)).toBe("");
    expect(findCount({ total: 0, index: -1, ys: [] })).toBe("No matches");
    expect(findCount({ total: 17, index: 2, ys: [] })).toBe("3/17");
    expect(findCount({ total: FIND_LIMIT, index: 0, ys: [] })).toBe(`1/${FIND_LIMIT}+`);
  });

  test("the scripts parse, whatever is searched for", () => {
    for (const q of ["", "a", "a.b(c)*[d]\\e$f^", "`${x}`", '"quoted"', " ", "日本"]) {
      for (const mode of ["near", "goto", "keep"] as const) {
        expect(() => new Function(`return ${findScript(q, mode, 3)}`)).not.toThrow();
      }
    }
    expect(() => new Function(FIND_STYLE)).not.toThrow();
    expect(() => new Function(CLEAR_FIND)).not.toThrow();
  });

  test("the current match is drawn over the others in its cell", () => {
    const m = { y: 0, view: 100, total: 1000 };
    const cells = barCells(m, 10, [500, 520, 900], 520)!;
    expect(markRow(520, 1000, 10)).toBe(5);
    expect(cells[5]).toEqual({ ch: "━", fg: "current", bg: "track" });
    expect(cells[9]).toEqual({ ch: "━", fg: "mark", bg: "track" });
  });
});
