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

import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockFile, pidAlive, unlockFile } from "./browser";

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

/**
 * Removes what a dead server left behind. The session's lock is taken
 * first, so a server starting at that moment (which takes it too) can't
 * have its fresh files removed from under it.
 */
export function removeStale(name: string, dir = socketDir()): void {
  const p = sessionPaths(name, dir);
  if (lockFile(p.lock) !== null) return; // a live server holds it
  try {
    rmSync(p.sock, { force: true });
    rmSync(p.pid, { force: true });
  } finally {
    unlockFile(p.lock);
  }
}

/** Where pictures go as temporary files for the terminal (kitty graphics t=t). */
export function graphicsDir(): string {
  return existsSync("/dev/shm") ? "/dev/shm" : tmpdir();
}

/** Picture files: the name must contain "tty-graphics-protocol"; then the owning client's pid. */
export const GRAPHICS_FILE_PREFIX = "termium-tty-graphics-protocol-";

/** Removes picture files of ours whose client is gone (killed before it could clean up). */
export function sweepGraphicsFiles(): void {
  const dir = graphicsDir();
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const uid = process.getuid?.();
  for (const f of names) {
    const m = f.startsWith(GRAPHICS_FILE_PREFIX) && f.slice(GRAPHICS_FILE_PREFIX.length).match(/^(\d+)-[0-9a-f]{32}$/);
    if (!m) continue;
    if (pidAlive(Number(m[1]))) continue; // its client still runs (or it's someone else's)
    try {
      const st = lstatSync(join(dir, f));
      if (st.isFile() && st.uid === uid) rmSync(join(dir, f), { force: true });
    } catch {}
  }
}

/** Removes startup-error files of clients that are gone (<name>.<pid>.err). */
export function sweepErrFiles(dir = socketDir()): void {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const f of names) {
    const m = f.match(/\.(\d+)\.err$/);
    if (!m) continue;
    if (pidAlive(Number(m[1]))) continue; // its client still runs (or it's someone else's)
    rmSync(join(dir, f), { force: true });
  }
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

/** Splits a byte stream into frames (in time linear in the bytes, however they're chunked). */
export class FrameReader {
  private buf: Buffer = Buffer.alloc(64 * 1024);
  /** Largest frame accepted now: small until the peer has said who it is (raise it then). */
  maxFrame = MAX_FRAME;
  private start = 0;
  private end = 0;

  constructor(private onFrame: (f: Frame) => void) {}

  push(chunk: Buffer): void {
    if (this.end + chunk.length > this.buf.length) {
      const used = this.end - this.start;
      if (used + chunk.length <= this.buf.length / 2) {
        this.buf.copy(this.buf, 0, this.start, this.end); // room once the consumed part is dropped
      } else {
        const grown = Buffer.alloc(Math.max(this.buf.length * 2, used + chunk.length));
        this.buf.copy(grown, 0, this.start, this.end);
        this.buf = grown;
      }
      this.start = 0;
      this.end = used;
    }
    chunk.copy(this.buf, this.end);
    this.end += chunk.length;
    while (this.end - this.start >= 5) {
      const type = this.buf[this.start]!;
      const len = this.buf.readUInt32BE(this.start + 1);
      if (len > this.maxFrame || (type !== MSG_JSON && type !== MSG_OUTPUT) || (type === MSG_OUTPUT && len < 4)) throw new Error("bad frame from the session socket");
      if (this.end - this.start < 5 + len) return;
      const payload = this.buf.subarray(this.start + 5, this.start + 5 + len);
      this.start += 5 + len;
      if (type === MSG_JSON) this.onFrame({ type, msg: JSON.parse(payload.toString("utf8")) });
      else this.onFrame({ type, seq: payload.readUInt32BE(0), data: payload.subarray(4).toString("utf8") });
    }
    if (this.start === this.end) this.start = this.end = 0;
  }
}

// ------------------------------------------------------------ restarts
//
// Restarting a session (into an updated termium) closes its browser and
// starts a new server: the old one leaves the session's layout and launch
// options in <name>.restore in the socket directory (private to this user,
// usually tmpfs), and the next server of that name reopens it and removes
// the file. Pages reload from their URLs; logins survive in the profile.

/** A pane tree as saved for a restart: leaves are page URLs ("" for a blank page). */
export type SavedNode = { url: string } | { dir: "h" | "v"; ratio: number; a: SavedNode; b: SavedNode };

export interface SavedLayout {
  spaces: { name: string; active: number; tabs: { root: SavedNode; focus: number; zoomed: boolean }[] }[];
  activeSpace: number;
  sidebar: boolean;
  zoom: number;
}

export interface Restore {
  v: 1;
  /** When it was written (ms): an old file is ignored. */
  at: number;
  /** The termium version that wrote it. */
  from: string;
  launch: { browser?: string; profile?: string; incognito: boolean; scale: number | null; search: string };
  layout: SavedLayout;
}

/** How long a restore file is good for. */
const RESTORE_MAX_AGE_MS = 10 * 60 * 1000;

export function restorePath(name: string, dir = socketDir()): string {
  return join(dir, `${name}.restore`);
}

/** The restore file for `name` if there's a recent one (left in place). */
export function readRestore(name: string, dir?: string): Restore | null {
  try {
    const r = JSON.parse(readFileSync(restorePath(name, dir), "utf8"));
    if (r?.v !== 1 || !r.layout || !Array.isArray(r.layout.spaces) || !r.launch) return null;
    if (!(Date.now() - Number(r.at) < RESTORE_MAX_AGE_MS)) return null;
    return r as Restore;
  } catch {
    return null;
  }
}

/** Reads and removes the restore file for `name` (null if none, or too old). */
export function takeRestore(name: string, dir?: string): Restore | null {
  let path: string;
  try {
    path = restorePath(name, dir);
  } catch {
    return null;
  }
  const r = readRestore(name, dir);
  rmSync(path, { force: true });
  return r;
}

/** Why `r` can't be reopened by a session started with `launch` (null if it can). */
export function restoreConflict(r: Restore, launch: { browser?: string; profile?: string; incognito: boolean }): string | null {
  if (!!r.launch.incognito !== !!launch.incognito) return r.launch.incognito ? "it was --incognito" : "it wasn't --incognito";
  if (!r.launch.incognito && (r.launch.profile ?? null) !== (launch.profile ?? null)) {
    return r.launch.profile ? `it used --profile ${r.launch.profile}` : "it used the session's own profile";
  }
  if ((r.launch.browser ?? null) !== (launch.browser ?? null)) return r.launch.browser ? `it used --browser ${r.launch.browser}` : "it used the default browser";
  return null;
}

export function writeRestore(name: string, r: Restore, dir?: string): void {
  const path = restorePath(name, dir);
  rmSync(path, { force: true });
  writeFileSync(path, JSON.stringify(r), { mode: 0o600, flag: "wx" });
}
