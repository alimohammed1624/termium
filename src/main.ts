#!/usr/bin/env bun
// termium: a Chromium (Helium) browser in your terminal.
//
// `termium` is a client that attaches the terminal to a session: a
// background server process owning the browser (src/server.ts). It starts
// the session first if it isn't running.

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { killSession, listSessions, runClient, runningSessions } from "./client";
import { runCtl, runDevtools, startSession } from "./ctl";
import { SKILL } from "./skill";
import { runServer, stateDir, type LaunchOptions } from "./server";
import { DEFAULT_SESSION, readRestore, savedLaunch, validSessionName } from "./session";
import { restoreTerminal } from "./terminal";
import { DEFAULT_SEARCH } from "./text";
import {
  UPGRADE_CMD,
  cachePath,
  checkAndCache,
  checkEnabled,
  compiledBinary,
  displayVersion,
  isNewer,
  report,
  selfUpdate,
  selfUpdateBlocker,
  stepLabel,
} from "./update";
import { VERSION } from "./version";

const HELP = `termium ${VERSION}: a Chromium (Helium) browser in your terminal

Usage:
  termium [options] [url]      attach to the session, starting it if needed
                               (a url opens in a new tab of a running session)
  termium attach [name]        attach to a running session
  termium ls                   list sessions
  termium kill [name]          end a session (stops its browser)
  termium start [options] [url]
                               start a session in the background without a terminal
                               (for agents; attach to it later with termium attach)
  termium ctl COMMAND ...      drive a session from a script or agent without attaching:
                               tabs, open, snapshot, click, type, key, text, shot, eval,
                               wait... (termium ctl --help)
  termium devtools [name]      print the session's DevTools endpoint (http://127.0.0.1:PORT;
                               --json for more) for Puppeteer, Playwright, chrome-devtools-mcp
  termium check-update         check for a newer termium release (exit 0: up to date,
                               100: one is available, 1: could not check, 2: bad usage)
  termium update               update termium to the latest release (exit 0: updated or
                               already up to date, 1: failed, 2: bad usage)

Options:
  -s, --session <name>  session to use (default: "${DEFAULT_SESSION}")
  --browser <path>      Helium/Chromium binary (default: helium-browser on PATH, or $TERMIUM_BROWSER)
  --profile <dir>       browser profile directory (default: $XDG_DATA_HOME/termium/profile,
                        or $XDG_DATA_HOME/termium/profiles/NAME for -s NAME)
  --incognito           use a throwaway profile that is deleted when the session ends
  --scale <n>           device pixels per CSS pixel (default: follows the terminal's cell size)
  --search <url>        search URL with %s for the query (default: DuckDuckGo, or $TERMIUM_SEARCH)
  --no-update-check     don't check GitHub for a newer termium, nor offer to update
                        (also TERMIUM_NO_UPDATE_CHECK=1, or a set CI variable)
  -h, --help            show this help
  -V, --version         show the version
  --skill               print a SKILL.md that teaches an agent to use termium

--browser, --profile, --incognito, --scale and --search apply when a session starts.
Ctrl+B d detaches (the browser keeps running); Ctrl+Q ends the session.
Needs a terminal with the kitty graphics protocol, such as Ghostty, kitty or WezTerm
(inside tmux: set -g allow-passthrough on). Press Ctrl+B then ? inside termium for keys.`;

type Command = "open" | "attach" | "ls" | "kill" | "server" | "check-update" | "update" | "start";

