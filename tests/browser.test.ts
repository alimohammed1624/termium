import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserNotice, findBrowser, noteProfileBrowser, type FoundBrowser } from "../src/browser";

let dir: string;
const savedEnv = process.env.TERMIUM_BROWSER;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "termium-browser-test-"));
  delete process.env.TERMIUM_BROWSER;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.TERMIUM_BROWSER;
  else process.env.TERMIUM_BROWSER = savedEnv;
});

function exe(name: string): string {
  const p = join(dir, name);
  writeFileSync(p, "#!/bin/sh\n");
  chmodSync(p, 0o755);
  return p;
}

test("an explicit browser is named after the file when termium knows it", () => {
  const b = findBrowser(exe("chromium"));
  expect(b).toEqual({ path: join(dir, "chromium"), name: "Chromium", explicit: true });
  expect(findBrowser(exe("my-browser")).name).toBe("my-browser");
  process.env.TERMIUM_BROWSER = exe("google-chrome-stable");
  expect(findBrowser()).toMatchObject({ name: "Google Chrome", explicit: true });
});

test("an explicit browser that doesn't exist is an error, not a fallback", () => {
  expect(() => findBrowser(join(dir, "nope"))).toThrow("--browser");
});

test("the profile remembers its browser and reports a change", () => {
  const helium: FoundBrowser = { path: exe("helium"), name: "Helium", explicit: false };
  const chromium: FoundBrowser = { path: exe("chromium"), name: "Chromium", explicit: false };
  const profile = join(dir, "profile");
  mkdirSync(profile);

  expect(noteProfileBrowser(profile, helium)).toEqual({ kind: "new" });
  expect(noteProfileBrowser(profile, helium)).toEqual({ kind: "same" });
  const changed = noteProfileBrowser(profile, chromium);
  expect(changed).toEqual({ kind: "changed", before: "Helium" });
  expect(readFileSync(join(profile, "termium-browser"), "utf8").trim()).toBe(chromium.path);
  expect(browserNotice(chromium, changed)).toBe("Now on Chromium (was Helium): you may need to sign in again");
});

test("a found browser other than Helium is pointed out once, on a new profile", () => {
  const chromium: FoundBrowser = { path: "/usr/bin/chromium", name: "Chromium", explicit: false };
  expect(browserNotice(chromium, { kind: "new" })).toBe("Using Chromium: Helium not found, so no content blocker");
  expect(browserNotice(chromium, { kind: "same" })).toBeNull();
  expect(browserNotice({ ...chromium, explicit: true }, { kind: "new" })).toBeNull();
  expect(browserNotice({ ...chromium, name: "Helium" }, { kind: "new" })).toBeNull();
});
