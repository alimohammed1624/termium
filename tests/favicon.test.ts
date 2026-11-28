import { describe, expect, test } from "bun:test";
import { IconLayer, parseDataUrl, siteColour } from "../src/favicon";

function layer() {
  let next = 10;
  return new IconLayer(() => next++);
}

describe("IconLayer", () => {
  test("places a new icon under spaces, then leaves it (and its cells) alone", () => {
    const l = layer();
    l.begin();
    expect(l.cell(1, 5, 2, "a", "PNG")).toBe("  ");
    let r = l.end();
    expect(r.draw).toContain("\x1b[1;5H\x1b_Ga=T,f=100,i=10,p=1,q=2,C=1,c=2,r=1");
    expect(r.stale).toEqual([]);

    l.begin();
    expect(l.cell(1, 5, 2, "a", "PNG")).toBe("\x1b[2C");
    r = l.end();
    expect(r.draw).toBe("");
    expect(r.stale).toEqual([]);
  });

  test("a changed icon gets a new picture; the old one is deleted after it", () => {
    const l = layer();
    l.begin();
    l.cell(1, 5, 2, "a", "PNG");
    l.end();
    l.begin();
    expect(l.cell(1, 5, 2, "b", "PNG")).toBe("  ");
    const r = l.end();
    expect(r.draw).toContain("i=11,");
    expect(r.stale).toEqual([10]);
  });

  test("icons no longer drawn (or moved) are deleted", () => {
    const l = layer();
    l.begin();
    l.cell(1, 5, 2, "a", "PNG");
    l.cell(3, 4, 2, "b", "PNG");
    l.end();
    l.begin();
    l.cell(1, 9, 2, "a", "PNG"); // moved
    const r = l.end();
    expect(r.stale.sort()).toEqual([10, 11]);
  });

  test("after a reset (screen cleared) every icon is placed again", () => {
    const l = layer();
    l.begin();
    l.cell(1, 5, 2, "a", "PNG");
    l.end();
    expect(l.reset()).toEqual([10]);
    l.begin();
    expect(l.cell(1, 5, 2, "a", "PNG")).toBe("  ");
    expect(l.end().stale).toEqual([]);
  });
});

describe("siteColour", () => {
  test("same host, same colour; a hex RGB", () => {
    expect(siteColour("https://example.com/a")).toBe(siteColour("https://example.com/b?x"));
    expect(siteColour("https://example.com/")).toMatch(/^[0-9a-f]{6}$/);
  });

  test("hosts spread over several hues", () => {
    const hosts = ["github.com", "example.com", "duckduckgo.com", "news.ycombinator.com", "wikipedia.org", "bun.sh", "kitty.org", "localhost:3000"];
    expect(new Set(hosts.map((h) => siteColour(`https://${h}/`))).size).toBeGreaterThanOrEqual(4);
  });
});

describe("parseDataUrl", () => {
  test("base64 and percent-encoded", () => {
    expect(parseDataUrl("data:image/png;base64,iVBORw0K")).toEqual({ data: "iVBORw0K", type: "image/png" });
    const svg = parseDataUrl("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22/%3E");
    expect(svg?.type).toBe("image/svg+xml");
    expect(Buffer.from(svg!.data, "base64").toString()).toBe('<svg xmlns="http://www.w3.org/2000/svg"/>');
  });

  test("empty or malformed: none", () => {
    expect(parseDataUrl("data:image/png;base64,")).toBeNull();
    expect(parseDataUrl("data:,%E0%A4%A")).toBeNull();
    expect(parseDataUrl("https://x/")).toBeNull();
  });
});
