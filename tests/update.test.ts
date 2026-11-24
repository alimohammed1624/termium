import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { wrapWords } from "../src/app";
import { lockFile, unlockFile } from "../src/browser";
import { restoreConflict, readRestore, takeRestore, writeRestore, type Restore } from "../src/session";
import {
  UPGRADE_CMD,
  cachedNewer,
  checkAndCache,
  checkEnabled,
  displayVersion,
  envOn,
  binaryVersion,
  extractBinary,
  installBinary,
  installRelease,
  nativeProblem,
  updateCache,
  isNewer,
  loadCache,
  parseVersion,
  report,
  saveCache,
  sha256Hex,
  skipVersion,
  sources,
  sumFor,
  tagFromLocation,
  targetFor,
} from "../src/update";

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "termium-upd-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test("versions compare numerically; pre-releases never count", () => {
  expect(parseVersion("v0.2.0")).toEqual([0, 2, 0]);
  expect(parseVersion("0.2.0")).toEqual([0, 2, 0]);
  expect(parseVersion(" V1.2.3+build.5 ")).toEqual([1, 2, 3]);
  expect(parseVersion("v1.2")).toBeNull();
  expect(parseVersion("v1.2.3.4")).toBeNull();
  expect(parseVersion("latest")).toBeNull();
  expect(parseVersion("v0.2.0-rc.1")).toBeNull();
  expect(isNewer("v0.2.0", "0.1.0")).toBe(true);
  expect(isNewer("0.1.1", "0.1.0")).toBe(true);
  expect(isNewer("v0.10.0", "0.9.9")).toBe(true); // numeric, not lexical
  expect(isNewer("v1.0.0", "0.99.99")).toBe(true);
  expect(isNewer("v0.1.0", "0.1.0")).toBe(false);
  expect(isNewer("v0.1.0+meta", "0.1.0")).toBe(false);
  expect(isNewer("v0.0.9", "0.1.0")).toBe(false);
  expect(isNewer("v0.2.0-rc.1", "0.1.0")).toBe(false);
  expect(isNewer("v9.0.0-beta", "0.1.0")).toBe(false);
  expect(isNewer("garbage", "0.1.0")).toBe(false);
  expect(isNewer(null, "0.1.0")).toBe(false);
  expect(displayVersion("v0.2.0")).toBe("0.2.0");
  expect(displayVersion("0.2.0")).toBe("0.2.0");
});

test("the tag comes from the release redirect", () => {
  expect(tagFromLocation("https://github.com/alimohammed1624/termium/releases/tag/v0.2.0")).toBe("v0.2.0");
  expect(tagFromLocation("/alimohammed1624/termium/releases/tag/v1.0.0?x=1")).toBe("v1.0.0");
  expect(tagFromLocation("https://github.com/o/r/releases/tag/v1.0.0/")).toBe("v1.0.0");
  expect(tagFromLocation("https://github.com/o/r/releases/tag/v1.0.0#x")).toBe("v1.0.0");
  // No releases yet: GitHub redirects to the release list.
  expect(tagFromLocation("https://github.com/alimohammed1624/termium/releases")).toBeNull();
  expect(tagFromLocation("https://github.com/o/r/releases/tag/")).toBeNull();
  expect(tagFromLocation("")).toBeNull();
});

test("opt-outs: the flag, TERMIUM_NO_UPDATE_CHECK and CI; empty, 0 and false don't count", () => {
  expect(checkEnabled(false, {})).toBe(true);
  expect(checkEnabled(true, {})).toBe(false);
  expect(checkEnabled(false, { TERMIUM_NO_UPDATE_CHECK: "1" })).toBe(false);
  expect(checkEnabled(false, { TERMIUM_NO_UPDATE_CHECK: "yes" })).toBe(false);
  expect(checkEnabled(false, { CI: "true" })).toBe(false);
  expect(checkEnabled(false, { CI: "1" })).toBe(false);
  expect(checkEnabled(false, { TERMIUM_NO_UPDATE_CHECK: "", CI: "" })).toBe(true);
  expect(checkEnabled(false, { TERMIUM_NO_UPDATE_CHECK: "0", CI: "false" })).toBe(true);
  expect(checkEnabled(false, { CI: "FALSE" })).toBe(true);
  expect(envOn(undefined)).toBe(false);
});

