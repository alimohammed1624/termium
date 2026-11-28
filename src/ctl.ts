// The command line for agents: `termium ctl`, `termium devtools` and
// `termium start`. None of them needs a terminal, and none attaches: an
// agent drives a session while a person watches it in their own terminal.
// (The server side is src/agent.ts.)

import { spawn } from "node:child_process";
import { chmodSync, closeSync, constants, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EXIT, type CtlRequest } from "./agent";
import { lockHolder } from "./browser";
import { sessionInfo } from "./client";
import type { Hello } from "./server";
import { DEFAULT_SESSION, FrameReader, PROTOCOL, dial, jsonFrame, sessionPaths, sweepErrFiles, validSessionName } from "./session";

export const CTL_HELP = `Usage: termium ctl [-s NAME] [--json] [--timeout SEC] COMMAND [ARGS]

Drives a running session without attaching to it (no terminal needed); a
terminal attached to the session shows every action as it happens.

Commands (TAB is a number from \`tabs\`; the focused tab if left out.
ID is an element id from \`snapshot\`, like 3:142@2):
  tabs                          list tabs: id, title, address, space, tab, pane; * = focused
  open URL [--new-tab] [--background] [--no-wait]
                                go to URL in the focused tab (or --tab N), or in a new tab;
                                waits for it to load
  select TAB                    show that tab in the terminal and focus it
  close [TAB] [--force]         close a tab (--force: even if it asks "Leave this page?")
  mute [TAB] / unmute [TAB]     mute a tab's sound (it stays muted until unmuted)
  snapshot [TAB]                the page's accessibility tree as text, with element ids
  text [TAB]                    the page's readable text
  click ID | --xy X,Y [--double] [--right|--middle]
                                click an element (or a point, in CSS pixels)
  type ID TEXT [--append] [--submit]
                                replace a field's text (--append adds to it; --submit
                                presses Enter after); on a <select>, choose that option
  key KEY... [--tab N]          press keys: Enter, Tab, Escape, ctrl+a, shift+Tab, ArrowDown, a...
  scroll [ID] up|down|left|right [PX]
                                scroll the page (or the element's scroll area) by PX
                                (default: most of a screen)
  shot [TAB] [-o FILE] [--full] save a PNG screenshot (default: a temp file); prints its path
  eval JS [TAB]                 evaluate JavaScript in the page (promises awaited); prints JSON
  wait load | selector CSS | text TEXT | url TEXT [--gone]
                                wait until the page has loaded, or the element / text /
                                address appears (--gone: disappears)
  dialog accept|dismiss [TEXT]  answer a JavaScript dialog (TEXT for a prompt)

Options:
  -s, --session NAME   the session (default: "${DEFAULT_SESSION}")
  -t, --tab N          the tab to act on (for commands without a TAB argument)
  --json               print the result as JSON
  --timeout SEC        give up after SEC seconds (default 30): exit status 4
  --                   the rest are arguments, even if they start with -

Exit status: 0 done, 1 failed (bad id, page error...), 2 usage, 3 no such session, 4 timed out,
5 partly done (shot --full of a page over its size limit: the top part saved).
Start a session without a terminal first: termium start -s NAME`;

/** Exits with an error: always one line on stderr (as the skill promises). */
function fail(msg: string, code: number = EXIT.usage): never {
  console.error(`termium: ${msg.replace(/\s*\n\s*/g, " ").trim()}`);
  process.exit(code);
}

interface Parsed {
  session: string;
  json: boolean;
  out?: string;
  timeoutMs?: number;
  req: CtlRequest;
}

const num = (s: string, what: string): number => {
  const n = Number(s);
  if (!Number.isFinite(n)) fail(`${what} must be a number, not "${s}"`);
  return n;
};

