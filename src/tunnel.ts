// SSH mode (--ssh DEST): the page is drawn here, but every request the
// browser makes goes through DEST. The session runs `ssh -N -D` (a SOCKS5
// proxy on a loopback port) for its whole life, and the browser is started
// with that proxy, loopback included: localhost:3000 is DEST's dev server.

import { createConnection, createServer } from "node:net";
import type { Subprocess } from "bun";

/** Whether `dest` may be given to ssh as its destination ([user@]host, or ssh://[user@]host[:port]). */
export function validSshDest(dest: string): boolean {
  // Never an option (ssh would take "-oProxyCommand=..." as one), nor spaces or control characters.
  return dest.length > 0 && dest.length <= 255 && !dest.startsWith("-") && !/[\s\x00-\x1f\x7f]/.test(dest);
}

/** The host part of an ssh destination, for display: "user@host" and "ssh://user@host:22" are "host". */
export function sshHost(dest: string): string {
  let d = dest.replace(/^ssh:\/\//, "");
  d = d.slice(d.lastIndexOf("@") + 1);
  if (dest.startsWith("ssh://")) d = d.replace(/:\d+\/?$/, "").replace(/^\[(.*)\]$/, "$1");
  return d || dest;
}

/** The browser flags that send all of its traffic, loopback too, through the SOCKS proxy on `port`. */
export function proxyArgs(port: number): string[] {
  return [
    // "<-loopback>" removes Chromium's implicit bypass of localhost/127.0.0.1/[::1].
    `--proxy-server=socks5://127.0.0.1:${port}`,
    "--proxy-bypass-list=<-loopback>",
    // Names resolve on the far side (SOCKS5); nothing is looked up here, not even a DNS prefetch.
    "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
    // WebRTC would otherwise send UDP (STUN, media) straight from this machine.
    // (Helium and ungoogled-chromium know the first spelling; older Chromiums the second.)
    "--webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  ];
}

/**
 * Runs a command (ssh) so that it ends when termium does, however termium
 * ends: it holds our pipe on fd 3 and is killed once that closes (termium
 * killed outright can't stop it otherwise). Its own exit status is kept.
 */
const WATCHED = [
  "sh",
  "-c",
  'exec 3<&0 </dev/null; "$@" & p=$!; (read _ <&3; kill $p 2>/dev/null) & w=$!; ' +
    "trap 'kill $p $w 2>/dev/null; wait $p; exit 143' TERM; wait $p; s=$?; kill $w 2>/dev/null; exit $s",
  "termium-ssh",
];

/** The ssh command for a tunnel to `dest` with its SOCKS proxy on 127.0.0.1:`port`. */
export function sshArgv(dest: string, port: number): string[] {
  return [
    process.env.TERMIUM_SSH || "ssh",
    "-N",
    "-T",
    "-D",
    `127.0.0.1:${port}`,
    // No terminal to ask in: a password or host-key prompt fails at once, saying why.
    "-o", "BatchMode=yes",
    // A port that can't be had is a failed start, not a tunnel without a proxy.
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ConnectTimeout=15",
    // A dead link is noticed within ~15 s (ssh exits), rather than pages hanging.
    "-o", "ServerAliveInterval=5",
    "-o", "ServerAliveCountMax=3",
    // Its own connection: a shared master would keep the forward (and hide its loss) after ssh exits.
    "-o", "ControlMaster=no",
    "-o", "ControlPath=none",
    // Settings in ~/.ssh/config that would undo the above (the first value ssh reads wins):
    // going to the background (out of termium's reach), or dropping the -D forward.
    "-o", "ForkAfterAuthentication=no",
    "-o", "ClearAllForwardings=no",
    dest,
  ];
}

/** A free TCP port on loopback (free now; ssh's ExitOnForwardFailure catches losing a race for it). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

/** Whether a SOCKS5 proxy answers on loopback `port` (not merely something listening there). */
function socksReady(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection({ host: "127.0.0.1", port });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    // Greeting: SOCKS5, one method, "no authentication"; ssh answers 05 00.
    s.once("connect", () => s.write(Buffer.from([5, 1, 0])));
    s.once("data", (b: Buffer) => done(b[0] === 5 && b[1] === 0));
    s.once("close", () => done(false));
    s.once("error", () => done(false));
    s.setTimeout(1000, () => done(false));
  });
}

export type TunnelState = "up" | "down";


/**
 * The session's SSH tunnel. start() opens it (or throws why it couldn't);
 * if it drops later, it's reopened on the same port (the browser's proxy
 * can't change), with `onState` told each time it goes down or comes back.
 */
export class Tunnel {
  port = 0;
  state: TunnelState = "down";
  /** Why it last failed (ssh's own words). */
  lastError = "";
  private proc: Subprocess | null = null;
  private stopped = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  /** How long ssh may take to open its proxy (its ConnectTimeout is 15 s, then the login). */
  openTimeoutMs = 45_000;

