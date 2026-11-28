import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { comboOf } from "../src/app";
import { FOOTER_ACTIONS, SEPARATOR, chipText, keyOf, layoutFooter, loadFooterMode, saveFooterMode } from "../src/footer";
import { width } from "../src/text";

describe("hint footer", () => {
  test("every action's keys read back as the combos the keybinds match", () => {
    for (const actions of Object.values(FOOTER_ACTIONS)) {
      for (const a of actions) {
        for (const combo of a.combo.split(" ")) expect(comboOf(keyOf(combo))).toBe(combo);
      }
    }
  });

  test("Enter and Escape are the named keys prompts look for", () => {
    expect(keyOf("enter")).toMatchObject({ key: "Enter", code: "Enter", vk: 13 });
    expect(keyOf("escape")).toMatchObject({ key: "Escape", vk: 27 });
    expect(keyOf("shift+n")).toMatchObject({ key: "N", code: "KeyN", mods: { shift: true } });
    expect(keyOf("ctrl+b")).toMatchObject({ key: "b", text: "", mods: { ctrl: true } });
  });

  test("lays out only the actions that fit, separated", () => {
    const actions = FOOTER_ACTIONS.normal;
    const all = layoutFooter(actions, 1000);
    expect(all.length).toBe(actions.length);
    for (let i = 1; i < all.length; i++) expect(all[i]!.start).toBe(all[i - 1]!.end + width(SEPARATOR));
    const first = width(chipText(actions[0]!));
    expect(layoutFooter(actions, first).length).toBe(1);
    expect(layoutFooter(actions, first - 1).length).toBe(0);
  });

  test("on for someone who never chose; the choice is kept; the environment wins", () => {
    const dir = mkdtempSync(join(tmpdir(), "footer-test-"));
    try {
      const file = join(dir, "state", "footer.json");
      expect(loadFooterMode(file, {})).toBe("on");
      expect(saveFooterMode(file, "auto")).toBe(true);
      expect(loadFooterMode(file, {})).toBe("auto");
      expect(loadFooterMode(file, { TERMIUM_FOOTER: "off" })).toBe("off");
      writeFileSync(file, "{not json");
      expect(loadFooterMode(file, {})).toBe("on");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
