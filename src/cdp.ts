// Minimal Chrome DevTools Protocol client over one browser-level
// connection (the --remote-debugging-pipe file descriptors, or a WebSocket),
// using flattened sessions for per-tab traffic.

import { writeSync } from "node:fs";

type Handler = (params: any, sessionId?: string) => void;

interface Pending {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  method: string;
  sessionId?: string;
}

export class CDP {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private handlers = new Map<string, Set<Handler>>();
  closed = false;
  onClose?: () => void;
  /** Called with every message (frames abbreviated) when set; for TERMIUM_DEBUG. */
  trace?: (dir: "->" | "<-", msg: string) => void;

  private constructor(
    private write: (text: string) => void,
    private hangup: () => void,
  ) {}

  private gone(): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new Error("CDP connection closed"));
    this.pending.clear();
    this.onClose?.();
  }

  /**
   * Speaks CDP over Chromium's --remote-debugging-pipe: NUL-terminated JSON
   * written to `toBrowser`, read from `fromBrowser`. Nothing listens on a
   * port, so no other local process can drive the browser.
   */
  static fromPipe(toBrowser: number, fromBrowser: number): CDP {
    let queue: Buffer[] = [];
    let flushing = false;
    const flush = () => {
      // The pipe is non-blocking: write what fits and retry the rest shortly.
      while (queue.length) {
        try {
          const head = queue[0]!;
          const n = writeSync(toBrowser, head);
          if (n < head.length) queue[0] = head.subarray(n);
          else queue.shift();
        } catch (err: any) {
          if (err?.code === "EAGAIN") {
            if (!flushing) {
              flushing = true;
              setTimeout(() => {
                flushing = false;
                flush();
              }, 2);
            }
            return;
          }
          queue = [];
          cdp.gone();
          return;
        }
      }
    };
    const cdp = new CDP(
      (text) => {
        queue.push(Buffer.from(text + "\0", "utf8"));
        if (!flushing) flush();
      },
      () => cdp.gone(),
    );
    (async () => {
      const decoder = new TextDecoder();
      let buf = "";
      for await (const chunk of Bun.file(fromBrowser).stream()) {
        buf += decoder.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\0")) >= 0) {
          const msg = buf.slice(0, i);
          buf = buf.slice(i + 1);
          cdp.onMessage(msg);
        }
      }
    })()
      .catch(() => {})
      .finally(() => cdp.gone());
    return cdp;
  }

  /** Connects to a DevTools WebSocket (used by tests and tools, not by termium itself). */
  static connect(url: string, timeoutMs = 10_000): Promise<CDP> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`Timed out connecting to ${url}`));
      }, timeoutMs);
      ws.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          const cdp = new CDP(
            (text) => ws.send(text),
            () => ws.close(),
          );
          ws.addEventListener("message", (ev) => cdp.onMessage(String(ev.data)));
          ws.addEventListener("close", () => cdp.gone());
          resolve(cdp);
        },
        { once: true },
      );
      ws.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error(`Could not connect to ${url}`));
        },
        { once: true },
      );
    });
  }

  send<T = any>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    if (this.closed) return Promise.reject(new Error("CDP connection closed"));
    const id = this.nextId++;
    const msg: Record<string, unknown> = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method, sessionId });
      const text = JSON.stringify(msg);
      this.trace?.("->", text);
      this.write(text);
    });
  }

  /** Fails every command still waiting on a session that has gone away. */
  failSession(sessionId: string): void {
    for (const [id, p] of this.pending) {
      if (p.sessionId !== sessionId) continue;
      this.pending.delete(id);
      p.reject(new Error(`${p.method}: session closed`));
    }
  }

  on(method: string, handler: Handler): void {
    let set = this.handlers.get(method);
    if (!set) this.handlers.set(method, (set = new Set()));
    set.add(handler);
  }

  close(): void {
    try {
      this.hangup();
    } catch {}
  }

  private onMessage(data: string): void {
    this.trace?.("<-", data.length > 600 ? `${data.slice(0, 300)}…(${data.length} bytes)` : data);
    let msg: any;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
      else p.resolve(msg.result);
      return;
    }
    const set = this.handlers.get(msg.method);
    if (!set) return;
    for (const h of set) {
      // One bad handler must not take the whole connection down.
      try {
        h(msg.params, msg.sessionId);
      } catch (e) {
        this.trace?.("<-", `handler for ${msg.method} threw: ${e instanceof Error ? e.stack : e}`);
      }
    }
  }
}
