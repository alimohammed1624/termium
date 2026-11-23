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
import { join } from "node:path";
import { App } from "./app";
import { clearOwner, findBrowser, launchBrowser, lockProfile, reapOrphans, unlockProfile, type LaunchedBrowser } from "./browser";
import { CDP } from "./cdp";
import type { InputEvent } from "./input";
import { FrameReader, PROTOCOL, dial, jsonFrame, outputFrame, sessionPaths } from "./session";
import { setSink } from "./terminal";

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
  kind: "attach" | "info" | "kill";
  version?: string;
  cols?: number;
  rows?: number;
  cellW?: number;
  cellH?: number;
  pixelMouse?: boolean;
  placeholders?: boolean;
  /** Open this in a new tab (attaching to a session that's already running). */
  url?: string | null;
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
    try {
      process.kill(Number(m[2]), 0);
      continue; // that termium is still running
    } catch (e: any) {
      if (e?.code === "EPERM") continue; // alive, and someone else's
    }
    const dir = join(base, name);
    try {
      // Two termiums starting at once mustn't both clean the same leftover:
      // the first to create the marker does it, the other leaves it alone.
      if (m[1] === "termium-incognito") {
        try {
          closeSync(openSync(join(dir, ".sweeping"), "wx"));
        } catch {
          continue;
        }
        await reapOrphans(dir).catch(() => 0);
      }
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Not ours to remove (another user's); never a reason not to start.
    }
  }
}

/** $TERMIUM_DOWNLOAD_DIR, else the XDG download directory (xdg-user-dir), else ~/Downloads. */
function downloadDir(): string {
  if (process.env.TERMIUM_DOWNLOAD_DIR) return process.env.TERMIUM_DOWNLOAD_DIR;
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
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
  ) {
    this.reader = new FrameReader((f) => {
      if (f.type === 1) onMessage(this, f.msg);
    });
    sock.on("data", (chunk: Buffer) => {
      try {
        this.reader.push(chunk);
      } catch {
        sock.destroy(); // garbage on the socket: drop that client
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
  if (await dial(paths.sock).then((s) => (s?.destroy(), !!s)).catch(() => true)) {
    die(`session "${name}" is already running`, 3);
  }
  writeFileSync(paths.pid, `${process.pid}\n`);

  await sweepTemp();
  let profile: string;
  try {
    const chosen = args.incognito
      ? mkdtempSync(join(tempBase(), `termium-incognito-${process.pid}-`))
      : (args.profile ?? join(dataDir, "profile"));
    mkdirSync(chosen, { recursive: true });
    // One spelling per directory, so locks and leftover-browser records match
    // however the path was typed (relative, symlinked, trailing slash).
    profile = realpathSync(chosen);
    lockProfile(profile);
  } catch (e: any) {
    rmSync(paths.pid, { force: true });
    die(/in use|can't lock/.test(e?.message ?? "") ? e.message : `can't use that profile directory: ${e?.message ?? e}`);
  }

  let bin: string;
  try {
    bin = findBrowser(args.browser);
  } catch (e: any) {
    unlockProfile(profile);
    if (args.incognito) rmSync(profile, { recursive: true, force: true });
    rmSync(paths.pid, { force: true });
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
    // Only our own: a socket file replaced by a newer server stays.
    if ((readPidSafe(paths.pid) ?? process.pid) === process.pid) {
      rmSync(paths.sock, { force: true });
      rmSync(paths.pid, { force: true });
    }
  };

  const shutdown = async (code: number, err?: unknown, requester?: Conn) => {
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
    const bye = { t: "bye", reason: err ? "error" : "exited", code, message: err ? (err instanceof Error ? err.message : String(err)) : undefined };
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
    setSink(null);
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
      });
      // Whoever is attached by now (a takeover may have happened meanwhile).
      app.attach(terminalOf(lastHello ?? h));
      if (!client) app.detach();
      log(`start ${bin} dsf=${app.dsf}`);
      for (const ev of pending.splice(0)) app.handle(ev); // buffered by the app until ready
      try {
        await app.start(args.url);
      } catch (e) {
        await shutdown(1, e);
        return;
      }
      app.flushEarlyInput();
    })());

  let lastHello: Hello | null = null;

  const onMessage = (c: Conn, msg: any) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.t === "hello") {
      const h = msg as Hello;
      if (h.v !== PROTOCOL) {
        void c.end({
          t: "bye",
          reason: "error",
          code: 1,
          message: `session "${name}" runs termium ${version}, which can't talk to this termium${h.version ? ` (${h.version})` : ""}. Use the same version, or another session name (-s).`,
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
          pages: app?.pages.size ?? 0,
          profile: args.incognito ? "(incognito)" : profile,
        });
        return;
      }
      if (h.kind === "kill") {
        log("killed by request");
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
        void old.end({ t: "bye", reason: "takeover" });
        log("client taken over by a new attach");
      }
      client = c;
      everAttached = true;
      lastHello = h;
      setSink((data, done) => c.output(data, done));
      log(`client attached ${h.cols}x${h.rows} cell ${h.cellW}x${h.cellH} pixelMouse=${h.pixelMouse} placeholders=${h.placeholders}`);
      if (!app) {
        void startApp(h);
      } else {
        app.attach(terminalOf(h));
        if (h.url) app.newTab(h.url);
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
    }
  };

  const onClose = (c: Conn) => {
    if (c !== client) return;
    // The terminal went away (closed, killed, or the client detached).
    client = null;
    setSink(null);
    app?.detach();
    log("client disconnected");
  };

  server.on("connection", (sock) => new Conn(sock, onMessage, onClose));
  server.on("error", (e) => void shutdown(1, e));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // A socket file nobody answers on is what a dead server left behind.
    rmSync(paths.sock, { force: true });
    server.listen(paths.sock, () => {
      server.off("error", reject);
      resolve();
    });
  }).catch((e) => {
    unlockProfile(profile);
    rmSync(paths.pid, { force: true });
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

function terminalOf(h: Partial<Hello>) {
  const num = (v: unknown, dflt: number, max: number) => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n >= 1 && n <= max ? n : dflt;
  };
  return {
    cols: num(h.cols, 80, 4096),
    rows: num(h.rows, 24, 4096),
    cellW: num(h.cellW, 10, 512),
    cellH: num(h.cellH, 20, 512),
    pixelMouse: !!h.pixelMouse,
    placeholders: !!h.placeholders,
  };
}
