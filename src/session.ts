// Sessions: where their sockets live, and the framing spoken over them.
//
// A session is a background server process (src/server.ts) that owns the
// browser and all of termium's state. Clients (src/client.ts) attach to it
// over a Unix socket, draw what it sends and forward the terminal's input.
//
// Every message is a frame: one type byte, a 4-byte big-endian length, then
// the payload.
//   MSG_JSON    a JSON control message (both ways)
//   MSG_OUTPUT  terminal output (server to client): a 4-byte sequence
//               number, then UTF-8 text. A non-zero sequence number asks the
//               client to send {t:"ack", seq} once its terminal took the
//               text, which paces the browser's screencast.

import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockHolder } from "./browser";

/** Bumped whenever client and server stop understanding each other. */
export const PROTOCOL = 1;

export const MSG_JSON = 1;
export const MSG_OUTPUT = 2;

export const DEFAULT_SESSION = "default";

export function validSessionName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name);
}

/**
 * The directory holding session sockets: $XDG_RUNTIME_DIR/termium, else
 * termium-<uid> in the temp dir. Private to this user (0700); a fallback
 * directory someone else owns, or that others can write to, is refused.
 */
export function socketDir(): string {
  const xdg = process.env.XDG_RUNTIME_DIR;
  const uid = process.getuid?.() ?? 0;
  let dir: string;
  if (xdg && xdg.startsWith("/")) {
    dir = join(xdg, "termium");
  } else {
    // Socket paths are limited to ~107 bytes: a long TMPDIR falls back to /tmp.
    const base = tmpdir().length <= 60 ? tmpdir() : "/tmp";
    dir = join(base, `termium-${uid}`);
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.uid !== uid) throw new Error(`${dir} is not a directory of yours; refusing to use it for sessions`);
  if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
  return dir;
}

export interface SessionPaths {
  sock: string;
  /** The server's pid, for `termium ls` and tests. */
  pid: string;
  /** The server's stdout and stderr: why it failed to start. */
  err: string;
  /** Held by the session's server for its whole life (one server per name). */
  lock: string;
}

export function sessionPaths(name: string, dir = socketDir()): SessionPaths {
  return { sock: join(dir, `${name}.sock`), pid: join(dir, `${name}.pid`), err: join(dir, `${name}.err`), lock: join(dir, `${name}.lock`) };
}

/** Names of every session with a socket file, live or stale. */
export function sessionNames(dir = socketDir()): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".sock"))
      .map((f) => f.slice(0, -5))
      .filter(validSessionName)
      .sort();
  } catch {
    return [];
  }
}

/** Removes what a dead server left behind (never anything while a live server holds the lock). */
export function removeStale(name: string, dir = socketDir()): void {
  const p = sessionPaths(name, dir);
  if (lockHolder(p.lock) !== null) return;
  rmSync(p.sock, { force: true });
  rmSync(p.pid, { force: true });
  rmSync(p.lock, { force: true });
}

export function readPid(name: string, dir = socketDir()): number | null {
  try {
    const n = Number(readFileSync(sessionPaths(name, dir).pid, "utf8").trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Connects to a session's socket. Resolves to null if nothing is listening
 * there (no socket file, or a stale one); other errors reject.
 */
export function dial(path: string, timeoutMs = 2000): Promise<Socket | null> {
  if (!existsSync(path)) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const sock = connect(path);
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`the session at ${path} did not answer`));
    }, timeoutMs);
    sock.once("connect", () => {
      clearTimeout(timer);
      resolve(sock);
    });
    sock.once("error", (e: any) => {
      clearTimeout(timer);
      if (e?.code === "ENOENT" || e?.code === "ECONNREFUSED") resolve(null);
      else reject(e);
    });
  });
}

export function encodeFrame(type: number, payload: Uint8Array): Buffer {
  const head = Buffer.alloc(5);
  head[0] = type;
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

export function jsonFrame(msg: unknown): Buffer {
  return encodeFrame(MSG_JSON, Buffer.from(JSON.stringify(msg), "utf8"));
}

export function outputFrame(data: string, seq: number): Buffer {
  const text = Buffer.from(data, "utf8");
  const payload = Buffer.alloc(4 + text.length);
  payload.writeUInt32BE(seq, 0);
  text.copy(payload, 4);
  return encodeFrame(MSG_OUTPUT, payload);
}

export type Frame = { type: typeof MSG_JSON; msg: any } | { type: typeof MSG_OUTPUT; seq: number; data: string };

/** Largest frame accepted; anything bigger means the stream is garbage. */
const MAX_FRAME = 256 * 1024 * 1024;

/** Splits a byte stream into frames. */
export class FrameReader {
  private buf: Buffer = Buffer.alloc(0);

  constructor(private onFrame: (f: Frame) => void) {}

  push(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= 5) {
      const type = this.buf[0]!;
      const len = this.buf.readUInt32BE(1);
      if (len > MAX_FRAME || (type !== MSG_JSON && type !== MSG_OUTPUT) || (type === MSG_OUTPUT && len < 4)) throw new Error("bad frame from the session socket");
      if (this.buf.length < 5 + len) return;
      const payload = this.buf.subarray(5, 5 + len);
      this.buf = this.buf.subarray(5 + len);
      if (type === MSG_JSON) this.onFrame({ type, msg: JSON.parse(payload.toString("utf8")) });
      else this.onFrame({ type, seq: payload.readUInt32BE(0), data: payload.subarray(4).toString("utf8") });
    }
  }
}