  constructor(
    readonly dest: string,
    private log: (msg: string) => void,
    private onState: (state: TunnelState, why: string) => void = () => {},
  ) {}

  /** Opens the tunnel on a free port: resolves once its proxy answers, or rejects with ssh's reason. */
  async start(): Promise<void> {
    // A port taken between choosing it and ssh binding it: try another.
    for (let i = 0; ; i++) {
      this.port = await freePort();
      try {
        await this.open();
        return;
      } catch (e: any) {
        if (this.stopped || i >= 2 || !/forwarding|bind|Address already in use/i.test(this.lastError)) {
          throw new Error(`can't open the SSH tunnel to ${this.dest}: ${String(e?.message ?? e).replace(/\.+$/, "")}${hint(this.lastError)}`);
        }
      }
    }
  }

  /** Runs ssh on this.port until its proxy answers (resolves) or it exits (rejects). */
  private async open(): Promise<void> {
    const argv = sshArgv(this.dest, this.port);
    this.log(`ssh: ${argv.join(" ")}`);
    // stdin: our end of the pipe that keeps it alive (see WATCHED); never written to.
    const proc = Bun.spawn([...WATCHED, ...argv], { stdin: "pipe", stdout: "ignore", stderr: "pipe", env: { ...process.env } });
    this.proc = proc;
    let err = "";
    const reading = (async () => {
      const dec = new TextDecoder();
      for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) err = (err + dec.decode(chunk)).slice(-4000);
    })().catch(() => {});
    const exited = proc.exited.then(async () => {
      await Promise.race([reading, Bun.sleep(500)]);
      return lastLines(err) || (proc.signalCode || (proc.exitCode ?? 0) > 128 ? "ssh was stopped" : proc.exitCode === 0 ? "ssh ended" : `ssh exited with code ${proc.exitCode}`);
    });
    // Ready once its SOCKS proxy answers on the port while this ssh still runs; given up
    // on (ssh stopped) if it never does, past ssh's own ConnectTimeout and a login.
    const deadline = Date.now() + this.openTimeoutMs;
    for (;;) {
      const gone = await Promise.race([exited, Bun.sleep(150).then(() => null)]);
      if (gone !== null || proc.exitCode !== null) {
        const why = gone ?? (await exited);
        this.lastError = why;
        if (this.proc === proc) this.proc = null;
        throw new Error(this.lastError);
      }
      if (this.stopped) {
        proc.kill();
        throw new Error("stopped");
      }
      if (await socksReady(this.port)) break;
      if (Date.now() > deadline) {
        this.lastError = `ssh connected, but its SOCKS proxy never opened on 127.0.0.1:${this.port}`;
        if (this.proc === proc) this.proc = null;
        proc.kill();
        throw new Error(this.lastError);
      }
    }
    this.state = "up";
    this.attempt = 0;
    this.log(`ssh: tunnel to ${this.dest} up on 127.0.0.1:${this.port} (pid ${proc.pid})`);
    void exited.then((why) => {
      if (this.proc === proc) this.proc = null;
      if (this.stopped) return;
      this.lastError = why;
      this.log(`ssh: tunnel to ${this.dest} dropped: ${this.lastError}`);
      this.state = "down";
      this.onState("down", this.lastError);
      this.reconnect();
    });
  }

  private reconnect(): void {
    if (this.stopped) return;
    const delay = [1000, 2000, 5000, 10_000, 30_000][Math.min(this.attempt++, 4)]!;
    this.retry = setTimeout(() => {
      this.retry = null;
      this.open().then(
        () => this.onState("up", ""),
        () => {
          this.log(`ssh: reconnecting to ${this.dest} failed: ${this.lastError}`);
          this.reconnect();
        },
      );
    }, delay);
  }

  /** Ends the tunnel for good. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    const p = this.proc;
    this.proc = null;
    if (!p || p.exitCode !== null) return;
    p.kill();
    await Promise.race([p.exited, Bun.sleep(1500)]);
    if (p.exitCode === null) p.kill(9);
  }

  /** Last resort on exit (synchronous): no ssh is left behind. */
  kill(): void {
    this.stopped = true;
    try {
      this.proc?.kill(9);
    } catch {}
  }
}

/** ssh's last few meaningful lines (its warnings about known hosts aren't the reason). */
function lastLines(s: string): string {
  return s
    .split(/\r?\n/)
    .map((l) => l.trim())
    // Not the reason: known-hosts notes, and a page's connection the far side couldn't make.
    .filter((l) => l && !/^Warning: Permanently added|^channel \d+: open failed/.test(l))
    .slice(-3)
    .join(" ");
}

/** What to do about a failed login. */
function hint(err: string): string {
  if (/Permission denied|Host key verification failed|passphrase|password/i.test(err)) {
    return ". termium logs in without a prompt: use a key (ssh-agent), and accept the host key once with a plain `ssh` first";
  }
  return "";
}
