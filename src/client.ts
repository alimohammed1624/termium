// The client: owns the terminal (modes, capability detection, the input
// parser) and attaches it to a session server (src/server.ts), starting
// one first if needed. It draws what the server sends and forwards input.

import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InputParser, type InputEvent } from "./input";
import type { Hello } from "./server";
import { stateDir } from "./server";
import {
  FrameReader,
  MSG_OUTPUT,
  PROTOCOL,
  dial,
  jsonFrame,
  readPid,
  removeStale,
  sessionNames,
  sessionPaths,
  socketDir,
} from "./session";
import { drained, enterTerminal, out, queryCapabilities, querySizes, restoreTerminal, setTmuxPassthrough } from "./terminal";

export interface ClientOptions {
  name: string;
  /** "auto": attach, or start the session first; "attach": only attach. */
  mode: "auto" | "attach";
  /** Open this URL (in the new session, or in a new tab of a running one). */
  url: string | null;
  /** Launch options given on the command line (they only apply when starting a session). */
  launchFlags: string[];
  /** argv that starts the session server. */
  serverArgv: string[];
  version: string;
}

function fail(msg: string, code = 2): never {
  console.error(`termium: ${msg}`);
  process.exit(code);
}

/** Inside tmux: is passthrough allowed for this pane? null if tmux can't say. */
function tmuxPassthroughSetting(): string | null {
  try {
    const args = ["show-options", "-Apqv"];
    if (process.env.TMUX_PANE) args.push("-t", process.env.TMUX_PANE);
    const r = Bun.spawnSync(["tmux", ...args, "allow-passthrough"], { stdout: "pipe", stderr: "ignore" });
    if (r.exitCode !== 0) return null;
    const v = r.stdout.toString().trim().split("\n").pop()?.trim() ?? "";
    return v || null;
  } catch {
    return null;
  }
}

const TMUX_HINT =
  "termium draws pages with the kitty graphics protocol, which tmux only passes on with\n" +
  "  set -g allow-passthrough on\n" +
  "in ~/.tmux.conf (or run: tmux set -g allow-passthrough on). The terminal running tmux\n" +
  "must support kitty graphics too (Ghostty, kitty, WezTerm).";

/**
 * Temporary files for pictures (kitty graphics t=t: the terminal reads the
 * file and deletes it). The name must contain "tty-graphics-protocol" and
 * live in a temp directory for terminals to accept it. Files the terminal
 * never read (tmux dropped the escape) are removed after a while.
 */
const graphicsFiles = (() => {
  const dir = existsSync("/dev/shm") ? "/dev/shm" : tmpdir();
  const made = new Map<string, number>();
  let n = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  const sweep = () => {
    const now = Date.now();
    for (const [path, at] of made) {
      if (now - at > 10_000) rmSync(path, { force: true });
      if (now - at > 10_000 || !existsSync(path)) made.delete(path);
    }
  };
  return {
    write(data: Uint8Array): string {
      const path = join(dir, `termium-tty-graphics-protocol-${process.pid}-${++n}`);
      writeFileSync(path, data, { mode: 0o600 });
      made.set(path, Date.now());
      if (!timer) {
        timer = setInterval(sweep, 2000);
        timer.unref?.();
      }
      return path;
    },
    clear(): void {
      for (const path of made.keys()) rmSync(path, { force: true });
      made.clear();
    },
  };
})();
process.on("exit", () => graphicsFiles.clear());