test("the check asks the override alone, else GitHub then its API", () => {
  expect(sources({})).toEqual([
    "https://github.com/alimohammed1624/termium/releases/latest",
    "https://api.github.com/repos/alimohammed1624/termium/releases/latest",
  ]);
  expect(sources({ TERMIUM_UPDATE_URL: " http://127.0.0.1:1/latest " })).toEqual(["http://127.0.0.1:1/latest"]);
  expect(sources({ TERMIUM_UPDATE_URL: " " }).length).toBe(2);
});

test("the cache is private, keeps what a skip doesn't touch, and reads old or odd files", () => {
  const dir = tempDir();
  const p = join(dir, "state", "update-check.json");
  saveCache(p, { checked_at: 42, latest: "v0.3.0", skipped: null });
  expect(loadCache(p)).toEqual({ checked_at: 42, latest: "v0.3.0", skipped: null });
  expect(statSync(p).mode & 0o777).toBe(0o600);
  skipVersion(p, "v0.3.1");
  expect(loadCache(p)).toEqual({ checked_at: 42, latest: "v0.3.0", skipped: "v0.3.1" });
  expect(statSync(p).mode & 0o777).toBe(0o600);
  // Only the cache file: no temporary files left behind.
  expect(readdirSync(join(dir, "state"))).toEqual(["update-check.json"]);
  writeFileSync(p, `{"checked_at":1794748031,"latest":"v0.2.1"}`);
  expect(loadCache(p)).toEqual({ checked_at: 1794748031, latest: "v0.2.1", skipped: null });
  writeFileSync(p, "not json");
  expect(loadCache(p)).toBeNull();
  expect(loadCache(join(dir, "missing.json"))).toBeNull();
  expect(cachedNewer({ checked_at: 0, latest: "v0.3.0", skipped: null }, "0.2.0")).toBe("v0.3.0");
  expect(cachedNewer({ checked_at: 0, latest: "v0.3.0", skipped: null }, "0.3.0")).toBeNull();
  expect(cachedNewer(null, "0.3.0")).toBeNull();
});

test("a check against a local server: redirect, API fallback shape, failures keep the cached tag", async () => {
  let mode = "redirect";
  const seen: string[] = [];
  const srv = Bun.serve({
    port: 0,
    fetch(req) {
      seen.push(req.headers.get("user-agent") ?? "");
      if (mode === "redirect") return new Response(null, { status: 302, headers: { Location: "https://github.com/o/r/releases/tag/v0.9.0" } });
      if (mode === "json") return Response.json({ tag_name: "v0.9.1" });
      if (mode === "pre") return new Response(null, { status: 302, headers: { Location: "/o/r/releases/tag/v1.0.0-rc.1" } });
      return new Response("nope", { status: 500 });
    },
  });
  const old = process.env.TERMIUM_UPDATE_URL;
  process.env.TERMIUM_UPDATE_URL = `http://127.0.0.1:${srv.port}/latest`;
  try {
    const p = join(tempDir(), "update-check.json");
    expect(await checkAndCache(p, "0.3.0")).toEqual({ ok: true, tag: "v0.9.0" });
    expect(seen[0]).toBe("termium/0.3.0");
    expect(loadCache(p)?.latest).toBe("v0.9.0");
    mode = "json";
    expect(await checkAndCache(p, "0.3.0")).toEqual({ ok: true, tag: "v0.9.1" });
    expect(loadCache(p)?.latest).toBe("v0.9.1");
    // A pre-release is never recorded.
    mode = "pre";
    expect(await checkAndCache(p, "0.3.0")).toEqual({ ok: true, tag: "v1.0.0-rc.1" });
    expect(loadCache(p)?.latest).toBe("v0.9.1");
    mode = "error";
    const before = loadCache(p)!.checked_at;
    expect(await checkAndCache(p, "0.3.0")).toEqual({ ok: false, error: "HTTP 500" });
    expect(loadCache(p)?.latest).toBe("v0.9.1");
    expect(loadCache(p)!.checked_at).toBeGreaterThanOrEqual(before);
  } finally {
    if (old === undefined) delete process.env.TERMIUM_UPDATE_URL;
    else process.env.TERMIUM_UPDATE_URL = old;
    srv.stop(true);
  }
});

