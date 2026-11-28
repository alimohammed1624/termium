import { describe, expect, test } from "bun:test";
import { actionItem, itemMatches, paletteRows, type PaletteItem } from "../src/palette";

const noop = () => {};
const action = (label: string, keys: string, keywords?: string) => actionItem({ label, keys, keywords, run: noop });
const tab = (text: string, url: string): PaletteItem => ({ kind: "tab", text, keywords: url, run: noop });
const seen = (text: string, url: string): PaletteItem => ({ kind: "history", text, keywords: url, run: noop });
const go: PaletteItem = { kind: "go", text: "Search for split", run: noop };

describe("palette", () => {
  test("matches every word, in text, shortcut or keywords, any case", () => {
    const split = action("Split right", "Ctrl+B v", "pane vertical");
    expect(itemMatches(split, "")).toBe(true);
    expect(itemMatches(split, "SPLIT")).toBe(true);
    expect(itemMatches(split, "ctrl+b v")).toBe(true);
    expect(itemMatches(split, "vertical pane")).toBe(true);
    expect(itemMatches(split, "split down")).toBe(false);
  });

  test("the typed text's own row comes first, then actions, tabs, history", () => {
    const items = [
      seen("Splitting hairs", "https://a.example/split"),
      tab("Split ends", "https://b.example/"),
      action("Split down", "Ctrl+B -"),
      action("Split right", "Ctrl+B v"),
      action("Reload", "Ctrl+R"),
    ];
    const rows = paletteRows("split", go, items);
    expect(rows.map((r) => r.text)).toEqual(["Search for split", "Split down", "Split right", "Split ends", "Splitting hairs"]);
  });

  test("matches at the start of the text come first within a group, otherwise the given order stays", () => {
    const items = [action("Close space", "Ctrl+B D", "workspace"), action("Switch space", "Ctrl+B w"), action("Space bar", "x")];
    expect(paletteRows("space", null, items).map((r) => r.text)).toEqual(["Space bar", "Close space", "Switch space"]);
    expect(paletteRows("", null, items).map((r) => r.text)).toEqual(["Close space", "Switch space", "Space bar"]);
  });

  test("nothing typed: everything, no go row", () => {
    const items = [seen("Old", "https://old.example/"), action("Reload", "Ctrl+R")];
    expect(paletteRows("  ", null, items).map((r) => r.kind)).toEqual(["action", "history"]);
  });
});
