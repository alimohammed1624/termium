// Chromeless mode's address line over a page's top row: the picture under it is cut, not squeezed.
import { expect, test } from "bun:test";
import { comboOf } from "../src/app";
import { InputParser, type KeyEvent } from "../src/input";
import { drawImage, placeholderCells } from "../src/terminal";

test("a picture placed with its top pixels left out says so (y=), and only then", () => {
  expect(drawImage("AAAA", 5, null, 2, 1, 80, 23, 40)).toContain("a=T,f=100,i=5,p=1,q=2,C=1,c=80,r=23,y=40,m=0");
  expect(drawImage("AAAA", 5, null, 1, 1, 80, 24)).toContain("c=80,r=24,m=0");
  expect(drawImage("AAAA", 5, null, 1, 1, 80, 24)).not.toContain("y=");
});

test("placeholder cells can leave the first rows as they are", () => {
  const all = placeholderCells(1, 7, false, 1, 1, 4, 3);
  const cut = placeholderCells(1, 7, false, 1, 1, 4, 3, 1);
  expect(all).toContain("\x1b[1;1H");
  expect(cut).not.toContain("\x1b[1;1H");
  // The rows that are drawn keep their place in the picture (row marks 1 and 2).
  expect(cut).toContain("\x1b[2;1H");
  expect(cut).toContain("\x1b[3;1H");
  expect(cut.slice(cut.indexOf("\x1b[2;1H"))).toBe(all.slice(all.indexOf("\x1b[2;1H")));
});

// Chromeless is Ctrl+B F (Shift+f); plain Ctrl+B f is find's.
test("F after the prefix is shift+f, from legacy and kitty input; f stays f", () => {
  const combo = (data: string, kitty: boolean) => {
    const events: KeyEvent[] = [];
    const p = new InputParser((e) => { if (e.type === "key") events.push(e); });
    p.kittyActive = kitty;
    p.feed(data);
    return comboOf(events[0]!);
  };
  expect(combo("F", false)).toBe("shift+f");
  expect(combo("\x1b[102;2;70u", true)).toBe("shift+f");
  expect(combo("f", false)).toBe("f");
  expect(combo("\x1b[102;1;102u", true)).toBe("f");
});
