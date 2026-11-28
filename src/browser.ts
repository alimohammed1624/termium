// Finds and launches a headless Helium (or any Chromium) process and returns
// its DevTools WebSocket URL.

import {
  accessSync,
  appendFileSync,
  closeSync,
  constants,
  linkSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, join } from "node:path";
import type { Subprocess } from "bun";
import { CDP } from "./cdp";

/** A browser termium looks for, in order of preference, and where it's usually installed. */
type Candidate = { name: string; paths: string[] };

const mac = (app: string, exe = app) => [
  `/Applications/${app}.app/Contents/MacOS/${exe}`,
  join(homedir(), `Applications/${app}.app/Contents/MacOS/${exe}`),
];

/**
 * Helium first: its patches include a built-in content blocker. Any other
 * Chromium works too, just without that (the first one found is used).
 */
const CANDIDATES: Candidate[] = [
  {
    name: "Helium",
    paths: [
      "helium-browser",
      "helium",
      "/opt/helium-browser-bin/helium",
      "/opt/helium/helium",
      "/usr/lib/helium/helium",
      ...mac("Helium"),
    ],
  },
  { name: "Chromium", paths: ["chromium", "chromium-browser", "/snap/bin/chromium", ...mac("Chromium")] },
  { name: "Brave", paths: ["brave-browser", "brave", ...mac("Brave Browser")] },
  { name: "Google Chrome", paths: ["google-chrome-stable", "google-chrome", ...mac("Google Chrome")] },
  { name: "Microsoft Edge", paths: ["microsoft-edge-stable", "microsoft-edge", ...mac("Microsoft Edge")] },
];

export type FoundBrowser = {
  path: string;
  /** "Helium", "Chromium"... or the file name of a browser termium doesn't know. */
  name: string;
  /** Given by --browser or TERMIUM_BROWSER rather than found. */
  explicit: boolean;
};

export function findBrowser(explicit?: string): FoundBrowser {
  // An explicit choice must resolve; silently falling back would hide a typo.
  for (const [what, choice] of [["--browser", explicit], ["TERMIUM_BROWSER", process.env.TERMIUM_BROWSER]] as const) {
    if (!choice) continue;
    const found = resolve(choice);
    if (!found) throw new Error(`${what} ${choice}: no such executable`);
    return { path: found, name: browserName(choice, found), explicit: true };
  }
  for (const c of CANDIDATES) {
    for (const p of c.paths) {
      const found = resolve(p);
      if (found) return { path: found, name: c.name, explicit: false };
    }
  }
  throw new Error(
    "Could not find Helium or another Chromium-based browser (Chromium, Brave, Google Chrome, Microsoft Edge). " +
      "Install one, or pass --browser <path> (or set TERMIUM_BROWSER).",
  );
}

/** Which known browser `given` (as typed, and as resolved to `path`) is, else its file name. */
function browserName(given: string, path: string): string {
  for (const c of CANDIDATES) {
    if (c.paths.some((p) => p === given || p === path || (!p.includes("/") && basename(path) === p))) return c.name;
  }
  return basename(path);
}

/**
 * Remembers which browser last ran on `profileDir` and says what changed:
 * "new" for a profile no browser has used through termium, "changed" with
 * the previous browser when it was another one, else "same". Profiles are
 * shared between browsers, but each encrypts saved logins with its own key
 * and an older one may refuse a profile a newer one wrote, so a change is
 * worth telling the user about.
 */
export function noteProfileBrowser(
  profileDir: string,
  browser: FoundBrowser,
): { kind: "new" } | { kind: "same" } | { kind: "changed"; before: string } {
  const file = join(profileDir, "termium-browser");
  let before: string | null = null;
  try {
    before = readFileSync(file, "utf8").trim() || null;
  } catch {}
  try {
    writeFileSync(file, `${browser.path}\n`);
  } catch {}
  if (before === null) return { kind: "new" };
  if (before === browser.path) return { kind: "same" };
  return { kind: "changed", before: browserName(before, before) };
}

/** What to tell the user when a session starts on `browser` (null: nothing). */
export function browserNotice(browser: FoundBrowser, profile: ReturnType<typeof noteProfileBrowser>): string | null {
  if (profile.kind === "changed" && profile.before !== browser.name) {
    return `Now on ${browser.name} (was ${profile.before}): you may need to sign in again`;
  }
  if (profile.kind === "new" && !browser.explicit && browser.name !== "Helium") {
    return `Using ${browser.name}: Helium not found, so no content blocker`;
  }
  return null;
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
  // A lock left by a crash can name a pid that now belongs to something
  // else: only a live browser on this very profile counts.
  return alive(pid) && browserOnProfile(pid, profileDir) ? pid : null;
}

