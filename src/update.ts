// "A newer termium release is available": a check against termium's own
// GitHub releases, and the self-update that replaces the binary.
//
// The session server checks in the background when an interactive terminal
// attaches (a cached newer tag is reported at once) and caches the answer
// in the state directory; `termium check-update` checks now and
// `termium update` updates from the shell. Only a `termium/<version>`
// User-Agent is sent. Updating downloads this platform's release archive,
// checks it against the release's SHA256SUMS and swaps the binary in place.

import { randomBytes, createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { lockFile, unlockFile } from "./browser";

const REPO = "alimohammed1624/termium";
/** Redirects to `…/releases/tag/<latest tag>`. */
export const LATEST_URL = `https://github.com/${REPO}/releases/latest`;
/** Fallback: JSON with `tag_name`. */
export const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
/** Release downloads: `<base>/<tag>/<asset>`. */
export const DOWNLOAD_BASE = `https://github.com/${REPO}/releases/download`;
export const UPGRADE_CMD = `curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | sh`;
/** Test-only override of the release URL (undocumented). */
export const URL_ENV = "TERMIUM_UPDATE_URL";
/** Test-only override of DOWNLOAD_BASE (undocumented). */
export const DOWNLOAD_ENV = "TERMIUM_UPDATE_DOWNLOAD_URL";
/** A running session checks again once its last check is this old. */
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 3000;
/** A whole download (archive or checksums). */
const DOWNLOAD_TIMEOUT_MS = 120_000;

// ------------------------------------------------------------ versions

/** `X.Y.Z` with an optional `v`; pre-releases (`-…`) and anything else are null. `+build` is ignored. */
export function parseVersion(s: string): [number, number, number] | null {
  let v = s.trim();
  if (v.startsWith("v") || v.startsWith("V")) v = v.slice(1);
  v = v.split("+")[0]!;
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  const n = [Number(m[1]), Number(m[2]), Number(m[3])] as [number, number, number];
  return n.every(Number.isSafeInteger) ? n : null;
}

/** `latest` is a stable release newer than `current`. */
export function isNewer(latest: string | null | undefined, current: string): boolean {
  const l = latest ? parseVersion(latest) : null;
  const c = parseVersion(current);
  if (!l || !c) return false;
  for (let i = 0; i < 3; i++) if (l[i] !== c[i]) return l[i]! > c[i]!;
  return false;
}

/** `v1.2.3` → `1.2.3`. */
export function displayVersion(tag: string): string {
  const t = tag.trim();
  return t.startsWith("v") || t.startsWith("V") ? t.slice(1) : t;
}

/** The tag in a `Location` header such as `https://github.com/o/r/releases/tag/v0.2.0`. */
export function tagFromLocation(loc: string): string | null {
  const i = loc.indexOf("/releases/tag/");
  if (i < 0) return null;
  const tag = loc.slice(i + "/releases/tag/".length).split(/[?#/]/)[0]!.trim();
  if (!tag) return null;
  try {
    return decodeURIComponent(tag);
  } catch {
    return tag;
  }
}

// ------------------------------------------------------------ opt-outs

/** An environment variable that is set to something other than "", "0" or "false". */
export function envOn(v: string | undefined): boolean {
  return v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";
}

/**
 * Whether the background check runs: `--no-update-check`,
 * TERMIUM_NO_UPDATE_CHECK and CI each turn it off; nothing turns it back on.
 * (termium has no config file.)
 */
export function checkEnabled(noFlag: boolean, env: Record<string, string | undefined> = process.env): boolean {
  return !noFlag && !envOn(env.TERMIUM_NO_UPDATE_CHECK) && !envOn(env.CI);
}

// ------------------------------------------------------------ cache

/** `update-check.json` in the state directory. */
export interface Cache {
  /** Unix seconds of the last check. */
  checked_at: number;
  /** Latest stable release tag seen, if any. */
  latest: string | null;
  /** A release the user chose not to be asked about again. */
  skipped: string | null;
}

export function cachePath(stateDir: string): string {
  return join(stateDir, "update-check.json");
}

export function loadCache(path: string): Cache | null {
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    if (!j || typeof j !== "object") return null;
    return {
      checked_at: Number.isFinite(j.checked_at) ? Number(j.checked_at) : 0,
      latest: typeof j.latest === "string" ? j.latest : null,
      skipped: typeof j.skipped === "string" ? j.skipped : null,
    };
  } catch {
    return null;
  }
}

/** Written whole (temporary file, renamed into place), readable only by us. */
export function saveCache(path: string, c: Cache): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writePrivate(path, JSON.stringify(c) + "\n");
}

/** Writes `text` to `path` (0600) by renaming a temporary file over it. */
export function writePrivate(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    const data = Buffer.from(text, "utf8");
    for (let off = 0; off < data.length; ) off += writeSync(fd, data, off);
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw e;
  }
  closeSync(fd);
  try {
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** The cached tag, when it is newer than `current`. */
export function cachedNewer(c: Cache | null, current: string): string | null {
  return c?.latest && isNewer(c.latest, current) ? c.latest : null;
}

/**
 * Changes the cache: read, changed by `change`, written back, all under a
 * lock beside it, so termiums doing this at once (sessions, check-update)
 * never lose each other's fields.
 */
export function updateCache(path: string, change: (c: Cache) => Cache): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.lock`;
  let held = false;
  for (const end = Date.now() + 5000; !held && Date.now() < end; ) {
    held = lockFile(lock) === null;
    if (!held) Bun.sleepSync(10);
  }
  if (!held) throw new Error("the update cache is locked by another termium");
  try {
    saveCache(path, change(loadCache(path) ?? { checked_at: 0, latest: null, skipped: null }));
  } finally {
    unlockFile(lock);
  }
}

/** Records that the user does not want to be asked about `tag` again. */
export function skipVersion(path: string, tag: string): void {
  updateCache(path, (c) => ({ ...c, skipped: tag }));
}

// ------------------------------------------------------------ the check

/** Where to ask: the override (one or more URLs, space-separated), or GitHub with its API as fallback. */
export function sources(env: Record<string, string | undefined> = process.env): string[] {
  const o = env[URL_ENV]?.trim();
  return o ? o.split(/\s+/) : [LATEST_URL, API_URL];
}

function describe(e: any, what = "GitHub"): string {
  if (e?.name === "TimeoutError") return `no answer within ${TIMEOUT_MS / 1000} s`;
  if (e?.name === "AbortError") return "stopped";
  const code = String(e?.code ?? "");
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ECONNRESET|ConnectionRefused|FailedToOpenSocket/i.test(code)) {
    return `cannot connect to ${what}`;
  }
  return String(e?.message ?? e).split("\n")[0]!;
}

function headers(version: string): Record<string, string> {
  return { "User-Agent": `termium/${version}`, Accept: "application/json, */*" };
}

/** Asks one source: a redirect's `Location` tag, else JSON `tag_name`. */
async function ask(url: string, version: string, signal: AbortSignal): Promise<string> {
  let resp: Response;
  try {
    resp = await fetch(url, { redirect: "manual", headers: headers(version), signal });
  } catch (e) {
    throw new Error(describe(signal.aborted ? signal.reason : e));
  }
  if (resp.status >= 300 && resp.status < 400) {
    void resp.body?.cancel().catch(() => {});
    const tag = tagFromLocation(resp.headers.get("location") ?? "");
    if (!tag) throw new Error("no release found");
    return tag;
  }
  if (!resp.ok) {
    void resp.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${resp.status}`);
  }
  let j: any;
  try {
    j = await resp.json();
  } catch (e: any) {
    throw new Error(signal.aborted ? describe(signal.reason) : "unexpected response");
  }
  if (typeof j?.tag_name !== "string" || !j.tag_name) throw new Error("unexpected response");
  return j.tag_name;
}

