import { describe, expect, test } from "bun:test";
import { REPLAY_BACK, REPLAY_FORWARD, countLeaves, mapLeaves, replayPlan } from "../src/reopen";

const blank = (u: string) => u.startsWith("about:blank");
const h = (urls: string[], currentIndex: number) => ({ currentIndex, entries: urls.map((url) => ({ url })) });

describe("replayPlan", () => {
  test("loads the entries in order and goes back to the current one", () => {
    expect(replayPlan(h(["a", "b", "c", "d"], 2), blank)).toEqual({ urls: ["a", "b", "c", "d"], forward: 1 });
    expect(replayPlan(h(["a"], 0), blank)).toEqual({ urls: ["a"], forward: 0 });
  });

  test("leaves out blank placeholders and merges repeats in a row", () => {
    expect(replayPlan(h(["about:blank#x", "a", "a", "b"], 3), blank)).toEqual({ urls: ["a", "b"], forward: 0 });
    expect(replayPlan(h(["a", "about:blank", "a", "b"], 2), blank)).toEqual({ urls: ["a", "b"], forward: 1 });
  });

  test("nothing to reopen at a blank current entry", () => {
    expect(replayPlan(h(["a", "about:blank#x"], 1), blank)).toBeNull();
    expect(replayPlan(h([], 0), blank)).toBeNull();
  });

  test("keeps a few entries either side of the current one", () => {
    const urls = Array.from({ length: 30 }, (_, i) => `u${i}`);
    const plan = replayPlan(h(urls, 15), blank)!;
    expect(plan.urls).toEqual(urls.slice(15 - REPLAY_BACK, 16 + REPLAY_FORWARD));
    expect(plan.forward).toBe(REPLAY_FORWARD);
  });
});

describe("leaves", () => {
  const tree = { dir: "h" as const, ratio: 0.5, a: { url: "a" }, b: { dir: "v" as const, ratio: 0.3, a: { url: "b" }, b: { url: "c" } } };
  test("counts and maps them left to right", () => {
    expect(countLeaves(tree)).toBe(3);
    expect(mapLeaves(tree, (i, old) => `${i}${old}`)).toEqual({
      dir: "h", ratio: 0.5, a: { url: "0a" }, b: { dir: "v", ratio: 0.3, a: { url: "1b" }, b: { url: "2c" } },
    });
  });
});