test("check-update's line and exit status", () => {
  expect(report({ ok: true, tag: "v0.3.0" }, "0.3.0")).toEqual({ line: "termium 0.3.0 is up to date", code: 0 });
  expect(report({ ok: true, tag: "v0.2.0" }, "0.3.0")).toEqual({ line: "termium 0.3.0 is up to date", code: 0 });
  expect(report({ ok: true, tag: "v0.4.0-rc.1" }, "0.3.0").code).toBe(0);
  expect(report({ ok: true, tag: "v0.4.0" }, "0.3.0")).toEqual({
    line: `termium 0.4.0 is available (you have 0.3.0) — upgrade: termium update, or ${UPGRADE_CMD}`,
    code: 100,
  });
  expect(report({ ok: false, error: "no answer within 3 s" }, "0.3.0")).toEqual({
    line: "could not check for updates: no answer within 3 s",
    code: 1,
  });
});

test("release targets match install.sh", () => {
  expect(targetFor("linux", "x64", "gnu")).toBe("x86_64-unknown-linux-gnu");
  expect(targetFor("linux", "arm64", "gnu")).toBe("aarch64-unknown-linux-gnu");
  expect(targetFor("linux", "x64", "musl")).toBe("x86_64-unknown-linux-musl");
  expect(targetFor("linux", "arm64", "musl")).toBe("aarch64-unknown-linux-musl");
  expect(targetFor("darwin", "x64")).toBe("x86_64-apple-darwin");
  expect(targetFor("darwin", "arm64")).toBe("aarch64-apple-darwin");
  expect(targetFor("win32", "x64")).toBeNull();
  expect(targetFor("linux", "riscv64")).toBeNull();
});