// ------------------------------------------------------------- ownership
//
// termium records which of its processes owns the browser on a profile in
// <profile>/termium.owner. A termium killed outright (SIGKILL) can't stop
// its browser, which then keeps the profile locked; on the next start the
// record tells us, without guessing from command lines, that the browser is
// ours and its termium is gone.

interface Owner {
  termium: number;
  termiumStart: string;
  browsers: number[];
}

/**
 * Takes <profile>/termium.lock for this termium, or throws if a live
 * termium holds it. Created with O_EXCL, so of two termiums starting on
 * one profile at the same instant exactly one gets it (Chromium's own
 * profile lock has a window where both browsers start). A lock whose
 * termium has died is taken over.
 */
export function lockProfile(profileDir: string): void {
  const holder = lockFile(join(profileDir, "termium.lock"));
  if (holder === "failed") throw new Error(`can't lock the profile ${profileDir}`);
  if (holder !== null) {
    throw new Error(
      `the profile ${profileDir} is in use by another termium (pid ${holder}). ` +
        "Close it, or pass --profile <dir> or --incognito.",
    );
  }
}

/**
 * Takes the lock file `path` for this process: null once taken, the pid of
 * a live process holding it, or "failed". Created atomically (written in
 * full to a private file, then hard-linked into place, which fails if the
 * lock exists, as O_EXCL would), so of several processes starting at the
 * same instant exactly one gets it. A lock whose holder died is taken over.
 */
export function lockFile(path: string): number | null | "failed" {
  const tmp = `${path}.${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ pid: process.pid, start: ownStart() }), { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        linkSync(tmp, path);
        return null;
      } catch (e: any) {
        if (e?.code !== "EEXIST") throw new Error(`can't lock ${path}: ${e?.message ?? e}`);
      }
      const seen = readLock(path);
      if (seen.holder && alive(seen.holder.pid) && startTime(seen.holder.pid) === seen.holder.start) return seen.holder.pid;
      // Stale (its holder died, or it's unreadable). Only one process may
      // clear it, and only if it's still the very lock that was judged
      // stale; otherwise two starters could each delete the other's fresh lock.
      if (takeReclaim(path)) {
        try {
          if (readLock(path).raw === seen.raw) rmSync(path, { force: true });
        } finally {
          rmSync(`${path}.reclaim`, { force: true });
        }
      } else {
        Bun.sleepSync(25);
      }
    }
    return "failed";
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** This process's start time, asked once (ps). */
let myStart: string | null = null;
function ownStart(): string {
  return (myStart ??= startTime(process.pid));
}

/**
 * Takes lock file `path` if it's free, without asking whether a holder is
 * still alive (no `ps`): for waiting loops, which call lockFile (that does)
 * only now and then.
 */