/**
 * The latest release tag, trying each source in turn, all within one 3 s
 * deadline. `stop` aborts it early (the terminal went away).
 */
export async function fetchLatest(version: string, stop?: AbortSignal): Promise<string> {
  const deadline = AbortSignal.timeout(TIMEOUT_MS);
  const signal = stop ? AbortSignal.any([deadline, stop]) : deadline;
  let err = "no source";
  for (const url of sources()) {
    if (signal.aborted) break;
    try {
      return await ask(url, version, signal);
    } catch (e: any) {
      err = e?.message ?? String(e);
    }
  }
  if (signal.aborted) err = describe(signal.reason);
  throw new Error(err);
}

export type CheckResult = { ok: true; tag: string } | { ok: false; error: string };

/**
 * Checks now and records the answer (and the time) in the cache. A failed
 * check keeps the previously seen tag; a pre-release is never recorded.
 */
export async function checkAndCache(path: string | null, version: string, stop?: AbortSignal): Promise<CheckResult> {
  let r: CheckResult;
  try {
    r = { ok: true, tag: await fetchLatest(version, stop) };
  } catch (e: any) {
    r = { ok: false, error: e?.message ?? String(e) };
  }
  // Stopped (nobody to tell any more): nothing is recorded.
  if (stop?.aborted) return { ok: false, error: "stopped" };
  if (path) {
    try {
      updateCache(path, (prev) => ({
        ...prev,
        checked_at: Math.floor(Date.now() / 1000),
        latest: r.ok && parseVersion(r.tag) ? r.tag : prev.latest,
      }));
    } catch {}
  }
  return r;
}