const tabNum = (s: string): number => {
  const n = Number(s.replace(/^#/, ""));
  if (!Number.isInteger(n) || n < 1) fail(`bad tab "${s}" (a number from \`termium ctl tabs\`)`);
  return n;
};

export function parseCtl(argv: string[]): Parsed {
  let session = DEFAULT_SESSION;
  let json = false;
  let out: string | undefined;
  let timeoutMs: number | undefined;
  const flags = new Set<string>();
  let tab: number | undefined;
  let xy: [number, number] | undefined;
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (v === undefined) fail(`${a} needs a value`);
      return v;
    };
    if (a === "--") {
      pos.push(...argv.slice(i + 1));
      break;
    }
    switch (a) {
      case "-h":
      case "--help":
        console.log(CTL_HELP);
        process.exit(0);
      case "-s":
      case "--session":
        session = value();
        break;
      case "-t":
      case "--tab":
        tab = tabNum(value());
        break;
      case "--json":
        json = true;
        break;
      case "-o":
      case "--output":
        out = value();
        break;
      case "--timeout": {
        const s = num(value(), "--timeout");
        if (s <= 0) fail("--timeout must be more than 0");
        timeoutMs = Math.round(s * 1000);
        break;
      }
      case "--xy": {
        const m = /^(-?[\d.]+),(-?[\d.]+)$/.exec(value());
        if (!m) fail("--xy takes X,Y (CSS pixels), such as --xy 200,140");
        xy = [Number(m[1]), Number(m[2])];
        break;
      }
      case "--new-tab":
      case "--background":
      case "--no-wait":
      case "--force":
      case "--append":
      case "--submit":
      case "--double":
      case "--right":
      case "--middle":
      case "--gone":
      case "--full":
        flags.add(a);
        break;
      default:
        // A negative number is an argument (scroll amounts, coordinates), not an option.
        if (a.startsWith("-") && a.length > 1 && !/^-\d/.test(a)) fail(`unknown option ${a} (see termium ctl --help)`);
        pos.push(a);
    }
  }
  if (!validSessionName(session)) fail(`bad session name "${session}"`);
  const cmd = pos.shift();
  if (!cmd) fail(`ctl needs a command (see termium ctl --help)`);
  const req: CtlRequest = { cmd, tab };
  const allowed: Record<string, string[]> = {
    open: ["--new-tab", "--background", "--no-wait"],
    close: ["--force"],
    type: ["--append", "--submit"],
    click: ["--double", "--right", "--middle"],
    wait: ["--gone"],
    shot: ["--full"],
  };
  for (const f of flags) if (!allowed[cmd]?.includes(f)) fail(`${f} doesn't apply to ${cmd}`);
  if (xy && cmd !== "click") fail(`--xy only applies to click`);
  if (out && cmd !== "shot") fail(`-o only applies to shot`);
  const maxArgs = (n: number) => {
    if (pos.length > n) fail(`too many arguments for ${cmd}: ${pos.slice(n).join(" ")}`);
  };
  /** An optional TAB argument (as well as, or instead of, --tab). */
  const tabArg = () => {
    if (pos.length) {
      const t = tabNum(pos.shift()!);
      if (tab !== undefined && tab !== t) fail(`two different tabs given (${tab} and ${t})`);
      req.tab = t;
    }
  };
  switch (cmd) {
    case "tabs":
    case "devtools":
      maxArgs(0);
      break;
    case "open":
      if (!pos.length) fail("open needs a URL");
      req.url = pos.shift();
      maxArgs(0);
      req.newTab = flags.has("--new-tab") || flags.has("--background");
      req.background = flags.has("--background");
      req.wait = !flags.has("--no-wait");
      if (req.newTab && tab !== undefined) fail("--tab and --new-tab can't be used together");
      break;
    case "select":
      if (!pos.length && tab === undefined) fail("select needs a TAB");
      tabArg();
      maxArgs(0);
      break;
    case "close":
      tabArg();
      maxArgs(0);
      req.force = flags.has("--force");
      break;
    case "mute":
    case "unmute":
      tabArg();
      maxArgs(0);
      break;
    case "snapshot":
    case "text":
    case "shot":
      tabArg();
      maxArgs(0);
      req.full = flags.has("--full");
      break;
    case "click":
      if (xy) req.xy = xy;
      else if (pos.length) req.ref = pos.shift();
      else fail("click needs an element ID (from snapshot) or --xy X,Y");
      maxArgs(0);
      req.double = flags.has("--double");
      req.button = flags.has("--right") ? "right" : flags.has("--middle") ? "middle" : "left";
      break;
    case "type":
      if (pos.length < 2) fail("type needs an element ID and the TEXT");
      req.ref = pos.shift();
      req.text = pos.shift();
      maxArgs(0);
      req.append = flags.has("--append");
      req.submit = flags.has("--submit");
      break;
    case "key":
      if (!pos.length) fail("key needs at least one KEY");
      req.keys = pos.splice(0);
      break;
    case "scroll": {
      if (pos.length && /^\d+:\d+@\d+$/.test(pos[0]!)) req.ref = pos.shift();
      const dir = pos.shift() ?? "down";
      if (!["up", "down", "left", "right"].includes(dir)) fail(`scroll goes up, down, left or right, not "${dir}"`);
      req.direction = dir as CtlRequest["direction"];
      if (pos.length) {
        req.amount = num(pos.shift()!, "the scroll amount");
        if (req.amount <= 0) fail("the scroll amount must be more than 0");
      }
      maxArgs(0);
      break;
    }
    case "eval":
      if (!pos.length) fail("eval needs JavaScript to run");
      req.expr = pos.shift();
      tabArg();
      maxArgs(0);
      break;
    case "wait": {
      const what = pos.shift() ?? "load";
      if (!["load", "selector", "text", "url"].includes(what)) fail(`wait for load, selector, text or url, not "${what}"`);
      req.what = what as CtlRequest["what"];
      if (what !== "load") {
        if (!pos.length) fail(`wait ${what} needs a value`);
        req.value = pos.shift();
      } else if (flags.has("--gone")) fail("--gone doesn't apply to wait load");
      req.gone = flags.has("--gone");
      maxArgs(0);
      break;
    }
    case "dialog": {
      const answer = pos.shift();
      if (answer !== "accept" && answer !== "dismiss") fail("dialog accept|dismiss [TEXT]");
      req.accept = answer === "accept";
      if (pos.length) req.text = pos.shift();
      maxArgs(0);
      break;
    }
    default:
      fail(`unknown ctl command "${cmd}" (see termium ctl --help)`);
  }
  req.timeoutMs = timeoutMs;
  return { session, json, out, timeoutMs, req };
}