interface Args extends LaunchOptions {
  command: Command;
  session: string;
  /** The launch options given, by flag, for the "already running" message. */
  launchFlags: string[];
  noUpdateCheck: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: "open",
    session: DEFAULT_SESSION,
    launchFlags: [],
    noUpdateCheck: false,
    url: null,
    incognito: false,
    scale: null,
    search: process.env.TERMIUM_SEARCH || DEFAULT_SEARCH,
  };
  let searchFromFlag = false;
  let sessionGiven = false;
  let i = 0;
  const first = argv[0];
  if (first === "attach") args.command = "attach";
  else if (first === "ls" || first === "list") args.command = "ls";
  else if (first === "kill") args.command = "kill";
  else if (first === "__server") args.command = "server";
  else if (first === "check-update") args.command = "check-update";
  else if (first === "update") args.command = "update";
  else if (first === "start") args.command = "start";
  if (args.command !== "open") i = 1;
  const flag = (f: string) => {
    if (!args.launchFlags.includes(f)) args.launchFlags.push(f);
  };
  for (; i < argv.length; i++) {
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
        // Tests stand in for a slow machine (a new binary that takes a while to start) with this.
        if (Number(process.env.TERMIUM_TEST_VERSION_DELAY_MS) > 0) Bun.sleepSync(Number(process.env.TERMIUM_TEST_VERSION_DELAY_MS));
        console.log(`termium ${VERSION}`);
        process.exit(0);
      case "--skill":
        process.stdout.write(SKILL);
        process.exit(0);
      case "-s":
      case "--session":
        args.session = value();
        sessionGiven = true;
        break;
      case "--no-update-check": args.noUpdateCheck = true; break;
      // Older termiums (0.3.0 pre-releases) restarted with --restore; a
      // restart snapshot is reopened whenever one is waiting, so it means nothing now.
      case "--restore": break;
      case "--browser": {
        // A path (not a name looked up on PATH) is made absolute: the session
        // may restart from another directory.
        const b = value();
        // A name is looked up on this shell's PATH now (a restart may come from a shell without it).
        args.browser = b.includes("/") ? resolve(b) : (Bun.which(b) ?? b);
        flag("--browser");
        break;
      }
      case "--profile": args.profile = resolve(value()); flag("--profile"); break;
      case "--incognito": args.incognito = true; flag("--incognito"); break;
      case "--search": {
        args.search = value();
        if (!args.search.includes("%s")) fail("--search needs a %s placeholder");
        searchFromFlag = true;
        flag("--search");
        break;
      }
      case "--scale": {
        const n = Number(value());
        if (!Number.isFinite(n) || n < 0.25 || n > 8) fail("--scale must be a number from 0.25 to 8");
        args.scale = n;
        flag("--scale");
        break;
      }
      default:
        if (a.startsWith("-")) fail(`unknown option ${a} (see --help)`);
        if (args.command === "attach" || args.command === "kill") {
          if (sessionGiven) fail(`only one session name may be given`);
          args.session = a;
          sessionGiven = true;
          break;
        }
        if (args.command === "ls") fail(`ls takes no arguments`);
        if (args.command === "check-update" || args.command === "update") fail(`${args.command} takes no arguments`);
        if (args.url) fail("only one URL may be given");
        args.url = a;
    }
  }
  if (!validSessionName(args.session)) fail(`bad session name "${args.session}" (letters, digits, . _ -; up to 64)`);
  if (!searchFromFlag && !args.search.includes("%s")) fail("TERMIUM_SEARCH needs a %s placeholder");
  if (args.incognito && args.profile) fail("--incognito and --profile can't be used together");
  if (args.command !== "open" && args.command !== "server" && args.command !== "start" && args.launchFlags.length) {
    fail(`${args.launchFlags.join(", ")} only apply when starting a session`);
  }
  return args;
}

function fail(msg: string): never {
  console.error(`termium: ${msg}`);
  process.exit(2);
}

/** How to run this termium again: the binary, or bun and the script when run from source. */
function selfArgv(): string[] {
  // Compiled, Bun.main is inside the binary's virtual filesystem; from
  // source it's the script to run with bun. The binary's real path, so a
  // restart after an update runs the new one wherever a symlink points.
  if (!compiledBinary()) return [process.execPath, Bun.main];
  try {
    return [realpathSync(process.execPath)];
  } catch {
    return [process.execPath];
  }
}

/** How to start this same termium as a session server. */
function serverArgv(a: Args): string[] {
  const argv = selfArgv();
  argv.push("__server", "--session", a.session);
  if (a.browser) argv.push("--browser", a.browser);
  if (a.profile) argv.push("--profile", a.profile);
  if (a.incognito) argv.push("--incognito");
  if (a.scale !== null) argv.push("--scale", String(a.scale));
  if (a.search !== (process.env.TERMIUM_SEARCH || DEFAULT_SEARCH)) argv.push("--search", a.search);
  if (a.url) argv.push(a.url);
  return argv;
}

