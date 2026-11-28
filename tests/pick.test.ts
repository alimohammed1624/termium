import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { parseCtl } from "../src/ctl";
import { pickedLine, pickedText, type Picked } from "../src/pick";

const picked: Picked = {
  tab: 3,
  ref: "3:142@2",
  url: "https://example.com/login",
  title: "Log in",
  role: "button",
  name: "Sign in",
  tag: "button",
  selector: "#login > button:nth-of-type(2)",
  text: "Sign in",
  html: '<button class="primary">Sign in</button>',
  at: 0,
};

describe("ctl pick / picked", () => {
  test("parse", () => {
    expect(parseCtl(["picked"]).req).toMatchObject({ cmd: "picked", wait: false });
    expect(parseCtl(["-s", "a", "picked", "--wait", "--json"])).toMatchObject({ session: "a", json: true, req: { cmd: "picked", wait: true } });
    expect(parseCtl(["pick", "--timeout", "120"])).toMatchObject({ timeoutMs: 120_000, req: { cmd: "pick" } });
  });
  test("bad usage is exit 2", () => {
    const ctl = (...args: string[]) => spawnSync("bun", [join(import.meta.dir, "../src/main.ts"), "ctl", ...args], { encoding: "utf8" });
    for (const args of [["pick", "--wait"], ["picked", "extra"], ["open", "x", "--wait"]]) {
      const r = ctl(...args);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/^termium: /);
    }
  });
});

describe("the picked element's description", () => {
  test("a line like the snapshot's", () => {
    expect(pickedLine(picked)).toBe('button "Sign in" [3:142@2]');
    expect(pickedLine({ ...picked, role: "", name: "" })).toBe("button [3:142@2]");
  });
  test("what's pasted to an agent", () => {
    expect(pickedText(picked, "default")).toBe(
      [
        'Picked in termium: button "Sign in" [3:142@2]',
        "page: https://example.com/login",
        "selector: #login > button:nth-of-type(2)",
        "text: Sign in",
        'html: <button class="primary">Sign in</button>',
        "act on it: termium ctl click 3:142@2 (or type 3:142@2 TEXT)",
      ].join("\n"),
    );
    const t = pickedText({ ...picked, text: "", frame: "https://example.com/f", shadow: true, html: "x".repeat(400) }, "work");
    expect(t).toContain("frame: https://example.com/f\n");
    expect(t).toContain("(in a shadow root)");
    expect(t).not.toContain("text:");
    expect(t).toContain("termium ctl -s work click 3:142@2");
    expect(t.split("\n").find((l) => l.startsWith("html: "))!.length).toBe(206);
  });
});
