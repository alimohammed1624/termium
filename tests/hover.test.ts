import { describe, expect, test } from "bun:test";
import { Hover, POINTER_HAND, POINTER_RESET, type Zone } from "../src/hover";

const styles = () => ({ hover: "<H>", hoverLit: "<L>", press: "<P>" });

function setup(pressMs = 20) {
  const writes: string[] = [];
  let attached = true;
  const h = new Hover((s) => (attached ? (writes.push(s), true) : false), styles, pressMs);
  const draw = () => {
    h.begin();
    h.add({ id: "tab:0", row: 1, col: 1, text: " 1 one ", style: "<tab>" });
    h.add({ id: "tab:1", row: 1, col: 9, text: " 2 \x1b[1mtwo ", style: "<tab>" });
    h.add({ id: "pane", row: 3, col: 1, text: " focused", style: "<lit>", lit: true });
    return h.end();
  };
  return { h, writes, draw, detach: () => (attached = false) };
}

describe("Hover", () => {
  test("finds the zone under a cell", () => {
    const { h, draw } = setup();
    draw();
    expect(h.at(1, 1)?.id).toBe("tab:0");
    expect(h.at(7, 1)?.id).toBe("tab:0");
    expect(h.at(8, 1)).toBeUndefined();
    expect(h.at(9, 1)?.id).toBe("tab:1");
    expect(h.at(1, 2)).toBeUndefined();
  });

  test("lights the hovered span, sets a hand, and clears both on leaving", () => {
    const { h, writes, draw } = setup();
    draw();
    h.move(2, 1);
    expect(writes).toEqual(["\x1b[1;1H<tab><H> 1 one \x1b[0m" + POINTER_HAND]);
    h.move(8, 1);
    expect(writes[1]).toBe("\x1b[1;1H<tab> 1 one \x1b[0m" + POINTER_RESET);
  });

  test("a move within a span, or over nothing clickable, writes nothing", () => {
    const { h, writes, draw } = setup();
    draw();
    h.move(20, 10);
    h.move(21, 10);
    expect(writes).toEqual([]);
    h.move(2, 1);
    h.move(3, 1);
    h.move(6, 1);
    expect(writes.length).toBe(1);
  });

  test("moving between spans repaints only those two", () => {
    const { h, writes, draw } = setup();
    draw();
    h.move(2, 1);
    h.move(10, 1);
    expect(writes[1]).toBe("\x1b[1;1H<tab> 1 one \x1b[0m\x1b[1;9H<tab><H> 2 \x1b[1mtwo \x1b[0m");
  });

  test("an already lit span uses the lifted color", () => {
    const { h, writes, draw } = setup();
    draw();
    h.move(1, 3);
    expect(writes[0]).toStartWith("\x1b[3;1H<lit><L> focused");
  });

  test("a click flashes the span, without its inner colors, then goes back to hover", async () => {
    const { h, writes, draw } = setup();
    draw();
    h.move(10, 1);
    h.press(h.at(10, 1));
    expect(writes[1]).toBe("\x1b[1;9H<tab><P> 2 two \x1b[0m");
    await Bun.sleep(40);
    expect(writes[2]).toBe("\x1b[1;9H<tab><H> 2 \x1b[1mtwo \x1b[0m");
  });

  test("a redraw puts the hover and the flash back on the fresh spans", () => {
    const { h, draw } = setup(1000);
    draw();
    h.move(2, 1);
    h.press(h.at(10, 1));
    const s = draw();
    expect(s).toContain("\x1b[1;1H<tab><H> 1 one ");
    expect(s).toContain("\x1b[1;9H<tab><P> 2 two ");
    expect(s).not.toContain(POINTER_HAND); // the hand is already up
    h.reset();
  });

  test("a redraw with nothing clickable (an overlay) drops the hover", () => {
    const { h, writes, draw } = setup();
    draw();
    h.move(2, 1);
    h.begin();
    h.add({ id: "tab:0", row: 1, col: 1, text: " 1 one ", style: "<tab>" });
    expect(h.end(false)).toBe(POINTER_RESET);
    expect(h.current).toBeNull();
    expect(writes.length).toBe(1);
  });

  test("tells listeners which zone the pointer is over", () => {
    const { h, draw } = setup();
    draw();
    const seen: (string | null)[] = [];
    h.onChange((z: Zone | null) => seen.push(z?.id ?? null));
    h.move(2, 1);
    h.move(3, 1);
    h.move(10, 1);
    h.move(30, 30);
    h.leave();
    expect(seen).toEqual(["tab:0", "tab:1", null]);
  });

  test("an update dropped while detached is redrawn in full by the next redraw", () => {
    const { h, writes, draw, detach } = setup();
    draw();
    detach();
    h.move(2, 1);
    expect(writes).toEqual([]);
    expect(draw()).toBe("\x1b[1;1H<tab><H> 1 one \x1b[0m" + POINTER_HAND);
  });
});
