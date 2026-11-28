// Splits of the host terminal: `termium open --split right|down` and
// `termium ctl split`. The terminal multiplexer (or terminal) termium runs
// in is asked for a real split of the current pane, which then runs
// `termium attach NAME`. One small adapter per host: tmux and herdr, and
// kitty (through its remote control). Hosts with no command to ask for a
// split (Ghostty, WezTerm for now) fail with a message saying what to do.

import { tmuxPassthroughSetting } from "./client";

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

/**
 * What the new pane runs: `termium attach NAME`; or, with a URL for the
 * running session, `termium -s NAME URL`, which attaches and opens it in a
 * new tab shown there (as a person running it would).
 */
export function splitArgv(self: string[], session: string, url: string | null): string[] {
  return url ? [...self, "--session", session, url] : [...self, "attach", session];
}

/** One argument for a POSIX shell. */
export function shellQuote(s: string): string {
  return /^[A-Za-z0-9_\-./:=@%+,]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * What the new pane runs, for /bin/sh -c: `cmd`, and if it fails (the
 * terminal can't show pictures, say) its message stays on screen until
 * Enter, rather than the pane closing at once. Detaching closes it.
 */
export function holdOnFailure(cmd: string[]): string {
  return (
    `${cmd.map(shellQuote).join(" ")} || { s=$?; printf '\\n[termium exited with status %s: press Enter to close this pane]' "$s"; ` +
    `read -r _; exit "$s"; }`
  );
}

export interface SplitPlan {
  /** The command that makes the split; it prints the new pane's id. */
  argv: string[];
  /** herdr: the line typed into the new pane's shell (`herdr pane run`). */
  run?: string;
}

/** How to ask `host` for a split running `cmd`, in directory `cwd`, with `env` passed on. */
export function splitPlan(
  host: Host,
  dir: SplitDir,
  cmd: string[],
  o: { cwd: string; focus: boolean; env: Record<string, string | undefined>; bin?: string },
): SplitPlan {
  const passed = Object.entries(o.env)
    .filter(([k, v]) => v !== undefined && PASSED_ENV.test(k))
    .sort(([a], [b]) => a.localeCompare(b)) as [string, string][];
  const sh = ["/bin/sh", "-c", holdOnFailure(cmd)];
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
          ...sh,
        ],
      };
    case "herdr":
      // A herdr pane starts the user's shell (bash, zsh, fish...) and the
      // command is typed into it. It goes in an environment variable, so
      // the line typed is the same in every shell whatever the paths hold;
      // exec: the pane closes when termium does, as in tmux and kitty.
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
          "--env",
          `TERMIUM_SPLIT_RUN=${sh[2]}`,
        ],
        run: `exec /bin/sh -c "$TERMIUM_SPLIT_RUN"`,
      };
    case "kitty":
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
          ...sh,
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

const KITTY_RC = "kitty needs remote control for this: allow_remote_control yes (or socket-only, with listen_on) in kitty.conf";

/** The layout of the kitty tab holding window `id` (from `kitten @ ls`), or why it can't be had. */
export function kittyLayout(ls: string, id: string): string | { error: string } {
  try {
    for (const os of JSON.parse(ls)) for (const tab of os.tabs ?? []) if ((tab.windows ?? []).some((w: any) => String(w.id) === id)) return String(tab.layout);
  } catch {}
  return { error: `kitty didn't list window ${id}` };
}

export interface PreparedSplit {
  host: HostKind;
  /** Makes the split; returns the new pane's id. Throws with a one-line reason. */
  make(): string;
}

/**
 * Checks that the host can make the split (before anything is started or
 * opened for it) and returns how to make it. Throws with a one-line reason.
 */
export function prepareSplit(dir: SplitDir, cmd: string[], focus: boolean, env = process.env): PreparedSplit {
  const host = detectHost(env);
  if ("error" in host) throw new Error(host.error);
  const bin = host.kind === "herdr" ? env.HERDR_BIN_PATH || undefined : host.kind === "kitty" && !Bun.which("kitten") ? "kitty" : undefined;
  const plan = splitPlan(host, dir, cmd, { cwd: process.cwd(), focus, env, bin });
  const exe = plan.argv[0]!;
  if (host.kind === "tmux" && tmuxPassthroughSetting() === "off") {
    // termium in the new pane would stop at once: say so here.
    throw new Error("tmux has allow-passthrough off, so termium can't show pages in a tmux pane (tmux set -g allow-passthrough on)");
  }
  if (host.kind === "kitty") {
    // Remote control on, and a layout that splits (the others place windows their own way).
    const ls = run([...plan.argv.slice(0, plan.argv.indexOf("@") + 1), "ls"]);
    if (!ls.ok) throw new Error(`kitty refused: ${ls.err || ls.out || "remote control failed"} (${KITTY_RC})`);
    const layout = kittyLayout(ls.out, host.pane);
    if (typeof layout !== "string") throw new Error(layout.error);
    if (layout !== "splits") {
      throw new Error(`this kitty tab uses the ${layout} layout, which doesn't split ${dir} (switch it to the splits layout: enabled_layouts splits)`);
    }
  }
  const failed = (why: string) => new Error(`${host.kind} couldn't make the split: ${why || "it failed"}`);
  return {
    host: host.kind,
    make() {
      const r = run(plan.argv);
      if (!r.ok) throw failed(r.err || r.out);
      if (host.kind !== "herdr") return r.out.split("\n").pop()!.trim();
      let pane: string;
      try {
        pane = String(JSON.parse(r.out).result.pane.pane_id);
      } catch {
        throw failed(`unexpected answer ${JSON.stringify(r.out.slice(0, 200))}`);
      }
      const ran = run([exe, "pane", "run", pane, plan.run!]);
      if (!ran.ok) {
        run([exe, "pane", "close", pane]);
        throw failed(ran.err || ran.out);
      }
      return pane;
    },
  };
}
