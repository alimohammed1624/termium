import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreConflict, savedLaunch, type Restore } from "../src/session";
import { Tunnel, proxyArgs, sshArgv, sshHost, validSshDest } from "../src/tunnel";

const dir = mkdtempSync(join(tmpdir(), "termium-tunnel-test-"));
const fake = join(dir, "ssh");
writeFileSync(fake, `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "support", "fake-ssh.ts")}" "$@"\n`);
chmodSync(fake, 0o755);
process.env.TERMIUM_SSH = fake;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const open = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = createConnection({ host: "127.0.0.1", port });
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });

test("ssh destinations: never an option, spaces or control characters", () => {
  for (const d of ["host", "me@host", "me@host.example", "ssh://me@host:2222", "alias_1"]) expect(validSshDest(d)).toBe(true);
  for (const d of ["", "-oProxyCommand=x", "a b", "a\nb", "-p"]) expect(validSshDest(d)).toBe(false);
});

test("the host shown for a destination", () => {
  expect(sshHost("devbox")).toBe("devbox");
  expect(sshHost("me@devbox")).toBe("devbox");
  expect(sshHost("ssh://me@devbox:2222")).toBe("devbox");
  expect(sshHost("ssh://[::1]:22")).toBe("::1");
});

test("browser flags send loopback through the proxy too", () => {
  expect(proxyArgs(1080)).toEqual(["--proxy-server=socks5://127.0.0.1:1080", "--proxy-bypass-list=<-loopback>"]);
});

test("ssh runs without prompts, a dynamic forward on loopback, and the destination last", () => {
  const a = sshArgv("me@devbox", 4321);
  expect(a.slice(1, 5)).toEqual(["-N", "-T", "-D", "127.0.0.1:4321"]);
  expect(a).toContain("BatchMode=yes");
  expect(a).toContain("ExitOnForwardFailure=yes");
  expect(a.at(-1)).toBe("me@devbox");
});

test("--ssh is a launch option a restart keeps and compares", () => {
  const launch = { incognito: false, scale: null, search: "x%s", ssh: "me@devbox" };
  expect(savedLaunch({ ...launch, url: "u" }).ssh).toBe("me@devbox");
  const r = { v: 1, at: Date.now(), from: "0", launch, layout: { spaces: [], activeSpace: 0, sidebar: true, zoom: 1 } } as Restore;
  expect(restoreConflict(r, launch)).toBeNull();
  expect(restoreConflict(r, { ...launch, ssh: undefined })).toBe("it was started with --ssh me@devbox");
});

test("a refused login fails the start with ssh's reason and what to do", async () => {
  const t = new Tunnel("denied", () => {});
  await expect(t.start()).rejects.toThrow(/Permission denied \(publickey\).*ssh-agent/);
  await t.stop();
});

test("the tunnel comes up on a free port, reconnects on the same port after a drop, and stops", async () => {
  process.env.FAKE_SSH_EXIT_MS = "600";
  const states: string[] = [];
  const t = new Tunnel("me@devbox", () => {}, (s) => states.push(s));
  try {
    await t.start();
    expect(t.state).toBe("up");
    const port = t.port;
    expect(await open(port)).toBe(true);
    delete process.env.FAKE_SSH_EXIT_MS; // the reconnection stays up
    for (let i = 0; i < 100 && states.length < 2; i++) await Bun.sleep(50);
    expect(states).toEqual(["down", "up"]);
    expect(t.port).toBe(port);
    expect(await open(port)).toBe(true);
  } finally {
    delete process.env.FAKE_SSH_EXIT_MS;
    await t.stop();
  }
  expect(await open(t.port)).toBe(false);
});
