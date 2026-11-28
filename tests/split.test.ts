import { describe, expect, test } from "bun:test";
import { detectHost, holdOnFailure, kittyLayout, shellQuote, splitPlan, type Host } from "../src/split";

describe("detectHost", () => {
  test("tmux, herdr, kitty", () => {
    expect(detectHost({ TMUX: "/tmp/tmux-1/x,1,0", TMUX_PANE: "%3" })).toEqual({ kind: "tmux", pane: "%3" });
    expect(detectHost({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2" })).toEqual({ kind: "herdr", pane: "w1:p2" });
    expect(detectHost({ KITTY_WINDOW_ID: "7" })).toEqual({ kind: "kitty", pane: "7" });
  });
  test("the innermost host wins", () => {
    // tmux in kitty, herdr in tmux, tmux in herdr.
    expect(detectHost({ KITTY_WINDOW_ID: "7", TMUX: "x", TMUX_PANE: "%1", TERM_PROGRAM: "tmux" })).toMatchObject({ kind: "tmux" });
    expect(detectHost({ TMUX: "x", TMUX_PANE: "%1", HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", TERM_PROGRAM: "herdr" })).toMatchObject({ kind: "herdr" });
    expect(detectHost({ TMUX: "x", TMUX_PANE: "%1", HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", TERM_PROGRAM: "tmux" })).toMatchObject({ kind: "tmux" });
  });
  test("hosts that can't split say so", () => {
    expect(detectHost({ TERM_PROGRAM: "ghostty" })).toHaveProperty("error", expect.stringContaining("Ghostty"));
    expect(detectHost({ TERM_PROGRAM: "WezTerm", WEZTERM_PANE: "0" })).toHaveProperty("error", expect.stringContaining("WezTerm"));
    expect(detectHost({})).toHaveProperty("error", expect.stringContaining("tmux, herdr or kitty"));
  });
});

describe("splitPlan", () => {
  const cmd = ["/usr/bin/termium", "attach", "agent"];
  const env = { XDG_RUNTIME_DIR: "/run/user/1", TERMIUM_BROWSER: "/opt/h b", HOME: "/home/x", PATH: "/p" };
  const o = { cwd: "/w", focus: true, env };
  const sh = ["/bin/sh", "-c", holdOnFailure(cmd)];
  test("tmux: split-window next to this pane, with the session's environment", () => {
    const p = splitPlan({ kind: "tmux", pane: "%3" }, "right", cmd, o);
    expect(p).toEqual({
      argv: ["tmux", "split-window", "-h", "-t", "%3", "-c", "/w", "-P", "-F", "#{pane_id}",
        "-e", "PATH=/p", "-e", "TERMIUM_BROWSER=/opt/h b", "-e", "XDG_RUNTIME_DIR=/run/user/1", "--", ...sh],
    });
    expect(splitPlan({ kind: "tmux", pane: "%3" }, "down", cmd, { ...o, focus: false }).argv.slice(0, 4)).toEqual(["tmux", "split-window", "-v", "-d"]);
  });
  test("herdr: pane split, then one line for any shell runs the command from the environment", () => {
    const odd = ["/it's a/bun", "/src\\x/main.ts", "attach", "x"];
    const p = splitPlan({ kind: "herdr", pane: "w1:p1" }, "down", odd, { ...o, focus: false, bin: "/bin/herdr" });
    expect(p).toEqual({
      argv: ["/bin/herdr", "pane", "split", "--pane", "w1:p1", "--direction", "down", "--cwd", "/w", "--no-focus",
        "--env", "PATH=/p", "--env", "TERMIUM_BROWSER=/opt/h b", "--env", "XDG_RUNTIME_DIR=/run/user/1", "--env", `TERMIUM_SPLIT_RUN=${holdOnFailure(odd)}`],
      run: 'exec /bin/sh -c "$TERMIUM_SPLIT_RUN"',
    });
  });
  test("kitty: launch a window in a split next to this one", () => {
    const p = splitPlan({ kind: "kitty", pane: "7" } as Host, "right", cmd, { ...o, focus: false });
    expect(p.argv.slice(0, 8)).toEqual(["kitten", "@", "launch", "--type=window", "--location=vsplit", "--match=window_id:7", "--next-to=id:7", "--cwd=/w"]);
    expect(p.argv).toContain("--keep-focus");
    expect(p.argv.slice(-4)).toEqual(["--", ...sh]);
  });
});

test("the command survives /bin/sh whatever its arguments hold, and a failure stays on screen", () => {
  const args = ["it's", "a\\b", "$HOME", "two words", "`x`", ""];
  const r = Bun.spawnSync(["/bin/sh", "-c", holdOnFailure(["printf", "%s|", ...args])], { stdin: "ignore" });
  expect(r.stdout.toString()).toBe(args.map((a) => `${a}|`).join(""));
  const f = Bun.spawnSync(["/bin/sh", "-c", holdOnFailure(["sh", "-c", "exit 3"])], { stdin: "ignore" });
  expect(f.exitCode).toBe(3);
  expect(f.stdout.toString()).toContain("exited with status 3: press Enter");
});

test("kittyLayout finds the tab holding the window", () => {
  const ls = JSON.stringify([{ tabs: [{ layout: "tall", windows: [{ id: 1 }] }, { layout: "splits", windows: [{ id: 7 }, { id: 8 }] }] }]);
  expect(kittyLayout(ls, "7")).toBe("splits");
  expect(kittyLayout(ls, "1")).toBe("tall");
  expect(kittyLayout(ls, "9")).toHaveProperty("error");
  expect(kittyLayout("nope", "1")).toHaveProperty("error");
});

test("shellQuote", () => {
  expect(shellQuote("/usr/bin/bun")).toBe("/usr/bin/bun");
  expect(shellQuote("a b$c")).toBe("'a b$c'");
  expect(shellQuote("it's")).toBe("'it'\\''s'");
});