export async function runClient(o: ClientOptions): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) fail("needs an interactive terminal");
  let paths: ReturnType<typeof sessionPaths>;
  try {
    paths = sessionPaths(o.name);
  } catch (e: any) {
    fail(e?.message ?? String(e));
  }

  const inTmux = !!process.env.TMUX;
  if (inTmux && tmuxPassthroughSetting() === "off") fail(`tmux has allow-passthrough off.\n${TMUX_HINT}`);
  setTmuxPassthrough(inTmux);
  const forced = process.env.TERMIUM_GRAPHICS;
  const placeholders = forced === "placeholders" ? true : forced === "direct" ? false : inTmux;

  // Already running? Then this terminal just attaches.
  let sock: Socket | null = null;
  try {
    sock = await dial(paths.sock);
  } catch (e: any) {
    fail(e?.message ?? String(e));
  }
  if (!sock && o.mode === "attach") fail(`no session "${o.name}" (termium ls lists them)`, 1);
  if (sock && o.launchFlags.length) {
    sock.destroy();
    fail(
      `session "${o.name}" is already running, and ${o.launchFlags.join(", ")} only apply when starting one.\n` +
        `Attach with: termium attach ${o.name}   or start another session: termium -s NAME ${o.launchFlags.join(" ")}`,
    );
  }

  // Not running: start the server now, so the browser launches while the
  // terminal answers our capability queries.
  let child: ReturnType<typeof spawn> | null = null;
  let childExit: number | null = null;
  if (!sock) {
    const errFd = openSync(paths.err, "w", 0o600);
    child = spawn(o.serverArgv[0]!, o.serverArgv.slice(1), { detached: true, stdio: ["ignore", errFd, errFd] });
    closeSync(errFd);
    child.on("exit", (code, signal) => (childExit = code ?? (signal ? 1 : 0)));
    child.on("error", () => (childExit = 1));
    child.unref();
  }

  // Raw mode first: switching modes discards anything typed before it.
  const caps = {
    graphics: false,
    pixelMouse: false,
    kittyFlags: -1,
    cell: null as { width: number; height: number } | null,
    area: null as { width: number; height: number } | null,
  };
  let onCapsDone: (() => void) | null = null;
  let onGraphics: (() => void) | null = null;
  /** The tmux flow-control query being waited for (see pump). */
  let flowWait: { id: number; done: () => void } | null = null;
  let onFileProbe: ((ok: boolean) => void) | null = null;
  /** Pictures go to the terminal as temporary files (tmux, terminal on this machine). */
  let fileTransport = false;
  let onSizes: (() => void) | null = null;
  let conn: Socket | null = null;
  const pending: InputEvent[] = [];
  const send = (msg: unknown) => {
    if (conn && !conn.destroyed) conn.write(jsonFrame(msg));
  };

  const parser = new InputParser((ev) => {
    switch (ev.type) {
      case "kittyGraphics":
        if (ev.id === 31) {
          caps.graphics = ev.message === "OK";
          onGraphics?.();
        } else if (ev.id === 32) {
          onFileProbe?.(ev.message === "OK");
        } else if (flowWait && ev.id === flowWait.id) {
          flowWait.done();
        }
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
    if (conn) send({ t: "input", ev });
    else pending.push(ev);
  });

  let leaving = false;
  /** Gives the terminal back and exits, saying why. */
  const leave = async (code: number, message?: string) => {
    if (leaving) return;
    leaving = true;
    await Promise.race([drained(), Bun.sleep(500)]);
    restoreTerminal();
    try {
      process.stdin.setRawMode(false);
    } catch {}
    if (message) (code === 0 ? console.log : console.error)(message);
    conn?.destroy();
    graphicsFiles.clear();
    process.exit(code);
  };

  process.stdin.setRawMode(true);
  const decoder = new TextDecoder();
  process.stdin.on("data", (chunk: Buffer) => {
    try {
      parser.feed(decoder.decode(chunk, { stream: true }));
    } catch {
      // Garbage input must never take anything down with it.
    }
  });
  // The terminal itself went away (pane closed, ssh dropped): just let go;
  // the session carries on without us.
  const lost = () => void leave(0);
  process.stdin.on("end", lost);
  process.stdin.on("error", lost);
  process.on("SIGHUP", lost);
  process.on("SIGTERM", lost);
  process.on("SIGINT", lost);
  process.stdin.resume();
  enterTerminal();
  parser.expectApc = true;
  if (inTmux) {
    // tmux drops passthrough while it has a redraw pending, as it does
    // right after the switch to the alternate screen (unless
    // allow-passthrough is "all"). A round trip through tmux first lets it
    // catch up.
    out("\x1b[c");
    await Promise.race([new Promise<void>((r) => (onCapsDone = r)), Bun.sleep(500)]);
    await Bun.sleep(50);
  }
  queryCapabilities();

  const graphicsReply = new Promise<void>((r) => (onGraphics = r));
  await Promise.race([new Promise<void>((r) => (onCapsDone = r)), Bun.sleep(1500)]);
  onCapsDone = null;
  // tmux answers the other queries itself, but the graphics one makes a
  // round trip through the outer terminal, so its reply can come last.
  if (inTmux && !caps.graphics) await Promise.race([graphicsReply, Bun.sleep(1500)]);
  onGraphics = null;
  if (inTmux && placeholders && caps.graphics && process.env.TERMIUM_TMUX_FILES !== "0") {
    // Can the terminal read our files? (Not when it runs on another machine.)
    const path = graphicsFiles.write(new Uint8Array([0, 0, 0]));
    const answer = new Promise<boolean>((r) => (onFileProbe = r));
    out(`\x1b_Gi=32,s=1,v=1,a=q,t=t,f=24;${Buffer.from(path).toString("base64")}\x1b\\`);
    fileTransport = await Promise.race([answer, Bun.sleep(1000).then(() => false)]);
    onFileProbe = null;
    rmSync(path, { force: true });
  }
  // From here on ESC _ is a legacy Alt+_ keypress, not a reply we're waiting for.
  parser.expectApc = false;

  /** Stops a server this client started but won't attach to. */
  const stopOwnServer = async () => {
    if (!child) return;
    const s = await waitForServer(2000).catch(() => null);
    if (s) {
      s.write(jsonFrame({ t: "hello", v: PROTOCOL, kind: "kill" } satisfies Hello));
      await new Promise<void>((r) => {
        s.on("close", () => r());
        s.on("error", () => r());
        s.resume();
        setTimeout(r, 10_000);
      });
    } else if (child.pid && childExit === null) {
      try {
        process.kill(child.pid, "SIGTERM");
      } catch {}
      for (let i = 0; i < 100 && childExit === null; i++) await Bun.sleep(50);
    }
  };

  /** Connects once the server we started listens; null if it exited first. */
  async function waitForServer(timeoutMs = 30_000): Promise<Socket | null> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const s = await dial(paths.sock).catch(() => null);
      if (s) return s;
      if (childExit !== null) return null;
      await Bun.sleep(30);
    }
    return null;
  }

  if (!caps.graphics) {
    await stopOwnServer();
    await leave(
      1,
      inTmux
        ? `termium: no kitty graphics through tmux.\n${TMUX_HINT}`
        : "termium: this terminal does not support the kitty graphics protocol. Use Ghostty, kitty or WezTerm.",
    );
    return;
  }

  if (!sock) {
    sock = await waitForServer();
    if (!sock) {
      // Lost a race with another termium starting the same session? Then attach to that.
      sock = await dial(paths.sock).catch(() => null);
      if (!sock) {
        let why = "";
        try {
          why = readFileSync(paths.err, "utf8").trim();
        } catch {}
        await leave(childExit || 1, why || `the session server exited (see ${join(stateDir(), "termium.log")})`);
        return;
      }
    }
  }

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

  conn = sock;
  let quitting = false;

  // Pictures through tmux. tmux discards output, passthrough included, once
  // more than about cols x rows x 8 bytes wait for the outer terminal; it
  // redraws text from its own copy afterwards, but a picture cut short is
  // lost. So when the terminal can read our files (checked at startup),
  // each picture goes as a temporary file and the escape that names it is
  // tiny. Otherwise the data is paced: before each picture a graphics query
  // makes a round trip through tmux (its answer means everything before it
  // was delivered), and within a picture slices are spaced out in time. A
  // query must never land between the chunks of one picture: the terminal
  // would take it as the end of that transfer.
  const outQueue: { data: string; done?: () => void }[] = [];
  let pumping = false;
  let sent = 0;
  let flowSeq = 0;
  /** Round trips work (they don't while tmux has the pane hidden). */
  let flowOk = true;
  const budget = () => Math.max(8192, (process.stdout.columns || 80) * (process.stdout.rows || 24) * 2);
  const roundTrip = async (timeoutMs: number): Promise<boolean> => {
    const id = 1_000_000 + (flowSeq = (flowSeq + 1) % 1_000_000);
    let answered = false;
    const reply = new Promise<void>((r) => (flowWait = { id, done: () => ((answered = true), r()) }));
    parser.expectApc = true; // the answer is an APC, not an Alt+_ keypress
    out(`\x1b_Gi=${id},s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\`);
    await Promise.race([reply, Bun.sleep(timeoutMs)]);
    if (flowWait?.id === id) flowWait = null;
    parser.expectApc = false;
    return answered;
  };
  const pump = async () => {
    if (pumping) return;
    pumping = true;
    while (outQueue.length) {
      const { data, done } = outQueue.shift()!;
      let acc = "";
      let last = 0;
      const pieces: string[] = [];
      for (const m of data.matchAll(/\x1b_G[^\x1b]*\x1b\\/g)) {
        if (m.index! > last) pieces.push(data.slice(last, m.index));
        pieces.push(m[0]);
        last = m.index! + m[0].length;
      }
      if (last < data.length) pieces.push(data.slice(last));
      for (const piece of pieces) {
        if (flowOk && sent > 0 && sent + piece.length > budget()) {
          out(acc);
          acc = "";
          sent = 0;
          if (!/^\x1b_Gm=/.test(piece)) {
            // Between pictures: wait until tmux has passed everything on.
            if (!(await roundTrip(300))) {
              // No answer: tmux isn't passing anything on (pane hidden, or
              // redrawing). Stop waiting; once an answer comes back, ask
              // the session to send its pictures again.
              flowOk = false;
              void (async () => {
                while (!flowOk && !leaving) {
                  if (await roundTrip(1000)) {
                    flowOk = true;
                    send({ t: "repaint" });
                  }
                }
              })();
            }
          } else {
            await Bun.sleep(4); // within a picture: just slow down
          }
        }
        acc += piece;
        sent += piece.length;
      }
      out(acc, done);
    }
    pumping = false;
  };

  /** Rewrites each picture's chunks as one escape naming a temporary file with the PNG. */
  let loading: { ctrl: string; parts: string[] } | null = null;
  const viaFiles = (data: string): string => {
    let res = "";
    let last = 0;
    for (const m of data.matchAll(/\x1b_G([^;\x1b]*)(?:;([^\x1b]*))?\x1b\\/g)) {
      res += data.slice(last, m.index);
      last = m.index! + m[0].length;
      const ctrl = m[1]!;
      const payload = m[2] ?? "";
      if (/(^|,)a=T(,|$)/.test(ctrl)) {
        loading = { ctrl, parts: [payload] };
      } else if (loading && /^m=[01]$/.test(ctrl)) {
        loading.parts.push(payload);
      } else {
        res += m[0];
        continue;
      }
      if (/(^|,)m=1(,|$)/.test(ctrl)) continue; // more to come
      const { ctrl: first, parts } = loading;
      loading = null;
      const path = graphicsFiles.write(Buffer.from(parts.join(""), "base64"));
      res += `\x1b_G${first.replace(/(^|,)m=\d/, "")},t=t;${Buffer.from(path).toString("base64")}\x1b\\`;
    }
    return res + data.slice(last);
  };

  /** Terminal output from the session. */
  const emit = (data: string, done?: () => void) => {
    if (!inTmux || !placeholders) return out(data, done);
    if (fileTransport) return out(viaFiles(data), done);
    outQueue.push({ data, done });
    void pump();
  };
  let said = false;
  const reader = new FrameReader((f) => {
    if (f.type === MSG_OUTPUT) {
      if (quitting) {
        if (f.seq) send({ t: "ack", seq: f.seq });
        return;
      }
      const seq = f.seq;
      emit(f.data, seq ? () => send({ t: "ack", seq }) : undefined);
      return;
    }
    const m = f.msg;
    if (m?.t === "quitting") {
      // The session is ending: the terminal is ours again while it stops the browser.
      quitting = true;
      void Promise.race([drained(), Bun.sleep(500)]).then(() => {
        restoreTerminal();
        try {
          process.stdin.setRawMode(false);
        } catch {}
      });
    } else if (m?.t === "bye") {
      said = true;
      const code = Number(m.code ?? 0) || 0;
      switch (m.reason) {
        case "detached":
          return void leave(0, `[detached (from session ${o.name})]`);
        case "takeover":
          return void leave(0, `[detached (session ${o.name} was attached from another terminal)]`);
        case "error":
          return void leave(code || 1, `termium: ${m.message ?? "the session ended with an error"}`);
        default:
          return void leave(code);
      }
    }
  });
  conn.on("data", (chunk: Buffer) => {
    try {
      reader.push(chunk);
    } catch {
      conn?.destroy();
    }
  });
  conn.on("error", () => {});
  conn.on("close", () => {
    if (said || leaving) return;
    void leave(
      1,
      `termium: lost the session "${o.name}": its server went away (see ${join(stateDir(), "termium.log")})`,
    );
  });

  const g = geometry();
  send({
    t: "hello",
    v: PROTOCOL,
    kind: "attach",
    version: o.version,
    ...g,
    pixelMouse: caps.pixelMouse,
    placeholders,
    via: !inTmux ? "direct" : fileTransport ? "tmux-files" : "tmux-paced",
    // A session we just started opens the URL itself.
    url: child ? null : o.url,
  } satisfies Hello);
  for (const ev of pending.splice(0)) send({ t: "input", ev });

  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  process.stdout.on("resize", () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(async () => {
      caps.cell = null;
      caps.area = null;
      querySizes();
      await Promise.race([new Promise<void>((r) => (onSizes = r)), Bun.sleep(500)]);
      onSizes = null;
      send({ t: "resize", ...geometry() });
    }, 60);
  });
}

/** Asks a session for its details; null if it isn't running (a stale socket is removed). */
async function sessionInfo(name: string): Promise<any | null> {
  const p = sessionPaths(name);
  const sock = await dial(p.sock, 3000).catch(() => null);
  if (!sock) {
    const pid = readPid(name);
    let alive = false;
    if (pid) {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {}
    }
    // Nobody listening: a server that died without cleaning up. (A server
    // still starting has no socket yet, so it's never removed here.)
    if (!alive) removeStale(name);
    return null;
  }
  return new Promise((resolve) => {
    let info: any = null;
    const reader = new FrameReader((f) => {
      if (f.type === 1 && f.msg?.t === "info") info = f.msg;
    });
    sock.on("data", (c: Buffer) => {
      try {
        reader.push(c);
      } catch {}
    });
    sock.on("close", () => resolve(info));
    sock.on("error", () => resolve(info));
    setTimeout(() => {
      sock.destroy();
      resolve(info);
    }, 3000);
    sock.write(jsonFrame({ t: "hello", v: PROTOCOL, kind: "info" } satisfies Hello));
  });
}

export async function listSessions(): Promise<void> {
  let dir: string;
  try {
    dir = socketDir();
  } catch (e: any) {
    fail(e?.message ?? String(e));
  }
  const rows: string[][] = [];
  for (const name of sessionNames(dir)) {
    const info = await sessionInfo(name);
    if (!info) continue;
    rows.push([name, String(info.pid), info.attached ? "attached" : "detached", `${info.pages} page${info.pages === 1 ? "" : "s"}`, info.profile]);
  }
  if (rows.length === 0) {
    console.error("termium: no sessions");
    process.exit(1);
  }
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  for (const r of rows) console.log(r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!))).join("  "));
}

export async function killSession(name: string): Promise<void> {
  let p: ReturnType<typeof sessionPaths>;
  try {
    p = sessionPaths(name);
  } catch (e: any) {
    fail(e?.message ?? String(e));
  }
  const sock = await dial(p.sock).catch(() => null);
  if (!sock) {
    await sessionInfo(name); // clears a stale socket
    fail(`no session "${name}"`, 1);
  }
  // The server answers once the browser is stopped and closes the socket.
  await new Promise<void>((resolve) => {
    sock.on("close", () => resolve());
    sock.on("error", () => resolve());
    sock.resume();
    setTimeout(resolve, 15_000);
    sock.write(jsonFrame({ t: "hello", v: PROTOCOL, kind: "kill" } satisfies Hello));
  });
}