/** Sends one request to session `name`; exits with a message if that can't be done. */
export async function request(name: string, req: CtlRequest, waitMs = (req.timeoutMs ?? 30_000) + 15_000): Promise<any> {
  const info = await sessionInfo(name).catch(() => null);
  if (!info) fail(`no session "${name}" (start one without a terminal: termium start${name === DEFAULT_SESSION ? "" : ` -s ${name}`})`, EXIT.noSession);
  if (info.unresponsive) fail(`session "${name}" isn't responding${info.pid ? ` (pid ${info.pid})` : ""}`, EXIT.failed);
  if (info.refused) fail(`${info.refused} End it (termium kill ${name}) and start it again with this termium.`, EXIT.failed);
  if (info.ctl !== true) {
    fail(
      `session "${name}" runs termium ${info.version ?? "(older)"}, which has no agent control. ` +
        `End it (termium kill ${name}) and start it again with this termium.`,
      EXIT.failed,
    );
  }
  const sock = await dial(sessionPaths(name).sock).catch(() => null);
  if (!sock) fail(`no session "${name}"`, EXIT.noSession);
  return new Promise((resolveReply) => {
    let done = false;
    const timer = setTimeout(() => {
      sock.destroy();
      fail(`session "${name}" didn't answer within ${Math.round(waitMs / 1000)}s`, EXIT.timeout);
    }, waitMs);
    const reader = new FrameReader((f) => {
      if (f.type === 1 && f.msg?.t === "bye" && f.msg?.reason === "error" && !done) {
        // Refused (a termium speaking another session protocol, say): its reason, not "no answer".
        done = true;
        clearTimeout(timer);
        sock.destroy();
        fail(
          `${String(f.msg.message ?? `session "${name}" refused the request`)} End it (termium kill ${name}) and start it again with this termium.`,
          EXIT.failed,
        );
      }
      if (f.type !== 1 || f.msg?.t !== "ctl" || done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      resolveReply(f.msg);
    });
    sock.on("data", (c: Buffer) => {
      try {
        reader.push(c);
      } catch {
        sock.destroy();
      }
    });
    sock.on("close", () => {
      if (done) return;
      clearTimeout(timer);
      fail(`session "${name}" closed the connection without answering`, EXIT.failed);
    });
    sock.on("error", () => {});
    sock.write(jsonFrame({ t: "hello", v: PROTOCOL, kind: "ctl" } satisfies Hello));
    sock.write(jsonFrame({ t: "ctl", req }));
  });
}

export async function runCtl(argv: string[]): Promise<never> {
  const p = parseCtl(argv);
  const reply = await request(p.session, p.req);
  if (!reply.ok) {
    if (p.json) console.log(JSON.stringify({ ok: false, error: reply.error, code: reply.code }));
    fail(String(reply.error ?? "failed"), Number(reply.code) || EXIT.failed);
  }
  const r = reply.result;
  if (p.req.cmd === "shot") {
    // Readable only by you (a page can show anything), whatever the umask. The default
    // file has an unguessable name and is created afresh, never through a planted link.
    const path = resolve(p.out ?? join(tmpdir(), `termium-shot-${r.tab}-${randomBytes(8).toString("hex")}.png`));
    try {
      const png = Buffer.from(String(r.png), "base64");
      if (p.out) {
        writeFileSync(path, png, { mode: 0o600 });
        chmodSync(path, 0o600);
      } else {
        const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
          for (let off = 0; off < png.length; ) off += writeSync(fd, png, off);
        } finally {
          closeSync(fd);
        }
      }
    } catch (e: any) {
      fail(`can't write ${path}: ${e?.message ?? e}`, EXIT.failed);
    }
    const cut = r.truncated ? `page is ${r.truncated.height}px tall; captured the top ${r.truncated.captured}px` : "";
    if (p.json) console.log(JSON.stringify({ tab: r.tab, path, ...(r.truncated ? { truncated: r.truncated } : {}) }));
    else console.log(path);
    if (cut) {
      console.error(`termium: ${cut}`);
      process.exit(EXIT.partial);
    }
    process.exit(0);
  }
  if (p.json) {
    console.log(JSON.stringify(r));
    process.exit(0);
  }
  console.log(human(p.req, r));
  process.exit(0);
}