/** `termium check-update`: checks now (ignoring the opt-outs), refreshes the cache, prints one line. */
async function checkUpdate(): Promise<never> {
  const r = await checkAndCache(cachePath(stateDir()), VERSION);
  const { line, code } = report(r, VERSION);
  (r.ok ? console.log : console.error)(line);
  process.exit(code);
}

/** `termium update`: replaces this termium with the latest release. */
async function update(): Promise<never> {
  const r = await checkAndCache(cachePath(stateDir()), VERSION);
  if (!r.ok) {
    console.error(`termium: could not check for updates: ${r.error}`);
    console.error(`Update by hand:\n  ${UPGRADE_CMD}`);
    process.exit(1);
  }
  if (!isNewer(r.tag, VERSION)) {
    console.log(`termium ${VERSION} is up to date`);
    process.exit(0);
  }
  const next = displayVersion(r.tag);
  const blocker = selfUpdateBlocker();
  if (blocker) {
    console.error(`termium ${next} is available (you have ${VERSION}), but this termium can't update itself: ${blocker}.`);
    console.error(`Update by hand:\n  ${UPGRADE_CMD}`);
    process.exit(1);
  }
  console.log(`Updating termium ${VERSION} → ${next}`);
  let installed: string;
  const outcome: { changed?: boolean } = {};
  try {
    installed = await selfUpdate(r.tag, VERSION, (step) => console.log(`  ${stepLabel(step)}`), outcome);
  } catch (e: any) {
    console.error(`termium: update failed: ${e?.message ?? e}`);
    console.error(`Update by hand:\n  ${UPGRADE_CMD}`);
    process.exit(1);
  }
  // Another update may have got there first (with this release or a newer one).
  console.log(
    outcome.changed
      ? `Updated to termium ${next}.`
      : `termium ${installed} was already installed by another update; nothing was changed.`,
  );
  const old = (await runningSessions()).filter((s) => s.version !== installed);
  if (old.length) {
    const names = old.map((s) => s.name).join(", ");
    console.log(
      `Running session${old.length === 1 ? "" : "s"} (${names}) keep${old.length === 1 ? "s" : ""} running the old termium until restarted: ` +
        `attach (termium attach NAME) and press Ctrl+B U, then r (offered even with update checks off), which reopens its spaces and tabs; ` +
        `or end it with termium kill NAME.`,
    );
  }
  process.exit(0);
}

async function main(): Promise<void> {
  // Agents' commands have options of their own.
  const argv = process.argv.slice(2);
  if (argv[0] === "ctl") return runCtl(argv.slice(1));
  if (argv[0] === "devtools") return runDevtools(argv.slice(1));
  const args = parseArgs(argv);
  switch (args.command) {
    case "check-update":
      return checkUpdate();
    case "update":
      return update();
    case "ls":
      return listSessions();
    case "kill":
      return killSession(args.session);
    case "server":
      return runServer(args.session, args, VERSION);
    case "start": {
      // As for a plain `termium`: a restart's snapshot is reopened.
      if (!args.launchFlags.length) {
        const r = readRestore(args.session);
        if (r) Object.assign(args, savedLaunch(r.launch));
      }
      return startSession({ name: args.session, url: args.url, launchFlags: args.launchFlags, serverArgv: serverArgv(args) });
    }
    case "open":
    case "attach": {
      // A restart's snapshot waiting for this session (a restart now, or
      // one that failed to start): unless other launch options are given,
      // a session started now starts as it was before, and reopens it.
      // (Given other ones, the server keeps the snapshot and says so.)
      if (args.command === "open" && !args.launchFlags.length) {
        const r = readRestore(args.session);
        if (r) Object.assign(args, savedLaunch(r.launch));
      }
      const restartArgv = [...selfArgv(), "--session", args.session];
      if (args.noUpdateCheck) restartArgv.push("--no-update-check");
      return runClient({
        name: args.session,
        mode: args.command === "attach" ? "attach" : "auto",
        url: args.url,
        launchFlags: args.launchFlags,
        serverArgv: serverArgv(args),
        version: VERSION,
        updateCheck: checkEnabled(args.noUpdateCheck),
        restartArgv,
        selfArgv: selfArgv(),
      });
    }
  }
}

main().catch((e) => {
  restoreTerminal();
  console.error(`termium: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
