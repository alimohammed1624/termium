#!/usr/bin/env bun
// termium: a Chromium (Helium) browser in your terminal.

import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { App } from "./app";
import { clearOwner, findBrowser, launchBrowser, reapOrphans, writeOwner, type LaunchedBrowser } from "./browser";
import { CDP } from "./cdp";
import { InputParser, type InputEvent } from "./input";
import { DEFAULT_SEARCH } from "./text";
import { drained, enterTerminal, queryCapabilities, querySizes, restoreTerminal } from "./terminal";

const VERSION: string = pkg.version;

const HELP = `termium ${VERSION}: a Chromium (Helium) browser in your terminal

Usage: termium [options] [url]

Options:
  --browser <path>   Helium/Chromium binary (default: helium-browser on PATH, or $TERMIUM_BROWSER)
  --profile <dir>    browser profile directory (default: $XDG_DATA_HOME/termium/profile)
  --incognito        use a throwaway profile that is deleted on exit
  --scale <n>        device pixels per CSS pixel (default: follows the terminal's cell size)
  --search <url>     search URL with %s for the query (default: DuckDuckGo, or $TERMIUM_SEARCH)
  -h, --help         show this help
  -V, --version      show the version

Needs a terminal with the kitty graphics protocol, such as Ghostty, kitty or WezTerm.
Press Ctrl+B then ? inside termium for keys.`;

interface Args {
  url: string | null;
  browser?: string;
  profile?: string;
  incognito: boolean;
  scale: number | null;
  search: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    url: null,
    incognito: false,
    scale: null,
    search: process.env.TERMIUM_SEARCH || DEFAULT_SEARCH,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (v === undefined) fail(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case "-h":
      case "--help":
        console.log(HELP);
        process.exit(0);
      case "-V":
      case "--version":
        console.log(`termium ${VERSION}`);
        process.exit(0);
      case "--browser": args.browser = value(); break;
      case "--profile": args.profile = value(); break;
      case "--incognito": args.incognito = true; break;
      case "--search": {
        args.search = value();
        if (!args.search.includes("%s")) fail("--search needs a %s placeholder");
        break;
      }
      case "--scale": {
        const n = Number(value());
        if (!Number.isFinite(n) || n < 0.25 || n > 8) fail("--scale must be a number from 0.25 to 8");
        args.scale = n;
        break;
      }
      default:
        if (a.startsWith("-")) fail(`unknown option ${a} (see --help)`);
        if (args.url) fail("only one URL may be given");
        args.url = a;
    }
  }
  return args;
}

/**
 * Where per-run temp dirs go. Chromium puts a Unix socket a few levels
 * below TMPDIR, and socket paths are limited to ~107 bytes, so a long TMPDIR
 * falls back to /tmp.
 */