function tabLine(t: any): string {
  const where = `space ${t.space}${t.spaceName && t.spaceName !== `space ${t.space}` ? ` (${t.spaceName})` : ""}, tab ${t.tab}${t.pane > 1 ? `, pane ${t.pane}` : ""}`;
  const flags = [
    t.loading ? "loading" : "",
    t.dialog ? `${t.dialog.type} dialog` : "",
    t.muted ? "muted" : t.audible ? "playing sound" : "",
    t.visible ? "" : "hidden",
  ].filter(Boolean);
  return `${t.active ? "*" : " "}${String(t.id).padStart(3)}  ${where}  ${t.title || "(untitled)"}  ${t.url}${flags.length ? `  [${flags.join(", ")}]` : ""}`;
}

function human(req: CtlRequest, r: any): string {
  switch (req.cmd) {
    case "tabs":
      return (r as any[]).map(tabLine).join("\n");
    case "open":
    case "select":
    case "close":
      return (
        `${req.cmd === "close" ? "closed" : req.cmd === "select" ? "showing" : "tab"} ${r.id}: ${r.title || "(untitled)"}  ${r.url}` +
        (r.background ? "\n(opened in the background: the person at the terminal was busy)" : "") +
        (r.dialog ? `\nthe page shows a ${r.dialog.type} dialog: ${r.dialog.message}` : "")
      );
    case "mute":
    case "unmute":
      return `${req.cmd}d ${r.id}: ${r.title || "(untitled)"}  ${r.url}`;
    case "snapshot":
      return `tab ${r.tab}: ${r.title || "(untitled)"}  ${r.url}\n${r.snapshot}`;
    case "text":
      return r.text;
    case "eval":
      return r.type === "undefined" ? "undefined" : JSON.stringify(r.value, null, 2);
    case "click":
      return `clicked${r.ref ? ` ${r.ref}` : ""} at ${r.x},${r.y}${r.dialog ? `\nthe page shows a ${r.dialog.type} dialog: ${r.dialog.message}` : ""}`;
    case "type":
      return (
        (r.selected !== undefined ? `chose "${r.selected}" in ${r.ref}` : r.typed !== undefined ? `typed ${r.typed} characters into ${r.ref}` : `typing into ${r.ref}`) +
        (r.submitted ? ", submitted" : "") +
        (r.dialog ? `\nthe page shows a ${r.dialog.type} dialog: ${r.dialog.message}` : "")
      );
    case "key":
      return `pressed ${r.keys.join(" ")}${r.dialog ? `\nthe page shows a ${r.dialog.type} dialog (${r.pressed} of ${r.of} keys pressed): ${r.dialog.message}` : ""}`;
    case "scroll":
      return `scrolled to ${r.scrollX},${r.scrollY}`;
    case "wait":
      return `${r.waited}${r.value !== undefined ? ` ${JSON.stringify(r.value)}` : ""}${r.gone ? " gone" : ""} after ${(r.ms / 1000).toFixed(1)}s`;
    case "dialog":
      return `${r.accepted ? "accepted" : "dismissed"} the ${r.type} dialog: ${r.message}`;
    default:
      return JSON.stringify(r);
  }
}

