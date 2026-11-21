// Finds and launches a headless Helium (or any Chromium) process and returns
// its DevTools WebSocket URL.

import {
  accessSync,
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  statSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";

const CANDIDATES = [
  "helium-browser",
  "helium",
  "/opt/helium-browser-bin/helium",
  "/opt/helium/helium",
  "/usr/lib/helium/helium",
  "/Applications/Helium.app/Contents/MacOS/Helium",
];

export function findBrowser(explicit?: string): string {
  // An explicit choice must resolve; silently falling back would hide a typo.
  for (const [what, choice] of [["--browser", explicit], ["TERMIUM_BROWSER", process.env.TERMIUM_BROWSER]] as const) {
    if (!choice) continue;
    const found = resolve(choice);
    if (!found) throw new Error(`${what} ${choice}: no such executable`);
    return found;
  }
  for (const c of CANDIDATES) {
    const found = resolve(c);
    if (found) return found;
  }
  throw new Error(
    "Could not find Helium. Install it, or pass --browser <path> (or set TERMIUM_BROWSER).",
  );
}

function resolve(c: string): string | null {
  if (!c.includes("/")) return Bun.which(c);
  try {
    accessSync(c, constants.X_OK);
    return statSync(c).isFile() ? c : null;
  } catch {
    return null;
  }
}

/**
 * The pid holding the profile's lock, if that process is alive on this
 * host. Chromium's SingletonLock is a symlink to "<hostname>-<pid>".
 */
export function profileOwner(profileDir: string): number | null {
  let target: string;
  try {
    target = readlinkSync(join(profileDir, "SingletonLock"));
  } catch {
    return null;
  }
  const m = target.match(/^(.*)-(\d+)$/);
  if (!m || m[1] !== hostname()) return null;
  const pid = Number(m[2]);
  return alive(pid) ? pid : null;
}

/**
 * Stops headless browsers left behind on this profile by a termium that was
 * killed outright (SIGKILL gives it no chance to clean up). Only processes
 * started the way termium starts them, on this exact profile, with no live
 * termium among their ancestors, qualify. Linux only (it reads /proc).
 */
export async function reapOrphans(profileDir: string): Promise<number> {
  if (process.platform !== "linux") return 0;
  const want = `--user-data-dir=${profileDir}`;
  const victims: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const args = cmdline(Number(entry));
    if (!args) continue;
    // Chromium rewrites its process title into one space-joined string, so
    // match on the joined command line rather than on separate arguments.
    const line = ` ${args.join(" ").trim()} `;
    const has = (flag: string) => line.includes(` ${flag} `);
    if (!has(want) || !has("--headless=new") || !has("--remote-debugging-port=0")) continue;
    if (line.includes(" --type=")) continue; // a child of the browser, not the browser
    if (!ownedByTermium(Number(entry))) victims.push(Number(entry));
  }
  for (const pid of victims) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  const deadline = Date.now() + 3000;
  while (victims.some(alive) && Date.now() < deadline) await Bun.sleep(50);
  for (const pid of victims.filter(alive)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  return victims.length;
}

function cmdline(pid: number): string[] | null {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
  } catch {
    return null;
  }
}

function parentOf(pid: number): number {
  try {
    // The command name can contain spaces and parentheses; fields follow the last ")".
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  } catch {
    return 0;
  }
}

/** True if some ancestor of `pid` is a running termium (the binary, or bun running termium's main.ts). */
function ownedByTermium(pid: number): boolean {
  for (let p = parentOf(pid), hops = 0; p > 1 && hops < 32; p = parentOf(p), hops++) {
    const args = cmdline(p);
    if (!args) return false;
    const exe = args[0]?.split("/").pop() ?? "";
    if (exe === "termium" || args.some((a) => /(^|\/)termium\/src\/main\.ts$/.test(a) || a === "src/main.ts")) return true;
  }
  return false;
}

/** Running, not merely an exited process its parent hasn't collected yet. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return process.platform !== "linux";
  }
}

export interface LaunchedBrowser {
  proc: Subprocess<"ignore", "ignore", number>;
  wsUrl: string;
}

/**
 * Starts the browser headless and waits for its DevTools endpoint. The
 * browser's own output goes straight to `logPath`: piping it through our
 * event loop could fill the pipe and freeze the browser while we're busy
 * writing frames to the terminal.
 */
export async function launchBrowser(
  bin: string,
  profileDir: string,
  logPath: string,
  tmpDir: string,
  timeoutMs = 30_000,
): Promise<LaunchedBrowser> {
  const owner = profileOwner(profileDir);
  if (owner !== null) {
    throw new Error(
      `the profile ${profileDir} is in use by another browser (pid ${owner}). ` +
        "Close the other termium, or pass --profile <dir> or --incognito.",
    );
  }
  const args = [
    bin,
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-session-crashed-bubble",
    // Don't advertise automation (navigator.webdriver) to every page.
    "--disable-blink-features=AutomationControlled",
    "about:blank",
  ];
  // DevToolsActivePort may be stale from an earlier run; wait for a new one
  // rather than deleting it.
  const portFile = join(profileDir, "DevToolsActivePort");
  const stale = readPortFile(portFile);
  appendFileSync(logPath, `\n--- ${new Date().toISOString()} ${args.join(" ")}\n`);
  const logFd = openSync(logPath, "a");
  const proc = Bun.spawn(args, {
    stdin: "ignore",
    stdout: "ignore",
    stderr: logFd,
    env: { ...process.env, TMPDIR: tmpDir },
  });
  closeSync(logFd);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      const tail = readTail(logPath);
      const hint = /ProcessSingleton|profile.*in use|SingletonLock/i.test(tail)
        ? " The profile seems to be in use; pass --profile <dir> or --incognito."
        : "";
      throw new Error(`Browser exited with code ${proc.exitCode} before it was ready.${hint}\n${tail}`);
    }
    const now = readPortFile(portFile);
    if (now && (!stale || now.text !== stale.text || now.mtime > stale.mtime)) {
      const [port, path] = now.text.split("\n");
      if (port && path) return { proc, wsUrl: `ws://127.0.0.1:${port.trim()}${path.trim()}` };
    }
    await Bun.sleep(25);
  }
  proc.kill(9);
  throw new Error(`Browser did not start within ${timeoutMs / 1000}s. See ${logPath}`);
}

function readPortFile(path: string): { text: string; mtime: number } | null {
  try {
    if (!existsSync(path)) return null;
    return { text: readFileSync(path, "utf8"), mtime: statSync(path).mtimeMs };
  } catch {
    return null;
  }
}

function readTail(path: string): string {
  try {
    return readFileSync(path, "utf8").trim().slice(-1500);
  } catch {
    return "";
  }
}
