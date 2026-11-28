import { describe, expect, test } from "bun:test";
import { CtlError, parseKey } from "../src/agent";
import { parseCtl } from "../src/ctl";

describe("parseKey", () => {
  test("named keys", () => {
    expect(parseKey("Enter")).toMatchObject({ key: "Enter", code: "Enter", vk: 13, text: "\r", modifiers: 0 });
    expect(parseKey("tab")).toMatchObject({ key: "Tab", vk: 9, text: "" });
    expect(parseKey("ArrowDown")).toMatchObject({ key: "ArrowDown", vk: 40 });
    expect(parseKey("F5")).toMatchObject({ key: "F5", vk: 116 });
  });
  test("characters and modifiers", () => {
    expect(parseKey("a")).toMatchObject({ key: "a", code: "KeyA", vk: 65, text: "a", modifiers: 0 });
    expect(parseKey("shift+a")).toMatchObject({ key: "A", text: "A", modifiers: 8 });
    expect(parseKey("ctrl+a")).toMatchObject({ key: "a", text: "", modifiers: 2, commands: ["selectAll"] });
    expect(parseKey("Control+Shift+Z")).toMatchObject({ modifiers: 10, commands: ["redo"] });
    expect(parseKey("shift+Tab")).toMatchObject({ key: "Tab", modifiers: 8 });
    expect(parseKey("ctrl++")).toMatchObject({ key: "+", modifiers: 2 });
    expect(parseKey("7")).toMatchObject({ code: "Digit7", vk: 55, text: "7" });
  });
  test("bad keys are usage errors", () => {
    expect(() => parseKey("ctrl+bogus")).toThrow(CtlError);
    expect(() => parseKey("hyper+a")).toThrow(/unknown modifier/);
  });
});

describe("parseCtl", () => {
  test("options anywhere, positional arguments in order", () => {
    expect(parseCtl(["-s", "agent", "click", "3:142@2", "--double"])).toMatchObject({
      session: "agent",
      req: { cmd: "click", ref: "3:142@2", double: true, button: "left" },
    });
    expect(parseCtl(["type", "3:5@1", "hello world", "--submit", "--json"])).toMatchObject({
      json: true,
      req: { cmd: "type", ref: "3:5@1", text: "hello world", submit: true, append: false },
    });
    expect(parseCtl(["open", "example.com", "--new-tab"]).req).toMatchObject({ url: "example.com", newTab: true, wait: true });
    expect(parseCtl(["scroll", "2:9@4", "up", "300"]).req).toMatchObject({ ref: "2:9@4", direction: "up", amount: 300 });
    expect(parseCtl(["eval", "1+1", "4", "--timeout", "2.5"])).toMatchObject({ timeoutMs: 2500, req: { expr: "1+1", tab: 4 } });
    expect(parseCtl(["wait", "selector", "#x", "--gone"]).req).toMatchObject({ what: "selector", value: "#x", gone: true });
    expect(parseCtl(["key", "--tab", "2", "ctrl+a", "Backspace"]).req).toMatchObject({ tab: 2, keys: ["ctrl+a", "Backspace"] });
    expect(parseCtl(["click", "--xy", "10,20.5"]).req).toMatchObject({ xy: [10, 20.5] });
    expect(parseCtl(["type", "1:2@1", "--", "-5"]).req).toMatchObject({ text: "-5" });
    expect(parseCtl(["shot", "-o", "a.png", "--full"])).toMatchObject({ out: "a.png", req: { full: true } });
  });

  test("mute and unmute take an optional tab", () => {
    expect(parseCtl(["mute", "3"]).req).toMatchObject({ cmd: "mute", tab: 3 });
    expect(parseCtl(["unmute", "--tab", "2"]).req).toMatchObject({ cmd: "unmute", tab: 2 });
    expect(parseCtl(["mute"]).req).toMatchObject({ cmd: "mute", tab: undefined });
  });
});
