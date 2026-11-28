import { describe, expect, test } from "bun:test";
import {
  FADE_MS, FILL_MS, HOLD_MS, LOADING_CAP, MIN_STOP_MS, bar, finished, holdsStop, mix, parsed, started, underline,
} from "../src/progress";

describe("loading bar", () => {
  test("eases toward the cap while loading, never past it", () => {
    const l = started(undefined, 0);
    let last = -1;
    for (const t of [0, 100, 500, 1000, 3000, 10_000, 60_000]) {
      const b = bar(l, t)!;
      expect(b.alpha).toBe(1);
      expect(b.fill).toBeGreaterThanOrEqual(last);
      expect(b.fill).toBeLessThanOrEqual(LOADING_CAP);
      last = b.fill;
    }
    expect(bar(l, 0)!.fill).toBe(0);
    expect(last).toBeGreaterThan(0.94);
  });

  test("DOMContentLoaded hurries it on without a jump", () => {
    const l = started(undefined, 0);
    const before = bar(l, 1000)!.fill;
    const p = parsed(l, 1000);
    expect(bar(p, 1000)!.fill).toBeCloseTo(before, 6);
    expect(bar(p, 1500)!.fill).toBeGreaterThan(bar(l, 1500)!.fill);
    expect(parsed(p, 1200)).toBe(p); // only once
  });

  test("a finished load fills, holds, fades, then is gone", () => {
    const l = finished(started(undefined, 0), 1000)!;
    const from = bar(started(undefined, 0), 1000)!.fill;
    expect(bar(l, 1000)!.fill).toBeCloseTo(from, 6);
    expect(bar(l, 1000 + FILL_MS / 2)!.fill).toBeGreaterThan(from);
    expect(bar(l, 1000 + FILL_MS)).toEqual({ fill: 1, alpha: 1 });
    expect(bar(l, 1000 + FILL_MS + HOLD_MS - 1)).toEqual({ fill: 1, alpha: 1 });
    const fading = bar(l, 1000 + FILL_MS + HOLD_MS + FADE_MS / 2)!;
    expect(fading.fill).toBe(1);
    expect(fading.alpha).toBeCloseTo(0.5, 5);
    expect(bar(l, 1000 + FILL_MS + HOLD_MS + FADE_MS)).toBeNull();
    expect(bar(undefined, 0)).toBeNull();
  });

  test("a load starting while the last one fills carries on from where the bar is", () => {
    const done = finished(started(undefined, 0), 1000)!;
    const at = bar(done, 1000 + FILL_MS / 2)!.fill;
    const again = started(done, 1000 + FILL_MS / 2);
    expect(again.end).toBe(0);
    expect(bar(again, 1000 + FILL_MS / 2)!.fill).toBeCloseTo(at, 6);
    // Later than that, a new load starts from empty.
    const fresh = started(done, 1000 + FILL_MS + 10);
    expect(bar(fresh, 1000 + FILL_MS + 10)!.fill).toBe(0);
    // One still running carries on where it is, but holds the stop button from the new start.
    const running = started(undefined, 0);
    const replaced = started(running, 500);
    expect(bar(replaced, 600)!.fill).toBeCloseTo(bar(running, 600)!.fill, 9);
    expect(holdsStop(finished(replaced, 520), 500 + MIN_STOP_MS - 1)).toBe(true);
  });

  test("the stop button is held for a fast load", () => {
    const l = finished(started(undefined, 0), 40);
    expect(holdsStop(l, 100)).toBe(true);
    expect(holdsStop(l, MIN_STOP_MS)).toBe(false);
    expect(holdsStop(undefined, 0)).toBe(false);
  });

  test("mix", () => {
    expect(mix("000000", "ffffff", 0)).toBe("000000");
    expect(mix("000000", "ffffff", 1)).toBe("ffffff");
    expect(mix("102030", "304050", 0.5)).toBe("203040");
  });
});

describe("underline", () => {
  const ON = "\x1b[4m\x1b[58:2::255:0:0m";
  const OFF = "\x1b[24m\x1b[59m";
  const visible = (s: string) => s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

  test("leaves the row alone with nothing to draw", () => {
    expect(underline("\x1b[2;1Habc", 0, "ff0000")).toBe("\x1b[2;1Habc");
  });

  test("underlines the first cells and stops there", () => {
    const s = underline("\x1b[2;1Habcdef", 3, "ff0000");
    expect(s).toBe(`\x1b[2;1H${ON}abc${OFF}def`);
    expect(visible(s)).toBe("abcdef");
  });

  test("puts it back after a reset inside the span", () => {
    const s = underline("ab\x1b[0mcd", 3, "ff0000");
    expect(s).toBe(`${ON}ab\x1b[0m${ON}c${OFF}d`);
  });

  test("ends it when the span reaches the end of the row", () => {
    expect(underline("ab", 5, "ff0000")).toBe(`${ON}ab${OFF}`);
  });

  test("counts wide characters as two columns", () => {
    const s = underline("🔒ab", 3, "ff0000");
    expect(s).toBe(`${ON}🔒a${OFF}b`);
  });
});

describe("a load starting while the last one fills", () => {
  test("holds the stop button for its own minimum", () => {
    const done = finished(started(undefined, 0), 1000)!;
    const again = started(done, 1000 + FILL_MS / 2);
    const back = finished(again, 1000 + FILL_MS / 2 + 10);
    expect(holdsStop(back, 1000 + FILL_MS / 2 + MIN_STOP_MS - 1)).toBe(true);
    expect(holdsStop(back, 1000 + FILL_MS / 2 + MIN_STOP_MS)).toBe(false);
  });

  test("never shows more than the cap while it loads", () => {
    const done = finished(started(undefined, 0), 1000)!;
    const late = 1000 + FILL_MS - 5; // the bar is nearly full here
    expect(bar(done, late)!.fill).toBeGreaterThan(LOADING_CAP);
    const again = started(done, late);
    for (const t of [late, late + 100, late + 10_000]) expect(bar(again, t)!.fill).toBeLessThanOrEqual(LOADING_CAP);
    expect(bar(parsed(again, late + 50), late + 10_000)!.fill).toBeLessThanOrEqual(LOADING_CAP);
  });
});
