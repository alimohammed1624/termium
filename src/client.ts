// The client: owns the terminal (modes, capability detection, the input
// parser) and attaches it to a session server (src/server.ts), starting
// one first if needed. It draws what the server sends and forwards input.

import { spawn } from "node:child_process";
import { closeSync, constants, existsSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockHolder } from "./browser";
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

/**
 * Inside tmux: is ours the pane tmux hands the outer terminal's answers to
 * (the active pane of a window being shown)? Queries sent from any other
 * pane are answered into that one, typed into whatever runs there.
 */
function tmuxPaneActive(): boolean {
  const pane = process.env.TMUX_PANE;
  if (!pane) return true;
  try {
    const r = Bun.spawnSync(["tmux", "display-message", "-p", "-t", pane, "#{pane_active} #{window_active} #{session_attached}"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (r.exitCode !== 0) return true;
    const [p, w, attached] = r.stdout.toString().trim().split(" ");
    return p === "1" && w === "1" && attached !== "0";
  } catch {
    return true;
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
      // An unguessable name, created exclusively (never through a symlink
      // someone planted), readable only by us (and the terminal: same user).
      const path = join(dir, `termium-tty-graphics-protocol-${randomBytes(16).toString("hex")}`);
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        for (let off = 0; off < data.length; ) off += writeSync(fd, data, off);
      } finally {
        closeSync(fd);
      }
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

  // What the server we may start says if it fails (ours alone: a second
  // client starting the same session at once has its own).
  const errPath = `${paths.err.slice(0, -4)}.${process.pid}.err`;
  process.on("exit", () => rmSync(errPath, { force: true }));

  const inTmux = !!process.env.TMUX;
  const passthrough = inTmux ? tmuxPassthroughSetting() : null;
  if (passthrough === "off") fail(`tmux has allow-passthrough off.\n${TMUX_HINT}`);
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
    const errFd = openSync(errPath, "w", 0o600);
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
  /** Whether the terminal reads our files: "unknown" until it answers at all. */
  let fileProbe: "yes" | "no" | "unknown" = "no";
  /** Asks whether the terminal can read our files (not when it runs on another machine). */
  const probeFiles = async (): Promise<"yes" | "no" | "unknown"> => {
    const path = graphicsFiles.write(new Uint8Array([0, 0, 0]));
    let answer: boolean | null = null;
    const answered = new Promise<void>((r) => (onFileProbe = (ok) => ((answer = ok), r())));
    const apc = parser.expectApc;
    parser.expectApc = true;
    out(`\x1b_Gi=32,s=1,v=1,a=q,t=t,f=24;${Buffer.from(path).toString("base64")}\x1b\\`);
    await Promise.race([answered, Bun.sleep(1000)]);
    parser.expectApc = apc;
    onFileProbe = null;
    rmSync(path, { force: true });
    return answer === null ? "unknown" : answer ? "yes" : "no";
  };
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
    if (conn) {
      send({ t: "input", ev });
      watchKey(ev);
    } else pending.push(ev);
  });

  // A session that stopped answering (hung, or stopped with SIGSTOP) must
  // not trap the terminal: the keys that leave (Ctrl+B d, Ctrl+Q, Ctrl+C)
  // ask it for a sign of life, and without one the terminal is let go.
  let afterCtrlB = false;
  let pingTimer: ReturnType<typeof setTimeout> | null = null;
  const unresponsive = () =>
    `termium: session "${o.name}" isn't responding${serverPid ? ` (pid ${serverPid})` : ""}; detached. ` +
    `\`termium kill ${o.name}\` ends it.`;
  function watchKey(ev: InputEvent): void {
    if (ev.type !== "key" || ev.event === "release") return;
    const plain = !ev.mods.alt && !ev.mods.meta;
    const ctrlKey = (k: string) => ev.mods.ctrl && plain && ev.key.toLowerCase() === k;
    const leaving = (afterCtrlB && ev.key === "d" && !ev.mods.ctrl && plain) || ctrlKey("q") || ctrlKey("c");
    afterCtrlB = ctrlKey("b");
    if (!leaving || pingTimer) return;
    send({ t: "ping" });
    pingTimer = setTimeout(() => void leave(1, unresponsive()), 3000);
  }
  let serverPid = 0;

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
  // Not the active pane: the graphics question would be answered into
  // another pane, so it isn't asked (tmux answers the others itself).
  let paneActive = !inTmux || tmuxPaneActive();
  queryCapabilities(paneActive);

  const graphicsReply = new Promise<void>((r) => (onGraphics = r));
  await Promise.race([new Promise<void>((r) => (onCapsDone = r)), Bun.sleep(1500)]);
  onCapsDone = null;
  // tmux answers the other queries itself, but the graphics one makes a
  // round trip through the outer terminal, so its reply can come last.
  if (inTmux && paneActive && !caps.graphics) await Promise.race([graphicsReply, Bun.sleep(1500)]);
  onGraphics = null;
  // tmux hands the outer terminal's answers to the pane that's active, so
  // started in another one (from a script, or as the pane loses focus), the
  // answer never comes. When tmux itself says passthrough is allowed, that
  // is no reason to refuse; what the terminal can do is found out later.
  const unanswered = inTmux && !caps.graphics && (passthrough === "on" || passthrough === "all");
  if (unanswered) caps.graphics = true;
  if (inTmux && !paneActive && !caps.graphics && passthrough === null) {
    // Can't ask, and tmux won't say: go ahead (the pictures show once the pane is active).
    caps.graphics = true;
  }
  /** Called when our pane becomes the active one (tmux answers us again). */
  let onPaneActive: (() => void) | null = null;
  if (inTmux) {
    const timer = setInterval(() => {
      const was = paneActive;
      paneActive = tmuxPaneActive();
      if (paneActive && !was) onPaneActive?.();
    }, 1000);
    timer.unref?.();
  }
  if (inTmux && placeholders && caps.graphics && process.env.TERMIUM_TMUX_FILES !== "0") {
    fileProbe = unanswered || !paneActive ? "unknown" : await probeFiles();
    fileTransport = fileProbe === "yes";
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

  /**
   * Connects once the server we started listens; null if it exited first.
   * If it exited because another server won the session's lock (two
   * termiums starting it at once), waits for that one instead.
   */
  async function waitForServer(timeoutMs = 30_000): Promise<Socket | null> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const s = await dial(paths.sock).catch(() => null);
      if (s) return s;
      if (childExit !== null && (childExit !== 3 || lockHolder(paths.lock) === null)) return null;
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
          why = readFileSync(errPath, "utf8").trim();
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
  let welcomed = false;

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
    if (!paneActive) {
      // Its answer would go to another pane: don't ask, just wait a little.
      await Bun.sleep(Math.min(timeoutMs, 300));
      return false;
    }
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
  /** tmux answers again: send the pictures once more, and see whether files work now. */
  let probing = false;
  const answeredAgain = async () => {
    if (probing) return;
    probing = true;
    if (fileProbe === "unknown" && paneActive && process.env.TERMIUM_TMUX_FILES !== "0") {
      fileProbe = await probeFiles();
      if (fileProbe === "yes") fileTransport = true;
    }
    probing = false;
    send({ t: "repaint" });
  };
  // Pictures sent while the pane wasn't active may not have arrived, and the
  // terminal couldn't be asked about files: do both now.
  onPaneActive = () => void answeredAgain();
  const pump = async () => {
    if (pumping) return;
    pumping = true;
    while (outQueue.length) {
      const { data, done } = outQueue.shift()!;
      // The pictures go first, then all the text in one write: the text
      // holds a synchronized update (?2026h ... ?2026l), and waiting in the
      // middle of one would leave tmux holding back a half-drawn pane. The
      // pictures' order among themselves (deletes before a reused id is sent
      // again) is kept.
      const apcs = data.match(/\x1b_G[^\x1b]*\x1b\\/g) ?? [];
      const text = data.replace(/\x1b_G[^\x1b]*\x1b\\/g, "");
      let acc = "";
      for (const piece of apcs) {
        if (flowOk && sent > 0 && sent + piece.length > budget()) {
          out(acc);
          acc = "";
          sent = 0;
          if (!/^\x1b_Gm=/.test(piece)) {
            // Between pictures: wait until tmux has passed everything on.
            if (!(await roundTrip(300))) {
              // No answer: tmux isn't passing anything on (pane hidden or
              // not the active one, or tmux redrawing). Stop waiting; once
              // an answer comes back, send the pictures again.
              flowOk = false;
              void (async () => {
                while (!flowOk && !leaving) {
                  if (await roundTrip(1000)) {
                    flowOk = true;
                    await answeredAgain();
                  }
                }
              })();
            } else if (fileProbe === "unknown") {
              void answeredAgain();
            }
          } else {
            await Bun.sleep(4); // within a picture: just slow down
          }
        }
        acc += piece;
        sent += piece.length;
      }
      out(acc + text, done);
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
    if (m?.t === "welcome") {
      welcomed = true;
      serverPid = Number(m.pid) || 0;
    } else if (m?.t === "pong") {
      if (pingTimer) clearTimeout(pingTimer);
      pingTimer = null;
    } else if (m?.t === "quitting") {
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
  // The server answers an attach at once (before it draws anything).
  setTimeout(() => {
    if (!welcomed) void leave(1, unresponsive().replace("; detached.", "."));
  }, 5000);

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

/**
 * Asks a session for its details: null if it isn't running (a stale
 * socket is removed), { unresponsive, pid } if it accepts the connection but
 * never answers (hung, or stopped).
 */
async function sessionInfo(name: string): Promise<any | null> {
  const p = sessionPaths(name);
  const sock = await dial(p.sock, 3000).catch(() => null);
  if (!sock) {
    // Nobody listening: a server that died without cleaning up. (Never
    // removed while a live server holds the session's lock.)
    removeStale(name);
    return null;
  }
  return new Promise((resolve) => {
    let info: any = null;
    const finish = () => {
      clearTimeout(timer);
      sock.destroy();
      resolve(info ?? { unresponsive: true, pid: lockHolder(p.lock) ?? readPid(name) });
    };
    const timer = setTimeout(finish, 3000);
    const reader = new FrameReader((f) => {
      if (f.type === 1 && f.msg?.t === "info") {
        info = f.msg;
        finish();
      }
    });
    sock.on("data", (c: Buffer) => {
      try {
        reader.push(c);
      } catch {}
    });
    sock.on("close", finish);
    sock.on("error", finish);
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
    if (info.unresponsive) rows.push([name, String(info.pid ?? "?"), "not responding", "", ""]);
    else rows.push([name, String(info.pid), info.attached ? "attached" : "detached", `${info.pages} page${info.pages === 1 ? "" : "s"}`, info.profile]);
  }
  if (rows.length === 0) {
    console.error("termium: no sessions");
    process.exit(1);
  }
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  for (const r of rows) console.log(r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!))).join("  ").trimEnd());
  process.exit(0);
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
  // The server says it's on it at once, then closes the socket once the
  // browser is stopped. No word at all: it's hung, and gets SIGKILL.
  const answered = await new Promise<boolean>((resolve) => {
    let heard = false;
    let timer = setTimeout(() => finish(false), 3000);
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      sock.destroy();
      resolve(ok);
    };
    sock.on("data", () => {
      if (heard) return;
      heard = true;
      clearTimeout(timer);
      timer = setTimeout(() => finish(true), 20_000);
    });
    sock.on("close", () => finish(heard));
    sock.on("error", () => finish(heard));
    sock.write(jsonFrame({ t: "hello", v: PROTOCOL, kind: "kill" } satisfies Hello));
  });
  if (!answered) {
    const pid = lockHolder(p.lock) ?? readPid(name);
    if (pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
      for (let i = 0; i < 40; i++) {
        try {
          process.kill(pid, 0);
        } catch {
          break;
        }
        await Bun.sleep(50);
      }
    }
    removeStale(name);
    console.error(`termium: session "${name}" wasn't responding; killed its server${pid ? ` (pid ${pid})` : ""}`);
  }
  process.exit(0);
}
