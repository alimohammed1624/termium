// The session server: a background process that owns the browser, the
// DevTools connection, the profile lock and all of termium's state (spaces,
// tabs, splits). Terminals attach to it as clients (src/client.ts); it keeps
// running while none is attached.
//
// One client at a time: a new attach takes over, and the previous client is
// told it was detached (like `tmux attach -d`).

import { appendFileSync, chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { App } from "./app";
import {
  clearOwner,
  findBrowser,
  launchBrowser,
  lockFile,
  lockProfile,
  pidAlive,
  reapOrphans,
  unlockFile,
  unlockProfile,
  type LaunchedBrowser,
} from "./browser";
import { CDP } from "./cdp";
import type { InputEvent } from "./input";
import {
  DEFAULT_SESSION,
  FrameReader,
  PROTOCOL,
  dial,
  jsonFrame,
  outputFrame,
  sessionPaths,
  sweepGraphicsFiles,
  readRestore,
  restoreConflict,
  savedLaunch,
  restorePath,
  writeRestore,
  type Restore,
} from "./session";
import { setSink } from "./terminal";
import {
  MAX_AGE_MS,
  cachePath,
  cachedNewer,
  binaryVersionAsync,
  checkAndCache,
  currentExe,
  displayVersion,
  isNewer,
  loadCache,
  selfUpdate,
  selfUpdateBlocker,
  skipVersion,
} from "./update";

export interface LaunchOptions {
  url: string | null;
  browser?: string;
  profile?: string;
  incognito: boolean;
  scale: number | null;
  search: string;
}

/** What a client says when it attaches. */
export interface Hello {
  t: "hello";
  v: number;
  kind: "attach" | "info" | "kill" | "abandon";
  version?: string;
  cols?: number;
  rows?: number;
  cellW?: number;
  cellH?: number;
  pixelMouse?: boolean;
  placeholders?: boolean;
  /** The client's working directory: relative paths typed in this terminal mean that. */
  cwd?: string;
  /** Placeholder ids may use RGB colours (the terminal under tmux shows RGB). */
  rgbIds?: boolean;
  /** How pictures reach the terminal (for the log): "direct", "tmux-files" or "tmux-paced". */
  via?: string;
  /** Open this in a new tab (attaching to a session that's already running). */
  url?: string | null;
  /** This terminal wants update news: the session checks for a newer termium while it's attached. */
  updateCheck?: boolean;
  /** How to run this terminal's termium (its binary, or bun and the script): a restart into it runs that. */
  argv?: string[];
  /**
   * Pid of the server this client started, if any: that server opened the
   * URL itself (so it's not opened twice), and only that one may be
   * abandoned by this client.
   */
  starter?: number;
}

/**
 * Where per-run temp dirs go. Chromium puts a Unix socket a few levels
 * below TMPDIR, and socket paths are limited to ~107 bytes, so a long TMPDIR
 * falls back to /tmp.
 */
export function tempBase(): string {
  const base = tmpdir();
  return base.length <= 40 ? base : "/tmp";
}

/**
 * Removes what termiums that died without cleaning up (SIGKILL) left in the
 * temp dir: browser temp dirs, and incognito profiles along with any
 * browser still running on them.
 */
async function sweepTemp(): Promise<void> {
  sweepGraphicsFiles(); // picture files of clients killed outright
  const base = tempBase();
  let names: string[] = [];
  try {
    names = readdirSync(base);
  } catch {
    return;
  }
  for (const name of names) {
    const m = name.match(/^(tmb|termium-incognito)-(\d+)-/);
    if (!m) continue;
    if (pidAlive(Number(m[2]))) continue; // that termium is still running (or it's someone else's)
    const dir = join(base, name);
    const marker = join(dir, ".sweeping");
    let marked = false;
    try {
      // Two termiums starting at once mustn't both clean the same leftover:
      // the first to create the marker does it, the other leaves it alone.
      if (m[1] === "termium-incognito") {
        try {
          closeSync(openSync(marker, "wx"));
          marked = true;
        } catch {
          continue;
        }
        await reapOrphans(dir).catch(() => 0);
      }
      // The browser's last processes may still be writing as they exit.
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // Not ours to remove (another user's), or still busy: never a reason
      // not to start, and the next start tries again.
      if (marked) rmSync(marker, { force: true });
    }
  }
}

/** $TERMIUM_DOWNLOAD_DIR, else the XDG download directory (xdg-user-dir), else ~/Downloads. */
function downloadDir(): string {
  // Absolute now: relative to where the session started, whichever terminal is attached later.
  if (process.env.TERMIUM_DOWNLOAD_DIR) return resolvePath(process.env.TERMIUM_DOWNLOAD_DIR);
  try {
    const r = Bun.spawnSync(["xdg-user-dir", "DOWNLOAD"], { stdout: "pipe", stderr: "ignore" });
    const dir = r.stdout.toString().trim();
    if (r.exitCode === 0 && dir && dir !== homedir()) return dir;
  } catch {}
  return join(homedir(), "Downloads");
}

/** Keeps a log under 5 MB: the previous one is kept as <name>.1. */
function rotate(path: string): void {
  try {
    if (statSync(path).size > 5 * 1024 * 1024) renameSync(path, `${path}.1`);
  } catch {}
}

function isRunning(pid: number): boolean {
  return pidAlive(pid);
}

/**
 * A session's profile unless --profile/--incognito say otherwise: the
 * default session keeps termium's original one; a named session gets its
 * own, so several can run at once.
 */
export function defaultProfile(dataDir: string, name: string): string {
  return name === DEFAULT_SESSION ? join(dataDir, "profile") : join(dataDir, "profiles", name);
}

export function stateDir(): string {
  return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "termium");
}