/** The one line `termium check-update` prints, and its exit status (0 up to date, 100 available, 1 failed). */
export function report(r: CheckResult, current: string): { line: string; code: number } {
  if (!r.ok) return { line: `could not check for updates: ${r.error}`, code: 1 };
  if (isNewer(r.tag, current)) {
    return {
      line: `termium ${displayVersion(r.tag)} is available (you have ${current}) — upgrade: termium update, or ${UPGRADE_CMD}`,
      code: 100,
    };
  }
  return { line: `termium ${current} is up to date`, code: 0 };
}

// ------------------------------------------------------------ the binary

/** "gnu" or "musl": the C library this (Linux) binary runs on. */
export function detectLibc(exe = process.execPath): "gnu" | "musl" {
  // The ELF interpreter the running binary names sits in its first few KB.
  try {
    const fd = openSync(exe, "r");
    const buf = Buffer.alloc(16 * 1024);
    const n = (() => {
      try {
        return readSync(fd, buf, 0, buf.length, 0);
      } finally {
        closeSync(fd);
      }
    })();
    const head = buf.subarray(0, n).toString("latin1");
    if (head.includes("/ld-musl-")) return "musl";
    if (/\/ld-linux[-\w.]*\.so/.test(head)) return "gnu";
  } catch {}
  try {
    if (readdirSync("/lib").some((f) => f.startsWith("ld-musl-")) && !existsSync("/lib64/ld-linux-x86-64.so.2")) return "musl";
  } catch {}
  return "gnu";
}

/** The release asset target for a platform, null where no prebuilt binary exists. */
export function targetFor(platform: string, arch: string, libc: "gnu" | "musl" = "gnu"): string | null {
  const a = arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : null;
  if (!a) return null;
  if (platform === "linux") return `${a}-unknown-linux-${libc}`;
  if (platform === "darwin") return `${a}-apple-darwin`;
  return null;
}

export function assetTarget(): string | null {
  return targetFor(process.platform, process.arch, process.platform === "linux" ? detectLibc() : "gnu");
}

/** The SHA-256 (lowercase hex) SHA256SUMS lists for `name`. */
export function sumFor(sums: string, name: string): string | null {
  for (const line of sums.split("\n")) {
    const m = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (m && m[2]!.trim() === name) return m[1]!.toLowerCase();
  }
  return null;
}

export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** The `termium` binary inside a release archive (`termium-<target>/termium`, tar.gz). */
export function extractBinary(archive: Uint8Array, target: string): Uint8Array {
  const want = `termium-${target}/termium`;
  let tar: Buffer;
  try {
    tar = gunzipSync(archive);
  } catch (e: any) {
    throw new Error(`bad archive: ${e?.message ?? e}`);
  }
  const str = (b: Buffer) => {
    const z = b.indexOf(0);
    return b.subarray(0, z < 0 ? b.length : z).toString("utf8");
  };
  const octal = (b: Buffer): number => {
    if (b[0]! & 0x80) {
      // GNU base-256 for big sizes.
      let n = 0;
      for (let i = 1; i < b.length; i++) n = n * 256 + b[i]!;
      return n;
    }
    const s = str(b).trim();
    return s ? parseInt(s, 8) : 0;
  };
  let off = 0;
  let longName: string | null = null;
  let paxPath: string | null = null;
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    const size = octal(h.subarray(124, 136));
    if (!Number.isFinite(size) || size < 0) throw new Error("bad archive: corrupt header");
    const type = String.fromCharCode(h[156]!);
    const ustar = h.subarray(257, 262).toString("latin1") === "ustar";
    let name = str(h.subarray(0, 100));
    if (ustar) {
      const prefix = str(h.subarray(345, 500));
      if (prefix) name = `${prefix}/${name}`;
    }
    const dataStart = off + 512;
    if (dataStart + size > tar.length) throw new Error("bad archive: truncated");
    const data = tar.subarray(dataStart, dataStart + size);
    off = dataStart + Math.ceil(size / 512) * 512;
    if (type === "L") {
      longName = str(data);
      continue;
    }
    if (type === "x") {
      for (const rec of data.toString("utf8").split("\n")) {
        const m = rec.match(/^\d+ path=(.*)$/);
        if (m) paxPath = m[1]!;
      }
      continue;
    }
    if (type === "g") continue;
    const path = (paxPath ?? longName ?? name).replace(/^\.\//, "");
    longName = paxPath = null;
    if ((type === "0" || type === "\0") && path === want) return new Uint8Array(data);
  }
  throw new Error(`${want} is not in the archive`);
}

