import { describe, expect, test } from "bun:test";
import { detectHost, shellQuote, splitPlan, type Host } from "../src/split";

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
  const env = { XDG_RUNTIME_DIR: "/run/user/1", TERMIUM_BROWSER: "/opt/h b", HOME: "/home/x" };
  const o = { cwd: "/w", focus: true, env };
  test("tmux: split-window next to this pane, with the session's environment", () => {
    const p = splitPlan({ kind: "tmux", pane: "%3" }, "right", cmd, o);
    expect(p).toEqual({
      argv: ["tmux", "split-window", "-h", "-t", "%3", "-c", "/w", "-P", "-F", "#{pane_id}",
        "-e", "TERMIUM_BROWSER=/opt/h b", "-e", "XDG_RUNTIME_DIR=/run/user/1", "--", ...cmd],
    });
    expect((splitPlan({ kind: "tmux", pane: "%3" }, "down", cmd, { ...o, focus: false }) as any).argv.slice(0, 4)).toEqual(["tmux", "split-window", "-v", "-d"]);
  });
  test("herdr: pane split, then the command typed into its shell", () => {
    const p = splitPlan({ kind: "herdr", pane: "w1:p1" }, "down", ["/a b/bun", "/src/main.ts", "attach", "x"], { ...o, focus: false, bin: "/bin/herdr" });
    expect(p).toEqual({
      argv: ["/bin/herdr", "pane", "split", "--pane", "w1:p1", "--direction", "down", "--cwd", "/w", "--no-focus",
        "--env", "TERMIUM_BROWSER=/opt/h b", "--env", "XDG_RUNTIME_DIR=/run/user/1"],
      run: "exec '/a b/bun' /src/main.ts attach x",
    });
    expect(splitPlan({ kind: "herdr", pane: "w1:p1" }, "down", ["/it's/bun"], o)).toHaveProperty("error");
  });
  test("kitty: launch a window in a split next to this one", () => {
    const p = splitPlan({ kind: "kitty", pane: "7" } as Host, "right", cmd, { ...o, focus: false }) as any;
    expect(p.argv.slice(0, 7)).toEqual(["kitten", "@", "launch", "--type=window", "--location=vsplit", "--next-to=id:7", "--cwd=/w"]);
    expect(p.argv).toContain("--keep-focus");
    expect(p.argv.slice(-4)).toEqual(["--", ...cmd]);
  });
});

test("shellQuote", () => {
  expect(shellQuote("/usr/bin/bun")).toBe("/usr/bin/bun");
  expect(shellQuote("a b$c")).toBe("'a b$c'");
  expect(shellQuote("it's")).toBeNull();
  expect(shellQuote("a\\b")).toBeNull();
});