/** `termium devtools [NAME] [--json]`: the session's DevTools endpoint. */
export async function runDevtools(argv: string[]): Promise<never> {
  let session: string | null = null;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") json = true;
    else if (a === "-s" || a === "--session") {
      const v = argv[++i];
      if (v === undefined) fail(`${a} needs a value`);
      if (session !== null && session !== v) fail("only one session name may be given");
      session = v;
    } else if (a === "-h" || a === "--help") {
      console.log(
        "Usage: termium devtools [NAME] [--json]\n\n" +
          "Prints the session's DevTools endpoint (loopback only) for Puppeteer, Playwright,\n" +
          "chrome-devtools-mcp and the like: http://127.0.0.1:PORT, or with --json\n" +
          "{name, pid, browserURL, webSocketDebuggerUrl}.",
      );
      process.exit(0);
    } else if (a.startsWith("-")) fail(`unknown option ${a}`);
    else {
      if (session !== null && session !== a) fail("only one session name may be given");
      session = a;
    }
  }
  const name = session ?? DEFAULT_SESSION;
  if (!validSessionName(name)) fail(`bad session name "${name}"`);
  const reply = await request(name, { cmd: "devtools" });
  if (!reply.ok) fail(String(reply.error), Number(reply.code) || EXIT.failed);
  const info = await sessionInfo(name).catch(() => null);
  const r = reply.result;
  if (json) console.log(JSON.stringify({ name, pid: info?.pid ?? null, browserURL: r.browserURL, webSocketDebuggerUrl: r.webSocketDebuggerUrl }));
  else console.log(r.browserURL);
  process.exit(0);
}