/** Running as a compiled release binary (bun build --compile), not from source. */
export function compiledBinary(main = Bun.main): boolean {
  return main.startsWith("/$bunfs") || main.startsWith("B:/~BUN") || main.startsWith("B:\\~BUN");
}

/** The running binary's real path (symlinks resolved): what an update replaces. */
export function currentExe(): string {
  try {
    return realpathSync(process.execPath);
  } catch (e: any) {
    throw new Error(`cannot find the termium binary: ${e?.message ?? e}`);
  }
}

/** Why this termium can't update itself, or null if it can. */
export function selfUpdateBlocker(exe?: string): string | null {
  if (!compiledBinary()) {
    return `this termium runs from source (with Bun), not as a release binary; update it with git pull, or bun install -g github:${REPO}`;
  }
  if (!assetTarget()) return `there is no prebuilt termium for ${process.platform}/${process.arch}`;
  let path: string;
  try {
    path = exe ?? currentExe();
  } catch (e: any) {
    return e?.message ?? String(e);
  }
  try {
    accessSync(dirname(path), constants.W_OK);
  } catch {
    return `can't write to ${dirname(path)}, where termium is installed`;
  }
  return null;
}

/**
 * Replaces `exe` with `bin`: written to a temporary file beside it, synced
 * and made executable, then renamed over it, so `exe` is never half-written.
 * `check` may inspect the staged file first (throwing leaves `exe` alone).
 */
export function installBinary(bin: Uint8Array, exe: string, check?: (staged: string) => void): void {
  const dir = dirname(exe);
  const tmp = join(dir, `.termium-update-${randomBytes(8).toString("hex")}`);
  try {
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o700);
    try {
      for (let off = 0; off < bin.length; ) off += writeSync(fd, bin, off);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o755);
    check?.(tmp);
    renameSync(tmp, exe);
  } catch (e: any) {
    rmSync(tmp, { force: true });
    if (!e?.code) throw e;
    throw new Error(`cannot replace the termium binary: ${e.message}`);
  }
  // The rename itself, durably (best effort).
  try {
    const d = openSync(dir, "r");
    try {
      fsyncSync(d);
    } finally {
      closeSync(d);
    }
  } catch {}
}

/** A self-update step, for the progress line. */
export type Step = "downloading" | "verifying" | "installing";

