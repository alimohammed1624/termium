// The leader key: what starts termium's key commands (Ctrl+B by default).
// Inside tmux or herdr, whose prefix is usually Ctrl+B too, the attached
// terminal picks another one unless it was told which (--leader,
// TERMIUM_LEADER).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The leader outside a multiplexer (a key combo as comboOf spells it). */
export const DEFAULT_LEADER = "ctrl+b";
/** Leaders used instead when the host already takes Ctrl+B, the first one it doesn't take. */
const FALLBACK_LEADERS = ["ctrl+space", "ctrl+a"];

/**
 * Ctrl+letters that can't be the leader: termium's own shortcuts (copy,
 * address bar, quit, reload, new tab, close), and ones a terminal sends as
 * another key (Tab, Enter, Backspace).
 */
const RESERVED: Record<string, string> = {
  c: "copies", l: "edits the address", q: "quits", r: "reloads", t: "opens a tab", w: "closes the pane",
  h: "is Backspace in most terminals", i: "is Tab in terminals", j: "is Enter in terminals", m: "is Enter in terminals",
};

/**
 * `ctrl-space`, `ctrl+a`, `C-a` (tmux), `^A`: the combo it means
 * ("ctrl+space", "ctrl+a"), or why it can't be a leader.
 */
export function parseLeader(s: string): { combo: string } | { error: string } {
  const raw = s.trim().toLowerCase();
  let key: string | null = null;
  const m = raw.match(/^(?:ctrl|control|c)[-+](.+)$/) ?? raw.match(/^\^(.+)$/);
  if (m) key = m[1]!;
  if (key === "spc" || key === "space") return { combo: "ctrl+space" };
  if (!key || !/^[a-z]$/.test(key)) {
    return { error: `can't use "${s}" as the leader: give Ctrl and a letter or Space, such as ctrl-space or ctrl-a` };
  }
  if (RESERVED[key]) return { error: `can't use Ctrl+${key.toUpperCase()} as the leader: it ${RESERVED[key]}` };
  return { combo: `ctrl+${key}` };
}

/** How the leader `combo` is shown: "Ctrl+B" / "Ctrl+Space", or short, "^B" / "^Space". */
export function leaderLabel(combo: string, short = false): string {
  const key = combo.replace(/^ctrl\+/, "");
  const name = key === "space" ? "Space" : key.toUpperCase();
  return short ? `^${name}` : `Ctrl+${name}`;
}

/**
 * A multiplexer's key as a combo ("C-b", "ctrl+b" → "ctrl+b"), to compare
 * with leaders; any other key (F12, M-a, a backtick) as written: it can't
 * collide with a leader. null for none.
 */
function hostKey(s: string): string | null {
  const raw = s.trim().toLowerCase();
  if (!raw || raw === "none") return null;
  const m = raw.match(/^(?:ctrl|control|c)[-+](.+)$/) ?? raw.match(/^\^(.+)$/);
  if (!m) return raw;
  return m[1] === "spc" || m[1] === "space" ? "ctrl+space" : `ctrl+${m[1]}`;
}

/** The tmux prefix keys (prefix, prefix2) for this pane, as combos; [] if tmux can't say. */
function tmuxPrefixes(env: NodeJS.ProcessEnv): string[] {
  const args = ["tmux", "display-message", "-p"];
  if (env.TMUX_PANE) args.push("-t", env.TMUX_PANE);
  args.push("#{prefix}\t#{prefix2}");
  try {
    const r = Bun.spawnSync(args, { stdout: "pipe", stderr: "ignore", env });
    if (!r.success) return [];
    return r.stdout.toString().trim().split("\t").flatMap((k) => hostKey(k) ?? []);
  } catch {
    return [];
  }
}

/** herdr's prefix from its config.toml (herdr's own default, Ctrl+B, if it doesn't set one or can't be read). */
function herdrPrefix(env: NodeJS.ProcessEnv): string[] {
  const path = env.HERDR_CONFIG_PATH || join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config"), "herdr", "config.toml");
  try {
    const prefix = (Bun.TOML.parse(readFileSync(path, "utf8")) as { keys?: { prefix?: unknown } }).keys?.prefix;
    // (herdr takes an empty or "none" prefix for a bad one: its default.)
    if (typeof prefix === "string") return [hostKey(prefix) ?? DEFAULT_LEADER];
  } catch {}
  return [DEFAULT_LEADER];
}

/** The keys the multiplexer(s) this terminal runs in take for themselves. */
export function hostPrefixes(env: NodeJS.ProcessEnv = process.env): { host: string; keys: string[] }[] {
  const hosts: { host: string; keys: string[] }[] = [];
  if (env.TMUX) hosts.push({ host: "tmux", keys: tmuxPrefixes(env) });
  if (env.HERDR_ENV === "1" || env.HERDR_PANE_ID) hosts.push({ host: "herdr", keys: herdrPrefix(env) });
  return hosts;
}

/**
 * The leader for this terminal: `explicit` (--leader, TERMIUM_LEADER) if
 * given; else Ctrl+B, unless a multiplexer around it takes Ctrl+B, then
 * the first fallback it doesn't take.
 */
export function chooseLeader(explicit: string | undefined, hosts: { keys: string[] }[]): string {
  if (explicit) return explicit;
  const taken = new Set(hosts.flatMap((h) => h.keys));
  if (!taken.has(DEFAULT_LEADER)) return DEFAULT_LEADER;
  return FALLBACK_LEADERS.find((k) => !taken.has(k)) ?? DEFAULT_LEADER;
}
