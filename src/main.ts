#!/usr/bin/env bun
// termium: a Chromium (Helium) browser in your terminal.
//
// `termium` is a client that attaches the terminal to a session: a
// background server process owning the browser (src/server.ts). It starts
// the session first if it isn't running.

import { resolve } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { killSession, listSessions, runClient } from "./client";
import { runServer, type LaunchOptions } from "./server";
import { DEFAULT_SESSION, validSessionName } from "./session";
import { restoreTerminal } from "./terminal";
import { DEFAULT_SEARCH } from "./text";

const VERSION: string = pkg.version;

const HELP = `termium ${VERSION}: a Chromium (Helium) browser in your terminal

Usage:
  termium [options] [url]      attach to the session, starting it if needed
                               (a url opens in a new tab of a running session)
  termium attach [name]        attach to a running session
  termium ls                   list sessions
  termium kill [name]          end a session (stops its browser)

Options:
  -s, --session <name>  session to use (default: "${DEFAULT_SESSION}")
  --browser <path>      Helium/Chromium binary (default: helium-browser on PATH, or $TERMIUM_BROWSER)
  --profile <dir>       browser profile directory (default: $XDG_DATA_HOME/termium/profile,
                        or $XDG_DATA_HOME/termium/profiles/NAME for -s NAME)
  --incognito           use a throwaway profile that is deleted when the session ends
  --scale <n>           device pixels per CSS pixel (default: follows the terminal's cell size)
  --search <url>        search URL with %s for the query (default: DuckDuckGo, or $TERMIUM_SEARCH)
  -h, --help            show this help
  -V, --version         show the version

--browser, --profile, --incognito, --scale and --search apply when a session starts.
Ctrl+B d detaches (the browser keeps running); Ctrl+Q ends the session.
Needs a terminal with the kitty graphics protocol, such as Ghostty, kitty or WezTerm
(inside tmux: set -g allow-passthrough on). Press Ctrl+B then ? inside termium for keys.`;

type Command = "open" | "attach" | "ls" | "kill" | "server";

interface Args extends LaunchOptions {
  command: Command;
  session: string;
  /** The launch options given, by flag, for the "already running" message. */
  launchFlags: string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: "open",
    session: DEFAULT_SESSION,
    launchFlags: [],
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
        console.log(`termium ${VERSION}`);
        process.exit(0);
      case "-s":
      case "--session":
        args.session = value();
        sessionGiven = true;
        break;
      case "--browser": args.browser = value(); flag("--browser"); break;
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
        if (args.url) fail("only one URL may be given");
        args.url = a;
    }
  }
  if (!validSessionName(args.session)) fail(`bad session name "${args.session}" (letters, digits, . _ -; up to 64)`);
  if (!searchFromFlag && !args.search.includes("%s")) fail("TERMIUM_SEARCH needs a %s placeholder");
  if (args.incognito && args.profile) fail("--incognito and --profile can't be used together");
  if ((args.command === "attach" || args.command === "kill" || args.command === "ls") && args.launchFlags.length) {
    fail(`${args.launchFlags.join(", ")} only apply when starting a session`);
  }
  return args;
}

function fail(msg: string): never {
  console.error(`termium: ${msg}`);
  process.exit(2);
}

/** How to start this same termium as a session server. */
function serverArgv(a: Args): string[] {
  // Compiled, Bun.main is inside the binary's virtual filesystem; from
  // source it's the script to run with bun.
  const argv = [process.execPath, ...(Bun.main.startsWith("/$bunfs") || Bun.main.startsWith("B:/~BUN") ? [] : [Bun.main])];
  argv.push("__server", "--session", a.session);
  if (a.browser) argv.push("--browser", a.browser);
  if (a.profile) argv.push("--profile", a.profile);
  if (a.incognito) argv.push("--incognito");
  if (a.scale !== null) argv.push("--scale", String(a.scale));
  if (a.search !== (process.env.TERMIUM_SEARCH || DEFAULT_SEARCH)) argv.push("--search", a.search);
  if (a.url) argv.push(a.url);
  return argv;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case "ls":
      return listSessions();
    case "kill":
      return killSession(args.session);
    case "server":
      return runServer(args.session, args, VERSION);
    case "open":
    case "attach":
      return runClient({
        name: args.session,
        mode: args.command === "attach" ? "attach" : "auto",
        url: args.url,
        launchFlags: args.launchFlags,
        serverArgv: serverArgv(args),
        version: VERSION,
      });
  }
}

main().catch((e) => {
  restoreTerminal();
  console.error(`termium: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