function tempBase(): string {
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
    } catch {}
    const dir = join(base, name);
    if (m[1] === "termium-incognito") await reapOrphans(dir).catch(() => 0);
    rmSync(dir, { recursive: true, force: true });
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

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function fail(msg: string): never {
  console.error(`termium: ${msg}`);
  process.exit(2);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!process.stdin.isTTY || !process.stdout.isTTY) fail("needs an interactive terminal");

  const dataDir = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "termium");
  const stateDir = join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "termium");
  mkdirSync(stateDir, { recursive: true });
  const logPath = join(stateDir, "termium.log");
  const log = (msg: string) => {
    try {
      appendFileSync(logPath, `${new Date().toISOString()} ${msg}\n`);
    } catch {}
  };

  // Raw mode first: switching modes discards anything typed before it.
  const caps = {
    graphics: false,
    pixelMouse: false,
    kittyFlags: -1,
    cell: null as { width: number; height: number } | null,
    area: null as { width: number; height: number } | null,
  };
  let onCapsDone: (() => void) | null = null;
  let onSizes: (() => void) | null = null;
  let app: App | null = null;
  const pending: InputEvent[] = [];

  const parser = new InputParser((ev) => {
    switch (ev.type) {
      case "kittyGraphics":
        if (ev.id === 31) caps.graphics = ev.message === "OK";
        return;
      case "kittyKeyboard":
        caps.kittyFlags = ev.flags;
        parser.kittyActive = (ev.flags & 2) !== 0;
        return;
      case "modeReport":
        if (ev.mode === 1016) caps.pixelMouse = ev.value === 1 || ev.value === 2;
        return;
      case "cellSize":
        caps.cell = { width: ev.width, height: ev.height };
        return;
      case "textAreaSize":
        caps.area = { width: ev.width, height: ev.height };
        return;
      case "deviceAttributes":
        onCapsDone?.();
        onSizes?.();
        return;
    }
    if (app) app.handle(ev);
    else pending.push(ev);
  });

  process.stdin.setRawMode(true);
  const decoder = new TextDecoder();
  process.stdin.on("data", (chunk: Buffer) => {
    try {
      parser.feed(decoder.decode(chunk, { stream: true }));
    } catch (e) {
      // Garbage input must never take the browser down with it.
      log(`input: ${e instanceof Error ? e.stack : e}`);
    }
  });
  process.stdin.resume();
  enterTerminal();
  queryCapabilities();

  await sweepTemp();
  const profile = args.incognito
    ? mkdtempSync(join(tempBase(), `termium-incognito-${process.pid}-`))
    : (args.profile ?? join(dataDir, "profile"));
  mkdirSync(profile, { recursive: true });

  // The browser's temp files (it makes a few per run) go here and are removed on exit.
  const browserTmp = mkdtempSync(join(tempBase(), `tmb-${process.pid}-`));
  let browser: LaunchedBrowser | null = null;
  let launching: Promise<{ bin: string; b: LaunchedBrowser }> | null = null;
  let cdp: CDP | null = null;
  let shuttingDown = false;
  const shutdown = async (code: number, err?: unknown) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (app) app.closingAll = true;
    await Promise.race([drained(), Bun.sleep(500)]);
    restoreTerminal();
    try {
      process.stdin.setRawMode(false);
    } catch {}
    if (!browser && launching) {
      // Still starting (e.g. we're refusing the terminal): wait for it so it can be stopped.
      const late = await Promise.race([launching.catch(() => null), Bun.sleep(5000).then(() => null)]);
      if (late) browser = late.b;
    }
    if (cdp) {
      await Promise.race([cdp.send("Browser.close").catch(() => {}), Bun.sleep(1500)]);
      cdp.close();
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
      clearOwner(profile);
    }
    if (args.incognito) rmSync(profile, { recursive: true, force: true });
    rmSync(browserTmp, { recursive: true, force: true });
    if (err) {
      log(`fatal: ${err instanceof Error ? err.stack : String(err)}`);
      console.error(`termium: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(code);
  };
  process.on("SIGTERM", () => void shutdown(0));
  process.on("SIGHUP", () => void shutdown(0));
  process.on("SIGINT", () => void shutdown(130));
  process.on("uncaughtException", (e) => void shutdown(1, e));
  process.on("unhandledRejection", (e) => log(`unhandled rejection: ${e instanceof Error ? e.stack : e}`));

  // Launch the browser while the terminal answers our capability queries.
  launching = (async () => {
    const bin = findBrowser(args.browser);
    const reaped = await reapOrphans(profile);
    if (reaped) log(`stopped ${reaped} leftover browser process(es) on ${profile}`);
    const b = await launchBrowser(bin, profile, join(stateDir, "browser.log"), browserTmp);
    return { bin, b };
  })();
  launching.catch(() => {}); // handled below; avoid an unhandled rejection meanwhile
  await Promise.race([new Promise<void>((r) => (onCapsDone = r)), Bun.sleep(1500)]);
  onCapsDone = null;

  if (!caps.graphics) {
    await shutdown(
      1,
      new Error("this terminal does not support the kitty graphics protocol. Use Ghostty, kitty or WezTerm."),
    );
    return;
  }

  let bin: string;
  try {
    const launched = await launching;
    bin = launched.bin;
    browser = launched.b;
    writeOwner(profile, [browser.browserPid, browser.proc.pid]);
    cdp = CDP.fromPipe(browser.toBrowser, browser.fromBrowser);
    await Promise.race([
      cdp.send("Browser.getVersion"),
      Bun.sleep(15_000).then(() => {
        throw new Error("the browser did not answer on its DevTools pipe");
      }),
    ]);
  } catch (e) {
    await shutdown(1, e);
    return;
  }
  if (process.env.TERMIUM_DEBUG) cdp.trace = (dir, msg) => log(`${dir} ${msg}`);
  cdp.onClose = () => {
    if (!shuttingDown) void shutdown(1, new Error(`the browser went away (see ${join(stateDir, "browser.log")})`));
  };

  const geometry = () => {
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    let cellW = caps.cell?.width ?? 0;
    let cellH = caps.cell?.height ?? 0;
    if ((!cellW || !cellH) && caps.area) {
      cellW = Math.floor(caps.area.width / cols);
      cellH = Math.floor(caps.area.height / rows);
    }
    if (!cellW || !cellH) {
      cellW = 10;
      cellH = 20;
    }
    return { cols, rows, cellW, cellH };
  };

  app = new App(cdp, {
    scale: args.scale,
    search: args.search,
    downloadDir: downloadDir(),
    downloadStaging: join(profile, "termium-downloads"),
    quit: () => void shutdown(0),
    log,
  });
  app.pixelMouse = caps.pixelMouse;
  {
    const g = geometry();
    app.setGeometry(g.cols, g.rows, g.cellW, g.cellH);
  }
  log(`start ${bin} caps=${JSON.stringify(caps)} dsf=${app.dsf}`);

  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  process.stdout.on("resize", () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(async () => {
      caps.cell = null;
      caps.area = null;
      querySizes();
      await Promise.race([new Promise<void>((r) => (onSizes = r)), Bun.sleep(500)]);
      onSizes = null;
      const g = geometry();
      app!.setGeometry(g.cols, g.rows, g.cellW, g.cellH);
    }, 60);
  });

  for (const ev of pending.splice(0)) app.handle(ev); // buffered by the app until ready
  try {
    await app.start(args.url);
  } catch (e) {
    await shutdown(1, e);
    return;
  }
  app.flushEarlyInput();
}

main().catch((e) => {
  restoreTerminal();
  console.error(`termium: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});


