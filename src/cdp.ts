// Minimal Chrome DevTools Protocol client over a single browser-level
// WebSocket, using flattened sessions for per-tab traffic.

type Handler = (params: any, sessionId?: string) => void;

interface Pending {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  method: string;
}

export class CDP {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private handlers = new Map<string, Set<Handler>>();
  closed = false;
  onClose?: () => void;
  /** Called with every message (frames abbreviated) when set; for TERMIUM_DEBUG. */
  trace?: (dir: "->" | "<-", msg: string) => void;

  private constructor(private ws: WebSocket) {
    ws.addEventListener("message", (ev) => this.onMessage(String(ev.data)));
    ws.addEventListener("close", () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error("CDP connection closed"));
      this.pending.clear();
      this.onClose?.();
    });
  }

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
          resolve(new CDP(ws));
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
      this.pending.set(id, { resolve, reject, method });
      const text = JSON.stringify(msg);
      this.trace?.("->", text);
      this.ws.send(text);
    });
  }

  on(method: string, handler: Handler): void {
    let set = this.handlers.get(method);
    if (!set) this.handlers.set(method, (set = new Set()));
    set.add(handler);
  }

  close(): void {
    try {
      this.ws.close();
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
    if (set) for (const h of set) h(msg.params, msg.sessionId);
  }
}