/** Startup failures go to stderr (the session's .err file), which the client that started us shows. */
function die(msg: string, code = 2): never {
  console.error(`termium: ${msg}`);
  process.exit(code);
}

/** One connected client. */
class Conn {
  private reader: FrameReader;
  private acks = new Map<number, () => void>();
  private seq = 0;
  closed = false;

  constructor(
    readonly sock: Socket,
    onMessage: (c: Conn, msg: any) => void,
    onClose: (c: Conn) => void,
    log: (msg: string) => void,
  ) {
    this.reader = new FrameReader((f) => {
      if (f.type !== 1) return;
      // Small frames only, until it has said hello in a version we speak.
      if (f.msg?.t === "hello" && f.msg?.v === PROTOCOL) this.reader.maxFrame = 64 * 1024 * 1024;
      try {
        onMessage(this, f.msg);
      } catch (e) {
        // A bug handling one message (a key, say) mustn't cost the terminal.
        log(`handling ${JSON.stringify(f.msg?.t)}: ${e instanceof Error ? e.stack : e}`);
      }
    });
    this.reader.maxFrame = 64 * 1024;
    sock.on("data", (chunk: Buffer) => {
      try {
        this.reader.push(chunk);
      } catch (e) {
        log(`dropping a client: ${e instanceof Error ? e.message : e}`);
        sock.destroy(); // garbage on the socket (bad framing): drop that client
      }
    });
    sock.on("error", () => {});
    sock.on("close", () => {
      this.closed = true;
      // Frames waiting on this terminal will never be acknowledged: release them.
      const pending = [...this.acks.values()];
      this.acks.clear();
      for (const done of pending) done();
      onClose(this);
    });
  }

  send(msg: unknown): void {
    if (!this.closed) this.sock.write(jsonFrame(msg));
  }

  output(data: string, done?: () => void): void {
    if (this.closed) {
      done?.();
      return;
    }
    let seq = 0;
    if (done) {
      seq = this.seq = (this.seq % 0xffffffff) + 1;
      this.acks.set(seq, done);
    }
    this.sock.write(outputFrame(data, seq));
  }

  /** Lets go of every frame waiting for this client's acknowledgement. */
  releaseAcks(): void {
    const pending = [...this.acks.values()];
    this.acks.clear();
    for (const done of pending) done();
  }

  ack(seq: number): void {
    const done = this.acks.get(seq);
    if (!done) return;
    this.acks.delete(seq);
    done();
  }

