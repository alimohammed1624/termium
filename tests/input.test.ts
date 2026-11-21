import { describe, expect, test } from "bun:test";
import { InputParser, type InputEvent } from "../src/input";

function parse(data: string | string[], kitty = true): InputEvent[] {
  const events: InputEvent[] = [];
  const p = new InputParser((e) => events.push(e));
  p.kittyActive = kitty;
  for (const chunk of Array.isArray(data) ? data : [data]) p.feed(chunk);
  return events;
}

describe("kitty keyboard", () => {
  test("plain letter with associated text, press and release", () => {
    const [down, up] = parse("\x1b[97;1;97u\x1b[97;1:3u") as any[];
    expect(down).toMatchObject({ key: "a", code: "KeyA", vk: 65, text: "a", event: "press", legacy: false });
    expect(up).toMatchObject({ key: "a", event: "release", text: "" });
  });
  test("shift gives the shifted key and text", () => {
    const [ev] = parse("\x1b[97;2;65u") as any[];
    expect(ev).toMatchObject({ key: "A", code: "KeyA", text: "A", mods: { shift: true } });
  });
  test("ctrl+l has no text", () => {
    const [ev] = parse("\x1b[108;5u") as any[];
    expect(ev).toMatchObject({ key: "l", text: "", mods: { ctrl: true, shift: false } });
  });
  test("enter, escape and arrows", () => {
    const evs = parse("\x1b[13u\x1b[27u\x1b[1;3D\x1b[D") as any[];
    expect(evs.map((e) => e.key)).toEqual(["Enter", "Escape", "ArrowLeft", "ArrowLeft"]);
    expect(evs[0].text).toBe("\r");
    expect(evs[2].mods.alt).toBe(true);
  });
  test("tilde keys and F-keys", () => {
    const evs = parse("\x1b[5~\x1b[3;5~\x1b[15~\x1b[13~") as any[];
    expect(evs.map((e) => e.key)).toEqual(["PageUp", "Delete", "F5", "F3"]);
    expect(evs[1].mods.ctrl).toBe(true);
  });
  test("symbols map to US physical keys", () => {
    const [q] = parse("\x1b[47;2;63u") as any[];
    expect(q).toMatchObject({ key: "?", code: "Slash", vk: 191 });
  });
  test("sequence split across chunks", () => {
    const evs = parse(["\x1b[9", "7;1;97u"]) as any[];
    expect(evs).toHaveLength(1);
    expect(evs[0].key).toBe("a");
  });
});

describe("legacy keys", () => {
  test("printable, control and alt", () => {
    const evs = parse("a\x0c\x1bx\r\x7f", false) as any[];
    expect(evs.map((e) => [e.key, e.mods.ctrl, e.mods.alt, e.legacy])).toEqual([
      ["a", false, false, true],
      ["l", true, false, true],
      ["x", false, true, true],
      ["Enter", false, false, true],
      ["Backspace", false, false, true],
    ]);
  });
});

describe("mouse, paste and replies", () => {
  test("SGR pixel mouse press, motion, release, wheel", () => {
    const evs = parse("\x1b[<0;120;45M\x1b[<32;130;45M\x1b[<0;130;45m\x1b[<65;10;10M\x1b[<128;1;1M") as any[];
    expect(evs.map((e) => [e.action, e.button])).toEqual([
      ["press", 0], ["move", 0], ["release", 0], ["wheel", 3], ["press", 7],
    ]);
    expect(evs[0]).toMatchObject({ x: 120, y: 45 });
    expect(evs[3].wheel).toBe("down");
  });
  test("bracketed paste, including a split terminator", () => {
    const evs = parse(["\x1b[200~hello\nwor", "ld\x1b[20", "1~"]) as any[];
    expect(evs).toEqual([{ type: "paste", text: "hello\nworld" }]);
  });
  test("capability replies", () => {
    const evs = parse("\x1b_Gi=31;OK\x1b\\\x1b[?27u\x1b[?1016;1$y\x1b[6;20;10t\x1b[4;900;1600t\x1b[?62;22c");
    expect(evs).toEqual([
      { type: "kittyGraphics", id: 31, message: "OK" },
      { type: "kittyKeyboard", flags: 27 },
      { type: "modeReport", mode: 1016, value: 1 },
      { type: "cellSize", width: 10, height: 20 },
      { type: "textAreaSize", width: 1600, height: 900 },
      { type: "deviceAttributes" },
    ]);
  });
});
