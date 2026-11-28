// Splits of the host terminal: `termium open --split right|down` and
// `termium ctl split`. The terminal multiplexer (or terminal) termium runs
// in is asked for a real split of the current pane, which then runs
// `termium attach NAME`. One small adapter per host: tmux and herdr, and
// kitty (through its remote control). Hosts with no command to ask for a
// split (Ghostty, WezTerm for now) fail with a message saying what to do.

export type SplitDir = "right" | "down";
export type HostKind = "tmux" | "herdr" | "kitty";

export interface Host {
  kind: HostKind;
  /** The pane (window, for kitty) termium runs in: the one that's split. */
  pane: string;
}

/** What the new pane needs from this one's environment to find the session. */
const PASSED_ENV = /^(XDG_RUNTIME_DIR|XDG_STATE_HOME|XDG_DATA_HOME|TMPDIR|TERMIUM_[A-Z0-9_]+)$/;

/**
 * The host to ask for a split, from the environment; or why there's none.
 * Inside nested hosts (tmux in kitty, say) all their variables are set:
 * TERM_PROGRAM names the innermost one where it can.
 */
export function detectHost(env: Record<string, string | undefined>): Host | { error: string } {
  const tmux = env.TMUX && env.TMUX_PANE ? { kind: "tmux" as const, pane: env.TMUX_PANE } : null;
  const herdr = env.HERDR_ENV === "1" && env.HERDR_PANE_ID ? { kind: "herdr" as const, pane: env.HERDR_PANE_ID } : null;
  const kitty = env.KITTY_WINDOW_ID ? { kind: "kitty" as const, pane: env.KITTY_WINDOW_ID } : null;
  const prog = (env.TERM_PROGRAM ?? "").toLowerCase();
  if (prog === "tmux" && tmux) return tmux;
  if (prog === "herdr" && herdr) return herdr;
  if (tmux) return tmux;
  if (herdr) return herdr;
  if (prog === "wezterm" || env.WEZTERM_PANE) {
    return { error: "WezTerm splits aren't supported yet (run termium attach in a split of your own: wezterm cli split-pane)" };
  }
  if (prog === "ghostty") return { error: "Ghostty has no command to make a split (make one yourself, Ctrl+Shift+O by default, and run termium attach in it)" };
  if (kitty) return kitty;
  return { error: "no terminal to ask for a split: --split works inside tmux, herdr or kitty" };
}

/** Quotes an argument for the pane's shell (POSIX shells and fish alike), or null if it can't be. */
export function shellQuote(s: string): string | null {
  if (/^[A-Za-z0-9_\-./:=@%+,]+$/.test(s)) return s;
  // fish reads \ and ' inside single quotes differently from POSIX shells.
  if (/['\\\n\r]/.test(s)) return null;
  return `'${s}'`;
}

export interface SplitPlan {
  /** The command that makes the split; it prints the new pane's id. */
  argv: string[];
  /** herdr: the shell command to run in the new pane (`herdr pane run`). */
  run?: string;
}

/** How to ask `host` for a split running `cmd`, in directory `cwd`, with `env` passed on. */
export function splitPlan(
  host: Host,
  dir: SplitDir,
  cmd: string[],
  o: { cwd: string; focus: boolean; env: Record<string, string | undefined>; bin?: string },
): SplitPlan | { error: string } {
  const passed = Object.entries(o.env)
    .filter(([k, v]) => v !== undefined && PASSED_ENV.test(k))
    .sort(([a], [b]) => a.localeCompare(b)) as [string, string][];
  switch (host.kind) {
    case "tmux":
      return {
        argv: [
          o.bin ?? "tmux",
          "split-window",
          dir === "right" ? "-h" : "-v",
          ...(o.focus ? [] : ["-d"]),
          "-t",
          host.pane,
          "-c",
          o.cwd,
          "-P",
          "-F",
          "#{pane_id}",
          ...passed.flatMap(([k, v]) => ["-e", `${k}=${v}`]),
          "--",
          ...cmd,
        ],
      };
    case "herdr": {
      // A herdr pane starts a shell; the command is typed into it. exec: the
      // pane closes when termium does, as in tmux and kitty.
      const quoted = cmd.map(shellQuote);
      const bad = quoted.findIndex((q) => q === null);
      if (bad >= 0) return { error: `can't pass ${JSON.stringify(cmd[bad])} to a herdr pane's shell (it has a quote or backslash)` };
      return {
        argv: [
          o.bin ?? "herdr",
          "pane",
          "split",
          "--pane",
          host.pane,
          "--direction",
          dir,
          "--cwd",
          o.cwd,
          o.focus ? "--focus" : "--no-focus",
          ...passed.flatMap(([k, v]) => ["--env", `${k}=${v}`]),
        ],
        run: `exec ${quoted.join(" ")}`,
      };
    }
    case "kitty":
      // A split in kitty's splits layout; other layouts place the window as they do.
      return {
        argv: [
          ...(o.bin ? [o.bin] : ["kitten"]),
          "@",
          "launch",
          "--type=window",
          `--location=${dir === "right" ? "vsplit" : "hsplit"}`,
          `--next-to=id:${host.pane}`,
          `--cwd=${o.cwd}`,
          ...(o.focus ? [] : ["--keep-focus"]),
          ...passed.flatMap(([k, v]) => ["--env", `${k}=${v}`]),
          "--",
          ...cmd,
        ],
      };
  }
}

function run(argv: string[]): { ok: boolean; out: string; err: string } {
  try {
    const r = Bun.spawnSync(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    return { ok: r.exitCode === 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
  } catch (e: any) {
    return { ok: false, out: "", err: e?.message ?? String(e) };
  }
}

const HINT: Record<HostKind, string> = {
  tmux: "",
  herdr: "",
  kitty: " (kitty needs remote control: allow_remote_control yes, or socket-only with listen_on, in kitty.conf)",
};

/**
 * Splits the pane termium runs in and runs `cmd` in the new one. Returns
 * the host and the new pane's id; throws with a one-line reason.
 */
export function splitHost(dir: SplitDir, cmd: string[], focus: boolean, env = process.env): { host: HostKind; pane: string } {
  const host = detectHost(env);
  if ("error" in host) throw new Error(host.error);
  const bin = host.kind === "herdr" ? env.HERDR_BIN_PATH || undefined : host.kind === "kitty" && !Bun.which("kitten") ? "kitty" : undefined;
  const plan = splitPlan(host, dir, cmd, { cwd: process.cwd(), focus, env, bin });
  if ("error" in plan) throw new Error(plan.error);
  const r = run(plan.argv);
  const failed = (why: string) => new Error(`${host.kind} couldn't make the split: ${why || "it failed"}${HINT[host.kind]}`);
  if (!r.ok) throw failed(r.err || r.out);
  let pane = r.out.split("\n").pop()!.trim();
  if (host.kind === "herdr") {
    try {
      pane = String(JSON.parse(r.out).result.pane.pane_id);
    } catch {
      throw failed(`unexpected answer ${JSON.stringify(r.out.slice(0, 200))}`);
    }
    const ran = run([plan.argv[0]!, "pane", "run", pane, plan.run!]);
    if (!ran.ok) {
      run([plan.argv[0]!, "pane", "close", pane]);
      throw failed(ran.err || ran.out);
    }
  }
  return { host: host.kind, pane };
}