/**
 * `termium start [-s NAME] [URL]`: starts the session in the background,
 * with no terminal (an agent's way in), and returns once its browser is
 * up. A session already running is left as it is (a URL opens in a new tab).
 */
export async function startSession(o: { name: string; url: string | null; launchFlags: string[]; serverArgv: string[] }): Promise<never> {
  const paths = sessionPaths(o.name);
  const running = await sessionInfo(o.name).catch(() => null);
  const devtoolsLine = async () => {
    const r = await request(o.name, { cmd: "devtools" }).catch(() => null);
    return r?.ok ? `  DevTools: ${r.result.browserURL}` : "";
  };
  if (running) {
    if (o.launchFlags.length) {
      fail(`session "${o.name}" is already running, and ${o.launchFlags.join(", ")} only apply when starting one`, EXIT.failed);
    }
    // A session of an older termium (or one that won't talk to this one) runs,
    // but takes no agent commands: said so; it's still "already running".
    const other = running.unresponsive
      ? "not responding"
      : running.refused || running.ctl !== true
        ? `termium ${running.version ?? "(older)"}, no agent control`
        : null;
    if (other) {
      if (o.url) fail(`session "${o.name}" is already running (${other}): couldn't open ${o.url} in it`, EXIT.failed);
      console.log(`session "${o.name}" is already running (${other}; pid ${running.pid ?? "?"})`);
      process.exit(0);
    }
    if (o.url) {
      const r = await request(o.name, { cmd: "open", url: o.url, newTab: true });
      if (!r.ok) fail(String(r.error), Number(r.code) || EXIT.failed);
    }
    console.log(`session "${o.name}" is already running (pid ${running.pid})${await devtoolsLine()}`);
    process.exit(0);
  }
  sweepErrFiles();
  const errPath = `${paths.err.slice(0, -4)}.${process.pid}.err`;
  const errFd = openSync(errPath, "w", 0o600);
  let exited: number | null = null;
  const child = spawn(o.serverArgv[0]!, o.serverArgv.slice(1), { detached: true, stdio: ["ignore", errFd, errFd] });
  closeSync(errFd);
  child.on("exit", (code, signal) => (exited = code ?? (signal ? 1 : 0)));
  child.on("error", () => (exited = 1));
  child.unref();
  const why = () => {
    try {
      return readFileSync(errPath, "utf8").trim();
    } catch {
      return "";
    }
  };
  // Listening (or another termium won the race to start it: that one will do).
  const end = Date.now() + 30_000;
  for (;;) {
    const s = await dial(paths.sock).catch(() => null);
    if (s) {
      s.destroy();
      break;
    }
    if ((exited !== null && (exited !== 3 || lockHolder(paths.lock) === null)) || Date.now() > end) {
      const msg = why();
      rmSync(errPath, { force: true });
      fail(msg.replace(/^termium: /, "") || `session "${o.name}" didn't start`, EXIT.failed);
    }
    await Bun.sleep(50);
  }
  // Its browser and first page: the session is ready for ctl.
  const r = await request(o.name, { cmd: "ready", timeoutMs: 60_000 });
  rmSync(errPath, { force: true });
  if (!r.ok) fail(`session "${o.name}" didn't start: ${r.error}`, EXIT.failed);
  // Another `termium start` of this name won the race (ours exited, taking
  // no part): the URL goes to that session, as to one already running.
  const info = await sessionInfo(o.name).catch(() => null);
  if (o.url && info?.pid && info.pid !== child.pid) {
    const opened = await request(o.name, { cmd: "open", url: o.url, newTab: true });
    if (!opened.ok) fail(String(opened.error), Number(opened.code) || EXIT.failed);
  }
  console.log(`started session "${o.name}" (pid ${info?.pid ?? "?"})${await devtoolsLine()}`);
  process.exit(0);
}
