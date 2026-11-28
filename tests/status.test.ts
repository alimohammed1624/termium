import { describe, expect, test } from "bun:test";
import { helpKey, hintText, linkText, splitLink } from "../src/status";

const strip = (s: string) => s.replace(/<[a-z]>/g, "");

describe("splitLink", () => {
  test("https: no scheme, host, then the rest", () => {
    expect(splitLink("https://example.com/a/b?q=1#x")).toEqual({ lead: "", host: "example.com", rest: "/a/b?q=1#x" });
  });
  test("other schemes keep theirs; ports stay with the host", () => {
    expect(splitLink("http://127.0.0.1:8080/page.html")).toEqual({ lead: "http://", host: "127.0.0.1:8080", rest: "/page.html" });
  });
  test("no host: the scheme dim, the rest bright", () => {
    expect(splitLink("mailto:a@b.c")).toEqual({ lead: "mailto:", host: "a@b.c", rest: "" });
  });
});

describe("linkText", () => {
  test("host bright, path dim, padded to the width", () => {
    const s = linkText("https://example.com/path", 30, "<b>", "<d>");
    expect(s).toBe("<d><b>example.com<d>/path" + " ".repeat(14));
  });
  test("a long path is cut, the host stays", () => {
    const s = strip(linkText("https://example.com/" + "x".repeat(200), 30, "<b>", "<d>"));
    expect(s.length).toBe(30);
    expect(s.startsWith("example.com/")).toBe(true);
    expect(s.endsWith("…")).toBe(true);
  });
  test("control characters never reach the terminal", () => {
    expect(linkText("https://e.com/\x1b[31m", 20, "", "")).not.toContain("\x1b");
  });
});

describe("hintText", () => {
  test("action bright, keybind in the key color", () => {
    expect(hintText("Reload page  ^R", 15, "<b>", "<k>")).toBe("<b>Reload page<k>  ^R");
  });
  test("short of room, the action is cut and the keybind stays", () => {
    expect(strip(hintText("Reload page  ^R", 10, "<b>", "<k>"))).toBe("Reloa…  ^R");
  });
  test("a keybind that doesn't fit whole is left out, never cut", () => {
    expect(strip(hintText("Update termium  ^B U", 5, "", ""))).toBe("^B U ");
    expect(strip(hintText("Update termium  ^B U", 3, "", ""))).toBe("Up…");
  });
  test("no keybind", () => {
    expect(strip(hintText("Stop loading", 14, "", ""))).toBe("Stop loading  ");
  });
});

describe("helpKey", () => {
  const help: [string, string][] = [
    ["Ctrl+R / F5", "reload"],
    ["Alt+← / Alt+→", "back / forward"],
    ["", ""],
    ["Ctrl+B then…", ""],
    ["c", "new tab"],
    ["n / p / 1-9", "next / previous / go to tab"],
  ];
  test("the first key, Ctrl+ as ^", () => expect(helpKey(help, "reload")).toBe("^R"));
  test("another alternative", () => expect(helpKey(help, "back / forward", 1)).toBe("Alt+→"));
  test("under a prefix", () => expect(helpKey(help, "next / previous / go to tab", 2)).toBe("^B 1-9"));
  test("missing", () => expect(helpKey(help, "nope")).toBe(""));
  test("the real table has every key the hints use", async () => {
    // (HELP isn't exported; the hints' descriptions must stay in it.)
    const src = await Bun.file(new URL("../src/app.ts", import.meta.url)).text();
    const used = [...src.matchAll(/helpKey\(HELP, "([^"]+)"/g)].map((m) => m[1]!);
    expect(used.length).toBeGreaterThan(5);
    for (const d of used) expect(src).toContain(`", "${d}"]`);
  });
});