test("SHA256SUMS lines", () => {
  const h = "3264b4640f7bb0d03996b976acfbb33735db0e4af62fd76ddfa8fb4e96249d6a";
  const sums = `${"d".repeat(64)}  termium-aarch64-apple-darwin.tar.gz\n${h.toUpperCase()}  termium-x86_64-unknown-linux-gnu.tar.gz\n`;
  expect(sumFor(sums, "termium-x86_64-unknown-linux-gnu.tar.gz")).toBe(h);
  expect(sumFor(`${h} *a.tar.gz`, "a.tar.gz")).toBe(h); // sha256sum -b
  expect(sumFor(sums, "termium-x86_64-apple-darwin.tar.gz")).toBeNull();
  expect(sumFor("nothex  a.tar.gz", "a.tar.gz")).toBeNull();
  expect(sha256Hex(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

/** A tar.gz made by the real tar, laid out as release.yml packages it. */
function releaseArchive(target: string, body: string, extra: string[] = []): Uint8Array {
  const dir = tempDir();
  const name = `termium-${target}`;
  mkdirSync(join(dir, "pkg", name), { recursive: true });
  writeFileSync(join(dir, "pkg", name, "termium"), body);
  chmodSync(join(dir, "pkg", name, "termium"), 0o755);
  for (const f of ["README.md", "LICENSE", "CHANGELOG.md", ...extra]) writeFileSync(join(dir, "pkg", name, f), `${f}\n`);
  const r = Bun.spawnSync(["tar", "-C", join(dir, "pkg"), "--owner=0", "--group=0", "--numeric-owner", "-czf", join(dir, "a.tar.gz"), name]);
  expect(r.exitCode).toBe(0);
  return readFileSync(join(dir, "a.tar.gz"));
}

test("the binary comes out of a release archive", () => {
  const target = "x86_64-unknown-linux-gnu";
  const big = "#!/bin/sh\n" + "x".repeat(200_000);
  const gz = releaseArchive(target, big, ["a-file-with-a-rather-long-name-".repeat(5) + ".txt"]);
  expect(new TextDecoder().decode(extractBinary(gz, target))).toBe(big);
  expect(() => extractBinary(gz, "aarch64-apple-darwin")).toThrow(/termium-aarch64-apple-darwin\/termium is not in the archive/);
  expect(() => extractBinary(new TextEncoder().encode("not gzip"), target)).toThrow(/bad archive/);
  // Cut short, or not a tar inside.
  expect(() => extractBinary(gz.subarray(0, Math.floor(gz.length / 2)), target)).toThrow(/bad archive/);
  expect(() => extractBinary(gzipSync(Buffer.alloc(1024, 1)), target)).toThrow();
});

test("installing replaces the binary atomically and leaves nothing behind", () => {
  const dir = tempDir();
  const exe = join(dir, "termium");
  writeFileSync(exe, "old");
  chmodSync(exe, 0o755);
  installBinary(new TextEncoder().encode("new binary"), exe);
  expect(readFileSync(exe, "utf8")).toBe("new binary");
  expect(statSync(exe).mode & 0o777).toBe(0o755);
  expect(readdirSync(dir)).toEqual(["termium"]);
  // A check that refuses the staged file leaves the old binary alone, and no temporary file.
  expect(() =>
    installBinary(new TextEncoder().encode("bad"), exe, () => {
      throw new Error("doesn't run here");
    }),
  ).toThrow("doesn't run here");
  expect(readFileSync(exe, "utf8")).toBe("new binary");
  expect(readdirSync(dir)).toEqual(["termium"]);
  // An unwritable place fails cleanly.
  expect(() => installBinary(new TextEncoder().encode("x"), join(dir, "no-such-dir", "termium"))).toThrow(/cannot replace/);
  expect(readdirSync(dir)).toEqual(["termium"]);
});

test("restore files: private, read once, ignored when old", () => {
  const dir = tempDir();
  const r: Restore = {
    v: 1,
    at: Date.now(),
    from: "0.3.0",
    launch: { incognito: false, scale: null, search: "https://duckduckgo.com/?q=%s" },
    layout: {
      spaces: [{ name: "space 1", active: 0, tabs: [{ root: { dir: "h", ratio: 0.3, a: { url: "https://a.example/" }, b: { url: "" } }, focus: 1, zoomed: false }] }],
      activeSpace: 0,
      sidebar: true,
      zoom: 1,
    },
  };
  writeRestore("work", r, dir);
  expect(statSync(join(dir, "work.restore")).mode & 0o777).toBe(0o600);
  expect(readRestore("work", dir)).toEqual(r);
  expect(takeRestore("work", dir)).toEqual(r);
  expect(existsSync(join(dir, "work.restore"))).toBe(false);
  expect(takeRestore("work", dir)).toBeNull();
  writeRestore("work", { ...r, at: Date.now() - 60 * 60 * 1000 }, dir);
  expect(takeRestore("work", dir)).toBeNull();
  expect(existsSync(join(dir, "work.restore"))).toBe(false);
});

test("box text wraps at words", () => {
  expect(wrapWords("curl -fsSL https://example.com/install.sh | sh", 30)).toEqual(["curl -fsSL", "https://example.com/install.sh", "| sh"]);
  expect(wrapWords("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  expect(wrapWords("", 10)).toEqual([]);
});

/** A stand-in termium: a script that answers --version. */
function fakeTermium(version: string): Uint8Array {
  return new TextEncoder().encode(`#!/bin/sh\necho "termium ${version}"\n`);
}

test("one 3 s deadline covers every source; a stopped check records nothing", async () => {
  const srv = Bun.serve({ port: 0, idleTimeout: 30, fetch: () => new Promise<Response>((r) => setTimeout(() => r(new Response("late")), 8000)) });
  const old = process.env.TERMIUM_UPDATE_URL;
  process.env.TERMIUM_UPDATE_URL = `http://127.0.0.1:${srv.port}/a http://127.0.0.1:${srv.port}/b`;
  try {
    const p = join(tempDir(), "update-check.json");
    const t0 = performance.now();
    expect(await checkAndCache(p, "0.3.0")).toEqual({ ok: false, error: "no answer within 3 s" });
    const took = performance.now() - t0;
    expect(took).toBeLessThan(3500);
    expect(took).toBeGreaterThan(2900);
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 200);
    const p2 = join(tempDir(), "update-check.json");
    const t1 = performance.now();
    expect(await checkAndCache(p2, "0.3.0", stop.signal)).toEqual({ ok: false, error: "stopped" });
    expect(performance.now() - t1).toBeLessThan(1000);
    expect(existsSync(p2)).toBe(false);
  } finally {
    if (old === undefined) delete process.env.TERMIUM_UPDATE_URL;
    else process.env.TERMIUM_UPDATE_URL = old;
    srv.stop(true);
  }
}, 15_000);

test("an install never replaces the same release or a newer one", async () => {
  const dir = tempDir();
  const exe = join(dir, "termium");
  writeFileSync(exe, fakeTermium("0.3.2"));
  chmodSync(exe, 0o755);
  expect(binaryVersion(exe)).toBe("0.3.2");
  expect(await installRelease(fakeTermium("0.3.1"), exe, "v0.3.1", () => {})).toBe("0.3.2");
  expect(binaryVersion(exe)).toBe("0.3.2");
  expect(await installRelease(fakeTermium("0.3.2"), exe, "v0.3.2", () => {})).toBe("0.3.2");
  expect(await installRelease(fakeTermium("0.3.3"), exe, "v0.3.3", () => {})).toBe("0.3.3");
  expect(binaryVersion(exe)).toBe("0.3.3");
  expect(readdirSync(dir).sort()).toEqual(["termium"]);
});

test("installs wait for the update lock beside the binary", async () => {
  const dir = tempDir();
  const exe = join(dir, "termium");
  writeFileSync(exe, fakeTermium("0.3.0"));
  chmodSync(exe, 0o755);
  const lock = join(dir, ".termium-update.lock");
  expect(lockFile(lock)).toBeNull();
  setTimeout(() => unlockFile(lock), 400);
  const t0 = performance.now();
  expect(await installRelease(fakeTermium("0.3.1"), exe, "v0.3.1", () => {})).toBe("0.3.1");
  expect(performance.now() - t0).toBeGreaterThan(350);
  expect(binaryVersion(exe)).toBe("0.3.1");
  expect(existsSync(lock)).toBe(false);
});

test("two updaters in separate processes: the newer release wins", async () => {
  const dir = tempDir();
  const exe = join(dir, "termium");
  writeFileSync(exe, fakeTermium("0.3.0"));
  chmodSync(exe, 0o755);
  const mod = join(import.meta.dir, "..", "src", "update.ts");
  const run = (version: string, slowMs: number) =>
    Bun.spawn(
      [
        "bun",
        "-e",
        `const u = await import(${JSON.stringify(mod)});
         const bin = new TextEncoder().encode('#!/bin/sh\\necho "termium ${version}"\\n');
         console.log(await u.installRelease(bin, ${JSON.stringify(exe)}, "v${version}", () => Bun.sleepSync(${slowMs})));`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
  // The slow, older one starts first; the newer one finishes first without the lock.
  const slow = run("0.3.1", 1500);
  await Bun.sleep(300);
  const fast = run("0.3.2", 0);
  const [a, b] = await Promise.all([new Response(slow.stdout).text(), new Response(fast.stdout).text()]);
  expect(await slow.exited).toBe(0);
  expect(await fast.exited).toBe(0);
  expect(b.trim()).toBe("0.3.2");
  expect(["0.3.1", "0.3.2"]).toContain(a.trim());
  expect(binaryVersion(exe)).toBe("0.3.2");
}, 20_000);

test("only a native termium binary for this machine is accepted", () => {
  const elf = (machine: number, cls = 2, size = 100_000_000) => {
    const b = Buffer.alloc(size);
    b.writeUInt32BE(0x7f454c46, 0);
    b[4] = cls;
    b[5] = 1;
    b.writeUInt16LE(2, 16);
    b.writeUInt16LE(machine, 18);
    return new Uint8Array(b.buffer, b.byteOffset, b.length);
  };
  const macho = (cpu: number) => {
    const b = Buffer.alloc(100_000_000);
    b.writeUInt32LE(0xfeedfacf, 0);
    b.writeUInt32LE(cpu, 4);
    b.writeUInt32LE(2, 12);
    return new Uint8Array(b.buffer, b.byteOffset, b.length);
  };
  const ref = 95_000_000;
  expect(nativeProblem(elf(0x3e), "linux", "x64", ref)).toBeNull();
  expect(nativeProblem(elf(0xb7), "linux", "arm64", ref)).toBeNull();
  expect(nativeProblem(elf(0xb7), "linux", "x64", ref)).toMatch(/not built for x64/);
  expect(nativeProblem(elf(0x3e, 1), "linux", "x64", ref)).toMatch(/64-bit/);
  expect(nativeProblem(elf(0x3e, 2, 2_000_000), "linux", "x64", ref)).toMatch(/size/);
  expect(nativeProblem(new TextEncoder().encode(`#!/bin/sh\necho "termium 0.3.2"\n${" ".repeat(100)}`), "linux", "x64", ref)).toMatch(/not an ELF/);
  expect(nativeProblem(macho(0x0100000c), "darwin", "arm64", ref)).toBeNull();
  expect(nativeProblem(macho(0x01000007), "darwin", "arm64", ref)).toMatch(/not built for arm64/);
  expect(nativeProblem(elf(0x3e), "darwin", "x64", ref)).toMatch(/Mach-O/);
  // The real thing: this machine's bun is a native executable.
  const bun = readFileSync(process.execPath);
  expect(nativeProblem(bun, process.platform, process.arch, bun.length)).toBeNull();
});

test("cache changes from several processes at once never undo each other's", async () => {
  const p = join(tempDir(), "update-check.json");
  const mod = join(import.meta.dir, "..", "src", "update.ts");
  // Each process prints the last value it managed to write (a write that
  // can't get the lock in time is skipped: the cache is best effort).
  const run = (field: string, prefix: string) =>
    Bun.spawn(["bun", "-e", `const u = await import(${JSON.stringify(mod)});
      let last = "";
      for (let i = 0; i < 150; i++) if (await u.updateCache(${JSON.stringify(p)}, (c) => ({ ...c, ${field}: "${prefix}" + i }))) last = "${prefix}" + i;
      console.log(last);`], { stdout: "pipe" });
  const a = run("latest", "v1.0.");
  const b = run("skipped", "v2.0.");
  const [la, lb] = await Promise.all([new Response(a.stdout).text(), new Response(b.stdout).text()]);
  expect(await a.exited).toBe(0);
  expect(await b.exited).toBe(0);
  const c = loadCache(p)!;
  expect(la.trim()).toMatch(/^v1\.0\.\d+$/);
  expect(lb.trim()).toMatch(/^v2\.0\.\d+$/);
  expect(c.latest).toBe(la.trim());
  expect(c.skipped).toBe(lb.trim());
  expect(readdirSync(join(p, "..")).sort()).toEqual(["update-check.json"]);
}, 30_000);

test("a busy cache lock is waited for briefly, without blocking, then the write is skipped", async () => {
  const p = join(tempDir(), "update-check.json");
  saveCache(p, { checked_at: 1, latest: "v0.3.1", skipped: null });
  expect(lockFile(`${p}.lock`)).toBeNull();
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  const t0 = performance.now();
  expect(await updateCache(p, (c) => ({ ...c, latest: "v0.3.2" }), 300)).toBe(false);
  const took = performance.now() - t0;
  clearInterval(timer);
  expect(took).toBeLessThan(600);
  expect(ticks).toBeGreaterThan(10); // the event loop kept running meanwhile
  expect(loadCache(p)!.latest).toBe("v0.3.1");
  unlockFile(`${p}.lock`);
  expect(await updateCache(p, (c) => ({ ...c, latest: "v0.3.2" }))).toBe(true);
  expect(loadCache(p)!.latest).toBe("v0.3.2");
});

test("a restart snapshot reopens only under every launch option it was saved with", () => {
  const launch = { profile: "/p/a", incognito: false, scale: 1, search: "https://s/?q=%s" };
  const r: Restore = { v: 1, at: Date.now(), from: "0.3.0", launch, layout: { spaces: [], activeSpace: 0, sidebar: true, zoom: 1 } };
  expect(restoreConflict(r, { ...launch })).toBeNull();
  expect(restoreConflict(r, { ...launch, url: "https://x/" })).toBeNull(); // the URL isn't a launch option
  expect(restoreConflict(r, { ...launch, profile: undefined })).toBe("it was started with --profile /p/a");
  expect(restoreConflict(r, { ...launch, incognito: true })).toBe("it was started without --incognito");
  expect(restoreConflict(r, { ...launch, scale: 1.5 })).toBe("it was started with --scale 1");
  expect(restoreConflict(r, { ...launch, scale: null })).toBe("it was started with --scale 1");
  expect(restoreConflict(r, { ...launch, search: "https://other/?q=%s" })).toBe("it was started with --search https://s/?q=%s");
  expect(restoreConflict(r, { ...launch, browser: "/b" })).toBe("it was started without --browser");
  const inc: Restore = { ...r, launch: { incognito: true, scale: null, search: "x%s" } };
  expect(restoreConflict(inc, { incognito: true, scale: null, search: "x%s" })).toBeNull();
  expect(restoreConflict(inc, { incognito: false, scale: null, search: "x%s" })).toBe("it was started with --incognito");
});
