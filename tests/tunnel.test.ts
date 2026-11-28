import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  const a = proxyArgs(1080);
  expect(a.slice(0, 2)).toEqual(["--proxy-server=socks5://127.0.0.1:1080", "--proxy-bypass-list=<-loopback>"]);
  // No local DNS lookups, and no WebRTC UDP around the proxy.
  expect(a).toContain("--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1");
  expect(a).toContain("--force-webrtc-ip-handling-policy=disable_non_proxied_udp");
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

test("ssh that runs but never opens its proxy fails the start, and is stopped", async () => {
  const t = new Tunnel("noforward", () => {});
  t.openTimeoutMs = 700;
  await expect(t.start()).rejects.toThrow(/SOCKS proxy never opened/);
  await t.stop();
});

test("something listening on the port that isn't a SOCKS proxy isn't taken for the tunnel", async () => {
  const t = new Tunnel("plain", () => {});
  t.openTimeoutMs = 700;
  await expect(t.start()).rejects.toThrow(/SOCKS proxy never opened/);
  await t.stop();
});

test("user ssh config can't send ssh to the background or drop the forward", () => {
  const a = sshArgv("h", 1);
  expect(a).toContain("ForkAfterAuthentication=no");
  expect(a).toContain("ClearAllForwardings=no");
  expect(a.indexOf("ClearAllForwardings=no")).toBeLessThan(a.indexOf("h"));
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

test("ssh ends when the session is killed outright (SIGKILL)", async () => {
  const pidFile = join(dir, "ssh.pid");
  const script = join(dir, "holder.ts");
  writeFileSync(script, `import { Tunnel } from ${JSON.stringify(join(import.meta.dir, "..", "src", "tunnel.ts"))};\nconst t = new Tunnel("me@devbox", () => {});\nawait t.start();\nconsole.log("up");\nsetInterval(() => {}, 1000);\n`);
  const holder = Bun.spawn([process.execPath, script], { stdout: "pipe", env: { ...process.env, FAKE_SSH_PIDFILE: pidFile } });
  const reader = holder.stdout.getReader();
  await reader.read(); // "up"
  const ssh = Number(readFileSync(pidFile, "utf8"));
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  expect(alive(ssh)).toBe(true);
  holder.kill(9);
  for (let i = 0; i < 60 && alive(ssh); i++) await Bun.sleep(50);
  expect(alive(ssh)).toBe(false);
  expect(existsSync(pidFile)).toBe(true);
});
