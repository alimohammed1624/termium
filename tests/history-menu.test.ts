import { describe, expect, test } from "bun:test";
import { historyRows } from "../src/app";

const entries = [
  { id: 1, url: "about:blank", title: "" },
  { id: 2, url: "http://127.0.0.1:8000/a.html", title: "Page A" },
  { id: 3, url: "https://example.com/b", title: "" },
  { id: 4, url: "http://127.0.0.1:8000/c.html", title: "Page C" },
  { id: 5, url: "http://127.0.0.1:8000/d.html", title: "Page D" },
];

describe("history menu rows", () => {
  test("back: earlier entries, nearest first, with title and host", () => {
    expect(historyRows(entries, 3, -1)).toEqual([
      { id: 3, url: "https://example.com/b", title: "example.com/b", host: "example.com" },
      { id: 2, url: "http://127.0.0.1:8000/a.html", title: "Page A", host: "127.0.0.1:8000" },
      { id: 1, url: "about:blank", title: "New Tab", host: "" },
    ]);
  });

  test("forward: later entries, nearest first", () => {
    expect(historyRows(entries, 1, 1).map((r) => r.id)).toEqual([3, 4, 5]);
  });

  test("nothing past either end", () => {
    expect(historyRows(entries, 0, -1)).toEqual([]);
    expect(historyRows(entries, 4, 1)).toEqual([]);
  });
});
