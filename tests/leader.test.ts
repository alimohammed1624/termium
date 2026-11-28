import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LEADER, chooseLeader, hostPrefixes, leaderLabel, parseLeader } from "../src/leader";

describe("parseLeader", () => {
  test("takes the usual spellings", () => {
    for (const s of ["ctrl-space", "Ctrl+Space", "C-Space", "^space", "ctrl-spc"]) expect(parseLeader(s)).toEqual({ combo: "ctrl+space" });
    for (const s of ["ctrl-a", "CTRL+A", "C-a", "^A", "control-a"]) expect(parseLeader(s)).toEqual({ combo: "ctrl+a" });
    expect(parseLeader("ctrl-b")).toEqual({ combo: "ctrl+b" });
  });
  test("refuses what can't be a leader", () => {
    for (const s of ["", "a", "space", "alt-a", "ctrl-1", "ctrl-ab", "M-a", "None"]) expect("error" in parseLeader(s)).toBe(true);
    // termium's own shortcuts, and keys a terminal sends as Tab/Enter/Backspace
    for (const k of "clqrtwhijm") expect((parseLeader(`ctrl-${k}`) as { error: string }).error).toContain(`Ctrl+${k.toUpperCase()}`);
  });
});

test("leaderLabel", () => {
  expect(leaderLabel("ctrl+b")).toBe("Ctrl+B");
  expect(leaderLabel("ctrl+b", true)).toBe("^B");
  expect(leaderLabel("ctrl+space")).toBe("Ctrl+Space");
  expect(leaderLabel("ctrl+space", true)).toBe("^Space");
});

describe("chooseLeader", () => {
  test("Ctrl+B outside a multiplexer, or when the host's prefix is another key", () => {
    expect(chooseLeader(undefined, [])).toBe(DEFAULT_LEADER);
    expect(chooseLeader(undefined, [{ keys: ["ctrl+a"] }])).toBe("ctrl+b");
    expect(chooseLeader(undefined, [{ keys: [] }])).toBe("ctrl+b");
  });
  test("a fallback the host doesn't take when it takes Ctrl+B", () => {
    expect(chooseLeader(undefined, [{ keys: ["ctrl+b"] }])).toBe("ctrl+space");
    expect(chooseLeader(undefined, [{ keys: ["ctrl+space", "ctrl+b"] }])).toBe("ctrl+a");
    expect(chooseLeader(undefined, [{ keys: ["ctrl+a"] }, { keys: ["ctrl+b"] }])).toBe("ctrl+space");
  });
  test("an explicit leader always wins", () => {
    expect(chooseLeader("ctrl+b", [{ keys: ["ctrl+b"] }])).toBe("ctrl+b");
    expect(chooseLeader("ctrl+a", [])).toBe("ctrl+a");
  });
});

describe("hostPrefixes: herdr", () => {
  const dir = mkdtempSync(join(tmpdir(), "termium-leader-"));
  const env = (extra: Record<string, string>) => ({ HOME: dir, XDG_CONFIG_HOME: join(dir, "cfg"), ...extra });
  test("not in herdr: nothing", () => {
    expect(hostPrefixes(env({}))).toEqual([]);
  });
  test("herdr's default (no config) is Ctrl+B", () => {
    expect(hostPrefixes(env({ HERDR_ENV: "1" }))).toEqual([{ host: "herdr", keys: ["ctrl+b"] }]);
  });
  test("reads keys.prefix from its config.toml", () => {
    mkdirSync(join(dir, "cfg", "herdr"), { recursive: true });
    writeFileSync(join(dir, "cfg", "herdr", "config.toml"), '[theme]\nname = "x"\n[keys]\nprefix = "ctrl+a"\n');
    expect(hostPrefixes(env({ HERDR_ENV: "1" }))).toEqual([{ host: "herdr", keys: ["ctrl+a"] }]);
    const other = join(dir, "other.toml");
    writeFileSync(other, '[keys]\nprefix = "ctrl+space"\n');
    expect(hostPrefixes(env({ HERDR_PANE_ID: "p1", HERDR_CONFIG_PATH: other }))).toEqual([{ host: "herdr", keys: ["ctrl+space"] }]);
  });
  test("a prefix that isn't Ctrl and a letter (F12) leaves Ctrl+B to termium", () => {
    writeFileSync(join(dir, "cfg", "herdr", "config.toml"), '[keys]\nprefix = "f12"\n');
    const hosts = hostPrefixes(env({ HERDR_ENV: "1" }));
    expect(hosts).toEqual([{ host: "herdr", keys: ["f12"] }]);
    expect(chooseLeader(undefined, hosts)).toBe("ctrl+b");
  });
  test("an empty or \"none\" prefix is herdr's default (herdr falls back to it)", () => {
    for (const v of ["", "none"]) {
      writeFileSync(join(dir, "cfg", "herdr", "config.toml"), `[keys]\nprefix = "${v}"\n`);
      expect(hostPrefixes(env({ HERDR_ENV: "1" }))).toEqual([{ host: "herdr", keys: ["ctrl+b"] }]);
    }
  });
  test("a config it can't read counts as herdr's default", () => {
    writeFileSync(join(dir, "cfg", "herdr", "config.toml"), "[keys\nprefix=");
    expect(hostPrefixes(env({ HERDR_ENV: "1" }))).toEqual([{ host: "herdr", keys: ["ctrl+b"] }]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe.skipIf(!Bun.which("tmux"))("hostPrefixes: tmux", () => {
  test("reads the pane's session's prefix and prefix2 (a private tmux server)", () => {
    const dir = mkdtempSync(join(tmpdir(), "termium-leader-tmux-"));
    const sock = join(dir, "sock");
    const tmux = (...a: string[]) => Bun.spawnSync(["tmux", "-S", sock, "-f", "/dev/null", ...a], { stdout: "pipe", stderr: "pipe" });
    try {
      expect(tmux("new-session", "-d", "-s", "s", "sleep 60").success).toBe(true);
      const pane = tmux("display-message", "-p", "-t", "s", "#{pane_id}").stdout.toString().trim();
      const env = { TMUX: `${sock},1,0`, TMUX_PANE: pane };
      expect(hostPrefixes(env)).toEqual([{ host: "tmux", keys: ["ctrl+b"] }]);
      expect(chooseLeader(undefined, hostPrefixes(env))).toBe("ctrl+space");
      tmux("set", "-t", "s", "prefix", "C-a");
      expect(hostPrefixes(env)).toEqual([{ host: "tmux", keys: ["ctrl+a"] }]);
      expect(chooseLeader(undefined, hostPrefixes(env))).toBe("ctrl+b");
      tmux("set", "-t", "s", "prefix2", "C-b");
      expect(chooseLeader(undefined, hostPrefixes(env))).toBe("ctrl+space");
      // keys termium wouldn't take as a leader still count as the host's
      tmux("set", "-t", "s", "prefix", "F12");
      tmux("set", "-t", "s", "prefix2", "C-t");
      expect(hostPrefixes(env)).toEqual([{ host: "tmux", keys: ["f12", "ctrl+t"] }]);
      expect(chooseLeader(undefined, hostPrefixes(env))).toBe("ctrl+b");
    } finally {
      tmux("kill-server");
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