export function tryLockFile(path: string): boolean {
  const tmp = `${path}.${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify({ pid: process.pid, start: ownStart() }), { mode: 0o600 });
    linkSync(tmp, path);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** The live holder of lock file `path`, if any. */
export function lockHolder(path: string): number | null {
  const seen = readLock(path);
  return seen.holder && alive(seen.holder.pid) && startTime(seen.holder.pid) === seen.holder.start ? seen.holder.pid : null;
}

/** Releases lock file `path` if this process holds it. */
export function unlockFile(path: string): void {
  try {
    if (JSON.parse(readFileSync(path, "utf8")).pid === process.pid) rmSync(path, { force: true });
  } catch {}
}

function readLock(path: string): { raw: string | null; holder: { pid: number; start: string } | null } {
  let raw: string | null = null;
  try {
    raw = readFileSync(path, "utf8");
    return { raw, holder: JSON.parse(raw) };
  } catch {
    return { raw, holder: null };
  }
}

/** The right to clear a stale lock; itself taken over if its holder died holding it (older than 5 s). */
function takeReclaim(lockPath: string): boolean {
  const path = `${lockPath}.reclaim`;
  try {
    closeSync(openSync(path, "wx"));
    return true;
  } catch {
    try {
      if (Date.now() - statSync(path).mtimeMs > 5000) rmSync(path, { force: true });
    } catch {}
    return false;
  }
}

export function unlockProfile(profileDir: string): void {
  unlockFile(join(profileDir, "termium.lock"));
}

/** Each termium writes its own record: <profile>/termium.owner.<pid>. */
const OWNER_PREFIX = "termium.owner.";

/** When a process started (ps lstart), to tell a live pid from a reused one. */
export function startTime(pid: number): string {
  try {
    const r = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
    return r.exitCode === 0 ? r.stdout.toString().trim() : "";
  } catch {
    return "";
  }
}

function commandOf(pid: number): string {
  try {
    const r = Bun.spawnSync(["ps", "-ww", "-o", "command=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
    return r.exitCode === 0 ? r.stdout.toString().trim() : "";
  } catch {
    return "";
  }
}

/** Whether `pid` is a browser running on exactly this profile directory. */
function browserOnProfile(pid: number, profileDir: string): boolean {
  // Chromium's rewritten process title joins its arguments with spaces.
  return ` ${commandOf(pid)} `.includes(` --user-data-dir=${profileDir} `);
}

/**
 * Records that this termium owns `browserPids` on the profile. Written as
 * soon as the browser is spawned, so a termium killed at any later moment
 * leaves a record its successor can act on.
 */
export function writeOwner(profileDir: string, browserPids: number[]): void {
  const owner: Owner = { termium: process.pid, termiumStart: startTime(process.pid), browsers: browserPids };
  try {
    writeFileSync(join(profileDir, OWNER_PREFIX + process.pid), JSON.stringify(owner));
  } catch {}
}

export function clearOwner(profileDir: string): void {
  rmSync(join(profileDir, OWNER_PREFIX + process.pid), { force: true });
}

/**
 * Stops browsers left on this profile by termiums that are no longer
 * running. Returns how many processes it stopped. Browsers termium didn't
 * record, and browsers whose termium is still alive, are never touched.
 */
export async function reapOrphans(profileDir: string): Promise<number> {
  let names: string[] = [];
  try {
    names = readdirSync(profileDir).filter((n) => n.startsWith(OWNER_PREFIX));
  } catch {
    return 0;
  }
  const victims: number[] = [];
  for (const name of names) {
    const path = join(profileDir, name);
    let owner: Owner;
    try {
      owner = JSON.parse(readFileSync(path, "utf8")) as Owner;
    } catch {
      continue;
    }
    if (alive(owner.termium) && startTime(owner.termium) === owner.termiumStart) continue; // still running
    for (const pid of owner.browsers ?? []) if (alive(pid) && browserOnProfile(pid, profileDir)) victims.push(pid);
    rmSync(path, { force: true });
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
  if (victims.length) {
    // Its helper processes (network service, renderers...) outlive it a
    // little and, noticing, write their last state into the profile (Chrome
    // flushes its cache index and network state): stop them too, and wait
    // until none is left, so nothing writes into a profile that is about to
    // be removed or used again.
    const deadline2 = Date.now() + 3000;
    for (;;) {
      const left = [...new Set([...victims.filter(alive), ...processesOnProfile(profileDir)])];
      if (!left.length || Date.now() > deadline2) break;
      for (const pid of left) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      await Bun.sleep(50);
    }
  }
  return victims.length;
}

/** This user's processes started on exactly this profile directory (a browser and its helpers). */
function processesOnProfile(profileDir: string): number[] {
  const uid = process.getuid?.();
  const r = Bun.spawnSync(["ps", "-A", "-ww", "-o", "pid=,uid=,args="], { stdout: "pipe", stderr: "ignore" });
  const out: number[] = [];
  for (const line of r.stdout.toString().split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m || (uid !== undefined && Number(m[2]) !== uid) || Number(m[1]) === process.pid) continue;
    // Chromium's rewritten process title joins its arguments with spaces.
    if (` ${m[3]} `.includes(` --user-data-dir=${profileDir} `) && alive(Number(m[1]))) out.push(Number(m[1]));
  }
  return out;
}

/** Running, not merely an exited process its parent hasn't collected yet. */
/**
 * Whether process `pid` is running (someone else's counts; a zombie, dead
 * but not yet reaped, doesn't). A killed session server is reparented when
 * its client dies too, and until something reaps it, kill(pid, 0) still
 * succeeds; going by that, what it left behind was never cleaned up.
 */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (e: any) {
    if (e?.code !== "EPERM") return false;
  }
  if (process.platform !== "linux") return true;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return false;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform !== "linux") return true;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return false;
  }
}

// ------------------------------------------------------------- launching

export interface LaunchedBrowser {
  proc: Subprocess;
  cdp: CDP;
  /** The browser's main process (the launcher may be a wrapper script). */
  browserPid: number;
  /** Its DevTools endpoint for other programs (agents, Puppeteer...), on loopback; null if it never said. */
  devtools: DevToolsEndpoint | null;
}

export interface DevToolsEndpoint {
  port: number;
  /** The browser target's WebSocket path, "/devtools/browser/<id>". */
  path: string;
}

/** The endpoint the browser wrote to <profile>/DevToolsActivePort (port, then the browser's WebSocket path). */
export function readDevToolsPort(profileDir: string): DevToolsEndpoint | null {
  try {
    const [port, path] = readFileSync(join(profileDir, "DevToolsActivePort"), "utf8").split("\n");
    const n = Number(port);
    if (!Number.isInteger(n) || n <= 0 || n > 65535 || !path?.startsWith("/devtools/browser/")) return null;
    return { port: n, path: path.trim() };
  } catch {
    return null;
  }
}

/**
 * Starts the browser headless with DevTools on a private pipe (termium's
 * own connection) and on a loopback port that agents and tools can attach
 * to (see `termium devtools`). Its own
 * output goes straight to `logPath`: piping it through our event loop could
 * fill the pipe and freeze the browser while we're busy writing frames.
 * `tmpDir`, if given, becomes the browser's TMPDIR (removed by the caller).
 */
export async function launchBrowser(
  bin: string,
  profileDir: string,
  logPath: string,
  tmpDir: string | null,
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
    "--remote-debugging-pipe",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-session-crashed-bubble",
    // Don't advertise automation (navigator.webdriver) to every page.
    "--disable-blink-features=AutomationControlled",
    // Crash dumps stay with this profile rather than the user's own Helium config.
    `--crash-dumps-dir=${join(profileDir, "crashes")}`,
  ];
  // A DevTools port for other programs (agents, Puppeteer, Playwright,
  // chrome-devtools-mcp): any free port, on loopback only. termium itself
  // keeps using the pipe.
  args.push("--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1");
  args.push("about:blank");
  // The port is read from this file once the browser is up: one left by an
  // earlier run must not be mistaken for it.
  rmSync(join(profileDir, "DevToolsActivePort"), { force: true });

  appendFileSync(logPath, `\n--- ${new Date().toISOString()} ${args.join(" ")}\n`);
  const logStart = statSync(logPath).size;
  const logFd = openSync(logPath, "a");
  const env = { ...process.env };
  if (tmpDir) env.TMPDIR = tmpDir;
  const proc = Bun.spawn(args, {
    stdio: ["ignore", "ignore", logFd, "pipe", "pipe"],
    env,
  });
  closeSync(logFd);
  const [, , , toBrowser, fromBrowser] = proc.stdio as unknown as number[];
  writeOwner(profileDir, [proc.pid]);

  // Ready once the browser answers on our pipe. Asking it for its own pid
  // (rather than reading the profile lock) means a second termium racing
  // us for the same profile can never mistake our browser for its own.
  const cdp = CDP.fromPipe(toBrowser!, fromBrowser!);
  const failed = (why: string) => {
    const tail = readTail(logPath, logStart);
    const hint = /Permission denied|Read-only file system|EACCES|EROFS/i.test(tail)
      ? ` It can't write to the profile directory ${profileDir}.`
      : /ProcessSingleton|profile appears to be in use|SingletonLock: File exists/i.test(tail)
        ? " The profile is in use; close the other termium, or pass --profile <dir> or --incognito."
        : /Socket path too long/.test(tail)
          ? " Its temp directory path is too long; set a shorter TMPDIR."
          : "";
    return new Error(`${why}.${hint}${tail ? `\n${tail}` : ""}`);
  };
  const exited = proc.exited.then((code) => {
    throw failed(`Browser exited with code ${code} before it was ready`);
  });
  const timeout = Bun.sleep(timeoutMs).then(() => {
    throw failed(`Browser did not start within ${timeoutMs / 1000}s (see ${logPath})`);
  });
  try {
    // If the pipe closes, it's because the browser exited: report that.
    const asked = cdp.send("SystemInfo.getProcessInfo").catch(async (e) => {
      await Promise.race([proc.exited, Bun.sleep(2000)]);
      if (proc.exitCode !== null) await exited;
      throw e;
    });
    const info = await Promise.race([asked, exited, timeout]);
    const browserPid = (info as any)?.processInfo?.find((p: any) => p.type === "browser")?.id ?? proc.pid;
    exited.catch(() => {});
    timeout.catch(() => {});
    writeOwner(profileDir, [...new Set([browserPid, proc.pid])]);
    // Written as the port opens, which may be just after the pipe answers.
    let devtools: DevToolsEndpoint | null = null;
    for (let i = 0; i < 100 && !(devtools = readDevToolsPort(profileDir)); i++) await Bun.sleep(50);
    return { proc, cdp, browserPid, devtools };
  } catch (e) {
    proc.kill(9);
    exited.catch(() => {});
    timeout.catch(() => {});
    throw e;
  }
}

/** What the browser logged since `from` (this run only), last 1500 characters. */
function readTail(path: string, from: number): string {
  try {
    return readFileSync(path).subarray(from).toString("utf8").trim().slice(-1500);
  } catch {
    return "";
  }
}