async function download(url: string, version: string): Promise<Uint8Array> {
  let resp: Response;
  try {
    resp = await fetch(url, { headers: headers(version), signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (e: any) {
    throw new Error(e?.name === "TimeoutError" ? "download timed out" : `download failed: ${describe(e, "the download server")}`);
  }
  if (!resp.ok) {
    void resp.body?.cancel().catch(() => {});
    throw new Error(`download failed: HTTP ${resp.status}`);
  }
  try {
    return new Uint8Array(await resp.arrayBuffer());
  } catch (e: any) {
    throw new Error(e?.name === "TimeoutError" ? "download timed out" : `download failed: ${describe(e, "the download server")}`);
  }
}

/** ELF e_machine / Mach-O cputype of termium's release targets. */
const ELF_MACHINE: Record<string, number> = { x64: 0x3e, arm64: 0xb7 };
const MACHO_CPU: Record<string, number> = { x64: 0x01000007, arm64: 0x0100000c };

/**
 * Why `bin` isn't a termium binary for this machine (null if it looks like
 * one): a native 64-bit executable for `platform`/`arch` (ELF on Linux,
 * Mach-O on macOS), and of about the size of `refSize` (the running one).
 */
export function nativeProblem(bin: Uint8Array, platform: string, arch: string, refSize: number): string | null {
  const b = Buffer.from(bin.buffer, bin.byteOffset, bin.byteLength);
  if (b.length < 64) return "it is not an executable";
  if (platform === "linux") {
    if (b.readUInt32BE(0) !== 0x7f454c46) return "it is not an ELF executable";
    if (b[4] !== 2 || b[5] !== 1) return "it is not a 64-bit little-endian ELF executable";
    const type = b.readUInt16LE(16);
    if (type !== 2 && type !== 3) return "it is not an ELF executable";
    if (b.readUInt16LE(18) !== ELF_MACHINE[arch]) return `it is not built for ${arch}`;
  } else if (platform === "darwin") {
    if (b.readUInt32LE(0) !== 0xfeedfacf) return "it is not a 64-bit Mach-O executable";
    if (b.readUInt32LE(4) !== MACHO_CPU[arch]) return `it is not built for ${arch}`;
    if (b.readUInt32LE(12) !== 2) return "it is not a Mach-O executable";
  } else {
    return `there is no prebuilt termium for ${platform}`;
  }
  if (refSize > 0 && (b.length < refSize / 3 || b.length > refSize * 3)) {
    return `its size (${Math.round(b.length / 1e6)} MB) is far from this termium's (${Math.round(refSize / 1e6)} MB)`;
  }
  return null;
}

/** Runs a staged binary's --version: it must run here and be the release we asked for. */
function checkRuns(staged: string, tag: string): void {
  const r = Bun.spawnSync([staged, "--version"], { stdout: "pipe", stderr: "ignore", timeout: 20_000 });
  const got = r.stdout.toString().trim();
  if (r.exitCode !== 0 || !got) throw new Error("the downloaded termium doesn't run on this machine; nothing was changed");
  if (got !== `termium ${displayVersion(tag)}`) throw new Error(`the downloaded termium says "${got}", not termium ${displayVersion(tag)}; nothing was changed`);
}

/** The version a termium binary reports (`termium X.Y.Z`), or null. */
export function binaryVersion(exe: string): string | null {
  try {
    const r = Bun.spawnSync([exe, "--version"], { stdout: "pipe", stderr: "ignore", timeout: 20_000 });
    const m = r.stdout.toString().trim().match(/^termium (\S+)$/);
    return r.exitCode === 0 && m ? m[1]! : null;
  } catch {
    return null;
  }
}

/** Takes lock file `path`, waiting for another holder up to `timeoutMs`; returns the release. */
export async function waitLock(path: string, timeoutMs = 180_000): Promise<() => void> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (lockFile(path) === null) return () => unlockFile(path);
    if (Date.now() > end) throw new Error("another termium update is still running; nothing was changed");
    await Bun.sleep(100);
  }
}

class AlreadyInstalled extends Error {
  constructor(readonly version: string) {
    super(`termium ${version} is already installed`);
  }
}

/**
 * Puts `bin` (release `tag`) in place of `exe`: under a lock next to it,
 * so updaters never interleave, and never over a binary that is already
 * that release or newer (another updater got there first). Returns the
 * version installed afterwards.
 */
export async function installRelease(bin: Uint8Array, exe: string, tag: string, check = checkRuns): Promise<string> {
  const release = await waitLock(join(dirname(exe), ".termium-update.lock"));
  try {
    installBinary(bin, exe, (staged) => {
      check(staged, tag);
      // Just before the rename: what's there now?
      const now = binaryVersion(exe);
      if (now && !isNewer(tag, now)) throw new AlreadyInstalled(now);
    });
    return displayVersion(tag);
  } catch (e) {
    if (e instanceof AlreadyInstalled) return e.version;
    throw e;
  } finally {
    release();
  }
}

/**
 * Downloads release `tag` for this platform, verifies it and replaces the
 * running binary (unless that's already that release or newer). `step` is
 * told each step as it starts. Returns the version installed afterwards.
 */
export async function selfUpdate(tag: string, version: string, step: (s: Step) => void = () => {}): Promise<string> {
  const blocker = selfUpdateBlocker();
  if (blocker) throw new Error(blocker);
  const target = assetTarget()!;
  const exe = currentExe();
  const base = (process.env[DOWNLOAD_ENV]?.trim() || DOWNLOAD_BASE).replace(/\/+$/, "");
  const asset = `termium-${target}.tar.gz`;
  step("downloading");
  const sums = await download(`${base}/${tag}/SHA256SUMS`, version);
  const archive = await download(`${base}/${tag}/${asset}`, version);
  step("verifying");
  const want = sumFor(Buffer.from(sums).toString("utf8"), asset);
  if (!want) throw new Error(`SHA256SUMS has no entry for ${asset}`);
  if (sha256Hex(archive) !== want) throw new Error(`${asset} does not match its SHA-256 in SHA256SUMS; nothing was changed`);
  const bin = extractBinary(archive, target);
  // Never run (nor install) anything but a native termium for this machine.
  let refSize = 0;
  try {
    refSize = statSync(exe).size;
  } catch {}
  const problem = nativeProblem(bin, process.platform, process.arch, refSize);
  if (problem) throw new Error(`${asset} doesn't hold a termium binary for this machine (${problem}); nothing was changed`);
  step("installing");
  return installRelease(bin, exe, tag);
}

export function stepLabel(s: Step): string {
  return s === "downloading" ? "downloading…" : s === "verifying" ? "verifying…" : "installing…";
}
