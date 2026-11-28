import { expect, test } from "bun:test";
import { HINT_CHARS, hintFontPx, hintLabels } from "../src/hints";
import { parseCtl } from "../src/ctl";

const prefixFree = (labels: string[]) => labels.every((a) => labels.every((b) => a === b || !b.startsWith(a)));

test("hint labels: as many as asked, distinct, none the start of another", () => {
  for (const n of [1, 2, 13, 14, 15, 50, 195, 196, 197, 400, 1000]) {
    const labels = hintLabels(n);
    expect(labels.length).toBe(n);
    expect(new Set(labels).size).toBe(n);
    expect(prefixFree(labels)).toBe(true);
    for (const l of labels) expect([...l].every((c) => HINT_CHARS.includes(c))).toBe(true);
  }
  expect(hintLabels(0)).toEqual([]);
});

test("hint labels: one letter while they fit, home row first, then as short as they can be", () => {
  expect(hintLabels(3)).toEqual(["s", "a", "d"]);
  expect(hintLabels(HINT_CHARS.length).every((l) => l.length === 1)).toBe(true);
  // 15 need one two-letter group: the rest stay one letter.
  const l15 = hintLabels(15);
  expect(l15.filter((l) => l.length === 1).length).toBe(13);
  expect(Math.max(...hintLabels(196).map((l) => l.length))).toBe(2);
  expect(Math.max(...hintLabels(1000).map((l) => l.length))).toBe(3);
  // The same count always gives the same labels (the person's and an agent's agree).
  expect(hintLabels(77)).toEqual(hintLabels(77));
});

test("hint label size: about a terminal row on screen at any pixel ratio", () => {
  expect(hintFontPx(20, 1)).toBe(14);
  expect(hintFontPx(40, 2)).toBe(14);
  expect(hintFontPx(20, 2)).toBe(8);
  expect(hintFontPx(20, 0.5)).toBe(28);
});

test("ctl hints and click by label parse", () => {
  expect(parseCtl(["hints"]).req).toMatchObject({ cmd: "hints" });
  expect(parseCtl(["-s", "a", "hints", "3", "--json"])).toMatchObject({ session: "a", json: true, req: { cmd: "hints", tab: 3 } });
  expect(parseCtl(["click", "sa", "--tab", "2"]).req).toMatchObject({ cmd: "click", ref: "sa", tab: 2 });
});