  /** Sends a last message and closes, giving it a moment to go out. */
  end(msg: unknown): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.sock.destroy();
        resolve();
      }, 1000);
      this.sock.end(jsonFrame(msg), () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

export async function runServer(name: string, args: LaunchOptions, version: string): Promise<void> {
  const dataDir = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "termium");
  const logDir = stateDir();
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, "termium.log");
  for (const n of ["termium.log", "browser.log"]) rotate(join(logDir, n));
  const log = (msg: string) => {
    try {
      appendFileSync(logPath, `${new Date().toISOString()} [${name}:${process.pid}] ${msg}\n`);
    } catch {}
  };

  let paths: ReturnType<typeof sessionPaths>;
  try {
    paths = sessionPaths(name);
  } catch (e: any) {
    die(e?.message ?? String(e));
  }
  // One server per session name, for its whole life. A second one started
  // at the same moment loses here, before it has touched anything; its
  // client then attaches to the winner.
  const holder = lockFile(paths.lock);
  if (holder !== null) die(`session "${name}" is already running${holder === "failed" ? "" : ` (pid ${holder})`}`, 3);
  let listening = false;
  process.on("exit", () => {
    // Last of all: whatever we leave, no other server can be using it.
    if (listening) rmSync(paths.sock, { force: true });
    if ((readPidSafe(paths.pid) ?? process.pid) === process.pid) rmSync(paths.pid, { force: true });
    unlockFile(paths.lock);
  });
  if (await dial(paths.sock).then((s) => (s?.destroy(), !!s)).catch(() => true)) {
    // An older termium (without the lock) serving this name.
    die(`session "${name}" is already running`, 3);
  }
  writeFileSync(paths.pid, `${process.pid}\n`, { mode: 0o600 });
  // Restarted (into an updated termium): what the session had open.
  // (Removed once it's reopened: a restart that fails before then keeps it for the next try.)
  let restore = readRestore(name);
  // Started with other launch options than the snapshot's (another profile,
  // say): it isn't reopened under them, nor removed; the user is told.
  const conflict = restore ? restoreConflict(restore, args) : null;
  if (restore && conflict) {
    log(`keeping the restart snapshot: ${conflict}`);
    restore = null;
  }
  if (restore) log(`restoring ${restore.layout.spaces.length} space(s) saved by termium ${restore.from}`);

  await sweepTemp();
  let profile: string;
  try {
    const chosen = args.incognito
      ? mkdtempSync(join(tempBase(), `termium-incognito-${process.pid}-`))
      : (args.profile ?? defaultProfile(dataDir, name));
    mkdirSync(chosen, { recursive: true });
    // One spelling per directory, so locks and leftover-browser records match
    // however the path was typed (relative, symlinked, trailing slash).
    profile = realpathSync(chosen);
    lockProfile(profile);
  } catch (e: any) {
    die(/in use|can't lock/.test(e?.message ?? "") ? e.message : `can't use that profile directory: ${e?.message ?? e}`);
  }

  let bin: string;
  try {
    bin = findBrowser(args.browser);
  } catch (e: any) {
    unlockProfile(profile);
    if (args.incognito) rmSync(profile, { recursive: true, force: true });
    die(e?.message ?? String(e));
  }

  // The browser's temp files (it makes a few per run) go here and are removed on exit.
  const browserTmp = mkdtempSync(join(tempBase(), `tmb-${process.pid}-`));
  let browser: LaunchedBrowser | null = null;
  let cdp: CDP | null = null;
  let app: App | null = null;
  let client: Conn | null = null;
  let everAttached = false;
  let shuttingDown = false;
  const pending: InputEvent[] = [];
  const server = createServer();

  const launching = (async () => {
    const reaped = await reapOrphans(profile);
    if (reaped) log(`stopped ${reaped} leftover browser process(es) on ${profile}`);
    return launchBrowser(bin, profile, join(logDir, "browser.log"), browserTmp);
  })();
  launching.catch(() => {}); // handled where it's awaited

  const removeSocket = () => {
    server.close();
    // Ours: we hold the session's lock. (The lock itself goes on exit.)
    if (listening) rmSync(paths.sock, { force: true });
    listening = false;
    rmSync(paths.pid, { force: true });
  };

  const shutdown = async (code: number, err?: unknown, requester?: Conn, reason?: "restart", extra?: object) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (app) app.closingAll = true;
    if (err) log(`fatal: ${err instanceof Error ? err.stack : String(err)}`);
    // The client can give the terminal back now; it exits once we're done.
    client?.send({ t: "quitting" });
    setSink(null);
    // New clients can't attach to a session that's going away.
    removeSocket();
    if (!browser) {
      // Still starting: wait for it so it can be stopped.
      browser = await Promise.race([launching.catch(() => null), Bun.sleep(5000).then(() => null)]);
      cdp = browser?.cdp ?? null;
    }
    if (cdp) {
      await Promise.race([cdp.send("Browser.close").catch(() => {}), Bun.sleep(1500)]);
      cdp.close();
      // Let the browser finish exiting on its own (it removes its profile
      // lock as it goes) before anything gets killed.
      if (browser) await Promise.race([browser.proc.exited, Bun.sleep(3000)]);
    }
    if (browser && browser.proc.exitCode === null) {
      browser.proc.kill();
      await Promise.race([browser.proc.exited, Bun.sleep(1500)]);
      if (browser.proc.exitCode === null) browser.proc.kill(9);
    }
    if (browser) {
      // The launcher may be a wrapper script; make sure the browser itself is gone.
      const pid = browser.browserPid;
      for (let i = 0; i < 30 && isRunning(pid); i++) await Bun.sleep(50);
      if (isRunning(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }
    // Only now that the browser is gone: a kill before this point leaves
    // the record for the next start to act on.
    clearOwner(profile);
    unlockProfile(profile);
    if (args.incognito) rmSync(profile, { recursive: true, force: true });
    rmSync(browserTmp, { recursive: true, force: true });
    const bye = { t: "bye", reason: err ? "error" : (reason ?? "exited"), code, message: err ? (err instanceof Error ? err.message : String(err)) : undefined, ...extra };
    await Promise.all([client?.end(bye), requester && requester !== client ? requester.end(bye) : undefined]);
    process.exit(code);
  };

  process.on("SIGTERM", () => void shutdown(0));
  process.on("SIGINT", () => void shutdown(130));
  // Started from a terminal that may close: that must not end the session.
  process.on("SIGHUP", () => log("ignoring SIGHUP"));
  process.on("uncaughtException", (e) => void shutdown(1, e));
  process.on("unhandledRejection", (e) => log(`unhandled rejection: ${e instanceof Error ? e.stack : e}`));

  const detachClient = (reason: "detached" | "takeover") => {
    const c = client;
    if (!c) return;
    client = null;
    stopCheck();
    setSink(null);
    c.releaseAcks();
    app?.detach();
    void c.end({ t: "bye", reason });
    log(`client ${reason}`);
  };

  /** Creates the app for the first client: the browser must be up, and the terminal's size known. */
  let starting: Promise<void> | null = null;
  const startApp = (h: Hello) =>
    (starting ??= (async () => {
      try {
        browser = await launching;
      } catch (e) {
        await shutdown(1, e);
        return;
      }
      cdp = browser.cdp;
      if (process.env.TERMIUM_DEBUG) cdp.trace = (dir, msg) => log(`${dir} ${msg}`);
      cdp.onClose = () => {
        if (!shuttingDown) void shutdown(1, new Error(`the browser went away (see ${join(logDir, "browser.log")})`));
      };
      app = new App(cdp, {
        scale: args.scale,
        search: args.search,
        downloadDir: downloadDir(),
        downloadStaging: join(profile, "termium-downloads"),
        quit: () => void shutdown(0),
        detach: () => detachClient("detached"),
        log,
        version,
        update: {
          blocker: () => selfUpdateBlocker(),
          start: (tag) => void runSelfUpdate(tag),
          skip: async (tag) => {
            // Never offered again in this session either way; saved for later ones once the cache is free.
            const saved = await skipVersion(cacheFile, tag);
            if (!saved) log("update: the cache stayed busy; the skipped version holds for this session only");
            return saved;
          },
          restart: () => void restartSession(),
        },
      });
      // Whoever is attached by now (a takeover may have happened meanwhile).
      app.setUpdatesShown((lastHello ?? h).updateCheck === true);
      app.attach(terminalOf(lastHello ?? h));
      if (!client) app.detach();
      log(`start ${bin} dsf=${app.dsf}`);
      for (const ev of pending.splice(0)) app.handle(ev); // buffered by the app until ready
      try {
        const notice = restore
          ? restore.from !== version
            ? `Restarted: termium ${restore.from} → ${version}`
            : `Restarted: termium ${version}`
          : undefined;
        const reopened = await app.start(args.url, restore?.layout, notice);
        // Removed only once everything in it reopened; otherwise kept, and the user told.
        if (reopened === "all") rmSync(restorePath(name), { force: true });
        else if (reopened === "some") {
          app.showToast("Not all pages reopened; the restart snapshot is kept", 10_000);
        }
        if (conflict) {
          app.showToast(
            `Snapshot kept (${conflict}); start it that way within 10 minutes to reopen its spaces and tabs`,
            10_000,
          );
        }
      } catch (e) {
        await shutdown(1, e);
        return;
      }
      appReady = true;
      app.flushEarlyInput();
      for (const url of pendingUrls.splice(0)) app.openTab(url);
      // The UI is up: now look for a newer termium (never before, never in the way).
      if (client && lastHello) updatesOnAttach(lastHello);
    })());

  // ------------------------------------------------------------ updates
  //
  // The session owns the update check, its cache and the update box, so
  // they happen once however many times terminals attach: the check runs
  // when an interactive terminal attaches (and the UI is up), at most once
  // a day while one stays attached, never while detached; each offer is
  // made once in a session's life.
  const cacheFile = cachePath(logDir);
  let wantsUpdates = false;
  let checking: AbortController | null = null;
  let lastCheck = 0;
  let updating = false;
  /** The version a self-update installed (this session runs the old one until it restarts). */
  let installed: string | null = null;
  /** The binary that update replaced (this server's own, symlinks resolved): what a restart runs. */
  let installedExe: string | null = null;
  /** A newer termium a terminal attached with (how to run it), checked to report its version. */
  let newerFrom: { version: string; argv: string[] } | null = null;

  const runCheck = async () => {
    if (checking || !client || !wantsUpdates || !appReady || shuttingDown) return;
    if (lastCheck && Date.now() - lastCheck < MAX_AGE_MS) return;
    const stop = (checking = new AbortController());
    lastCheck = Date.now();
    let again = false;
    try {
      const r = await checkAndCache(cacheFile, version, stop.signal);
      if (stop.signal.aborted) {
        // The terminal went away first: nothing recorded, and the next attach checks again.
        lastCheck = 0;
        again = true;
        log("update check: stopped (the terminal went away)");
        return;
      }
      if (!r.ok) {
        log(`update check: ${r.error}`);
        return;
      }
      if (client && wantsUpdates) {
        app?.latestRelease(r.tag);
        app?.updateSkipped(loadCache(cacheFile)?.skipped);
      }
      if (isNewer(r.tag, version) && client && wantsUpdates) {
        log(`update check: termium ${displayVersion(r.tag)} is available`);
        app?.updateAvailable(r.tag, loadCache(cacheFile)?.skipped !== r.tag);
      }
    } finally {
      if (checking === stop) checking = null;
      // Taken over meanwhile by a terminal that wants it: check for that one.
      if (again && client && wantsUpdates) void runCheck();
    }
  };
  /** The terminal it was for went away (detached, taken over): a check under way stops. */
  const stopCheck = () => checking?.abort();
  setInterval(() => void runCheck(), 60 * 60 * 1000).unref?.();

  /** A terminal attached (and the UI is up): what's known at once, then a check if one is due. */
  const updatesOnAttach = (h: Hello) => {
    if (!app) return;
    wantsUpdates = h.updateCheck === true;
    app.setUpdatesShown(wantsUpdates);
    if (!wantsUpdates) stopCheck();
    // That terminal runs a newer termium: it's installed, and this session runs the old one.
    // (Offered only once that termium is found to run and report that version.)
    const argv = Array.isArray(h.argv) && h.argv.length && h.argv.every((a) => typeof a === "string") ? h.argv : null;
    // (The same version from another path replaces the one known: the latest attach's copy is the one checked last.)
    if (typeof h.version === "string" && argv && isNewer(h.version, version) && (!newerFrom || !isNewer(newerFrom.version, h.version))) {
      const v = h.version;
      void binaryVersionAsync(argv).then((got) => {
        if (got !== v) return log(`update: ${argv.join(" ")} doesn't report termium ${v} (${got ?? "doesn't run"}); no restart into it`);
        if (newerFrom && isNewer(newerFrom.version, v)) return;
        newerFrom = { version: v, argv };
        app?.newerInstalled(v);
      });
    }
    if (installed) app.newerInstalled(installed);
    if (!wantsUpdates) return;
    const c = loadCache(cacheFile);
    // Skipped since (in another session, say), or no longer the latest: withdrawn here too.
    if (c?.latest) app.latestRelease(c.latest);
    app.updateSkipped(c?.skipped);
    const tag = cachedNewer(c, version);
    if (tag) app.updateAvailable(tag, c?.skipped !== tag);
    void runCheck();
  };

  const runSelfUpdate = async (tag: string) => {
    if (updating) return;
    updating = true;
    log(`updating to ${tag}`);
    try {
      const exe = currentExe();
      installed = await selfUpdate(tag, version, (step) => app?.updateStep(step));
      installedExe = exe;
      log(`updated: termium ${installed} is installed`);
      app?.updateDone(tag, installed, null, exe);
    } catch (e: any) {
      log(`update to ${tag} failed: ${e?.message ?? e}`);
      app?.updateDone(tag, null, e?.message ?? String(e));
    } finally {
      updating = false;
    }
  };

  /**
   * Restarts the session into the termium now on disk: its layout and
   * launch options are left for the next server (see writeRestore), the
   * browser is closed, and the attached client starts that server.
   */
  let restarting = false;
  const restartSession = async () => {
    if (!app || shuttingDown || !client || restarting) return;
    // The termium to restart into: the newest known to be installed (the
    // binary this session's update replaced, or the one a newer terminal
    // runs), checked again now to still run and be that version.
    // Newest first; one that's gone (or another version now) is forgotten and the next tried.
    type Known = { version: string; argv: string[]; self: boolean };
    const known = [
      installed && installedExe ? { version: installed, argv: [installedExe], self: true } : null,
      newerFrom ? { ...newerFrom, self: false } : null,
    ].filter((c): c is Known => !!c);
    known.sort((a, b) => (isNewer(a.version, b.version) ? -1 : isNewer(b.version, a.version) ? 1 : 0));
    let target: Known | undefined;
    let gone: Known | undefined;
    restarting = true;
    for (const k of known) {
      const got = await binaryVersionAsync(k.argv);
      if (got === k.version) {
        target = k;
        break;
      }
      log(`restart: ${k.argv.join(" ")} is ${got ? `termium ${got}` : "gone"}, not termium ${k.version}`);
      if (k.self) installed = installedExe = null;
      else newerFrom = null;
      gone ??= k;
    }
    restarting = false;
    if (!target && gone) {
      app?.clearInstalled();
      app?.showToast(`Can't restart: termium ${gone.version} isn't at ${gone.argv.join(" ")} any more`, 8000);
      return;
    }
    if (!app || shuttingDown || !client) return;
    const r: Restore = {
      v: 1,
      at: Date.now(),
      from: version,
      launch: savedLaunch(args),
      layout: app.layoutSnapshot(),
    };
    try {
      writeRestore(name, r);
    } catch (e: any) {
      app.showToast(`Can't restart: ${e?.message ?? e}`, 5000);
      return;
    }
    log(`restarting into the updated termium${target ? ` (${target.argv.join(" ")}, ${target.version})` : ""}`);
    void shutdown(0, undefined, undefined, "restart", target ? { argv: target.argv, version: target.version } : {});
  };

  let lastHello: Hello | null = null;
  let appReady = false;
  const pendingUrls: string[] = [];

  const onMessage = (c: Conn, msg: any) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.t === "hello") {
      const h = msg as Hello;
      if (h.v !== PROTOCOL) {
        void c.end({
          t: "bye",
          reason: "error",
          code: 1,
          message: `session "${name}" runs termium ${version}, which can't talk to this termium${h.version ? ` (${h.version})` : ""}.`,
          version,
          protocol: PROTOCOL,
        });
        return;
      }
      if (h.kind === "info") {
        void c.end({
          t: "info",
          name,
          pid: process.pid,
          version,
          attached: !!client,
          // Saves its layout and restarts into an updated termium itself (termium 0.3.0 on).
          restarts: true,
          pages: app?.pages.size ?? 0,
          profile: args.incognito ? "(incognito)" : profile,
        });
        return;
      }
      if (h.kind === "abandon") {
        // The client that started us can't use its terminal. End the
        // session only if nobody else ever attached; otherwise just let go.
        if (h.starter !== process.pid || everAttached || client) {
          void c.end({ t: "bye", reason: "exited", code: 0 });
          return;
        }
        log("abandoned by the client that started it");
        c.send({ t: "killing" });
        void shutdown(0, undefined, c);
        return;
      }
      if (h.kind === "kill") {
        log("killed by request");
        c.send({ t: "killing" });
        void shutdown(0, undefined, c);
        return;
      }
      if (shuttingDown) {
        void c.end({ t: "bye", reason: "exited", code: 0 });
        return;
      }
      if (client && client !== c) {
        // The newest attach wins; the other terminal gets its shell back.
        const old = client;
        client = null;
        // Frames it never acknowledged (stuck, or just slow) mustn't hold
        // the new terminal's screencast up.
        old.releaseAcks();
        void old.end({ t: "bye", reason: "takeover" });
        log("client taken over by a new attach");
        stopCheck();
      }
      // Input the previous terminal had queued (typed before the browser was
      // ready, say) isn't this terminal's: it would act on it.
      pending.length = 0;
      app?.dropQueuedInput();
      client = c;
      everAttached = true;
      lastHello = h;
      c.send({ t: "welcome", pid: process.pid, version });
      setSink((data, done) => c.output(data, done));
      log(`client attached ${h.cols}x${h.rows} cell ${h.cellW}x${h.cellH} pixelMouse=${h.pixelMouse} placeholders=${h.placeholders} via=${h.via}`);
      // Its own server (it opened the URL at start) or another one (a client
      // whose server lost the race to start this session): then open it here.
      if (h.starter === process.pid) h.url = null;
      if (!app) {
        // Until the app is up, URLs wait.
        if (h.url) pendingUrls.push(h.url);
        void startApp(h);
      } else {
        // Whether this terminal shows update news is settled before anything is drawn for it.
        app.setUpdatesShown(h.updateCheck === true);
        app.attach(terminalOf(h));
        if (h.url) {
          if (appReady) app.openTab(h.url);
          else pendingUrls.push(h.url);
        }
        if (appReady) updatesOnAttach(h);
      }
      return;
    }
    if (c !== client) return; // a client that was taken over: ignore what it still sends
    switch (msg.t) {
      case "input":
        if (app) app.handle(msg.ev as InputEvent);
        else pending.push(msg.ev as InputEvent);
        return;
      case "ack":
        c.ack(Number(msg.seq));
        return;
      case "resize": {
        const g = terminalOf(msg);
        if (lastHello) Object.assign(lastHello, { cols: g.cols, rows: g.rows, cellW: g.cellW, cellH: g.cellH });
        app?.setGeometry(g.cols, g.rows, g.cellW, g.cellH);
        return;
      }
      case "detach":
        detachClient("detached");
        return;
      case "repaint":
        app?.repaintVisible();
        return;
      case "ping":
        c.send({ t: "pong" });
        return;
    }
  };

  const onClose = (c: Conn) => {
    if (c !== client) return;
    stopCheck();
    // The terminal went away (closed, killed, or the client detached).
    client = null;
    setSink(null);
    app?.detach();
    log("client disconnected");
  };

  server.on("connection", (sock) => new Conn(sock, onMessage, onClose, log));
  server.on("error", (e) => void shutdown(1, e));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // We hold the session's lock: a socket file here is a dead server's.
    rmSync(paths.sock, { force: true });
    server.listen(paths.sock, () => {
      server.off("error", reject);
      listening = true;
      resolve();
    });
  }).catch((e) => {
    unlockProfile(profile);
    rmSync(browserTmp, { recursive: true, force: true });
    if (args.incognito) rmSync(profile, { recursive: true, force: true });
    die(`can't listen on ${paths.sock}: ${e?.message ?? e}`);
  });
  chmodSync(paths.sock, 0o600);
  log(`session "${name}" listening on ${paths.sock}`);

  // Started by a client that went away before attaching (or couldn't use
  // its terminal): don't linger with nobody ever attached.
  setTimeout(() => {
    if (!everAttached && !shuttingDown) void shutdown(1, new Error("no terminal attached"));
  }, 30_000).unref?.();
}

function readPidSafe(path: string): number | null {
  try {
    const n = Number(readFileSync(path, "utf8").trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** Largest terminal drawn for, in device pixels each way: beyond it, pictures stall the terminal. */
const MAX_PIXELS = 16384;

function terminalOf(h: Partial<Hello>) {
  const num = (v: unknown, dflt: number, max: number) => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n >= 1 ? Math.min(n, max) : dflt;
  };
  const cellW = num(h.cellW, 10, 256);
  const cellH = num(h.cellH, 20, 256);
  return {
    cols: num(h.cols, 80, Math.max(1, Math.floor(MAX_PIXELS / cellW))),
    rows: num(h.rows, 24, Math.max(1, Math.floor(MAX_PIXELS / cellH))),
    cellW,
    cellH,
    pixelMouse: !!h.pixelMouse,
    placeholders: !!h.placeholders,
    rgbIds: !!h.rgbIds,
    cwd: typeof h.cwd === "string" && h.cwd.startsWith("/") ? h.cwd : undefined,
  };
}
