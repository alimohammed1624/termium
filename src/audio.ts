// Which tabs play sound, and muting them. The DevTools protocol has neither
// (no per-tab "audible" state, no per-tab mute command), but the browser's
// own tab audio state is there for extensions (chrome.tabs: audible,
// mutedInfo). So termium loads a tiny extension of its own over its DevTools
// pipe (Extensions.loadUnpacked, which Chrome allows only with
// --enable-unsafe-extension-debugging) and asks its service worker.
//
// That's the browser's real tab mute, the one Chrome's tab strip uses: it
// covers every frame (cross-site iframes too), <audio>/<video>, Web Audio
// and WebRTC, and the page can't tell (nothing is injected into it).
// "Audible" is the browser's own measure of sound coming out of the tab,
// so a page that is silent (paused, or playing silence) doesn't show it.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CDP } from "./cdp";

const MANIFEST = {
  manifest_version: 3,
  name: "termium audio",
  description: "Shows which termium tabs play sound, and mutes them.",
  version: "1.0",
  // tabs: audible and mutedInfo. debugger: only getTargets (tab id <-> DevTools target id); it never attaches.
  permissions: ["tabs", "debugger"],
  background: { service_worker: "worker.js" },
};

// The service worker: termium calls termiumAudio.next() and .mute() with Runtime.evaluate.
const WORKER = String.raw`let ver = 0;
const waiting = new Set();
const changed = () => { ver++; for (const w of waiting) w(); waiting.clear(); };
chrome.tabs.onUpdated.addListener((_id, info) => { if ("audible" in info || "mutedInfo" in info) changed(); });
chrome.tabs.onRemoved.addListener(changed);
chrome.tabs.onReplaced.addListener(changed);
const targets = async () => {
  const m = new Map();
  for (const t of await chrome.debugger.getTargets()) if (t.tabId !== undefined && t.type === "page") m.set(t.tabId, t.id);
  return m;
};
self.termiumAudio = {
  // Tabs playing or muted, once something changed since version "seen" (or after 20 s).
  async next(seen) {
    if (seen === ver) {
      await new Promise((r) => {
        const done = () => { waiting.delete(done); clearTimeout(t); r(); };
        const t = setTimeout(done, 20000);
        waiting.add(done);
      });
    }
    const v = ver;
    const ids = await targets();
    const tabs = [];
    for (const t of await chrome.tabs.query({})) {
      const muted = !!(t.mutedInfo && t.mutedInfo.muted);
      if ((t.audible || muted) && ids.has(t.id)) tabs.push([ids.get(t.id), !!t.audible, muted]);
    }
    return { ver: v, tabs };
  },
  async mute(targetId, muted) {
    for (const [tabId, id] of await targets()) {
      if (id === targetId) { await chrome.tabs.update(tabId, { muted }); return true; }
    }
    return false;
  },
};
`;

export interface AudioState {
  audible: boolean;
  muted: boolean;
}

export class TabAudio {
  private sid: string | null = null;
  private stopped = false;
  /** The browser can't load the extension (it never worked): no indicator, no muting. */
  private unsupported = false;

  constructor(
    private cdp: CDP,
    /** Where the extension's files are written (loaded from there). */
    private dir: string,
    private log: (msg: string) => void,
    /** Every page playing or muted, by DevTools target id (pages not in it: neither). */
    private onChange: (states: Map<string, AudioState>) => void,
  ) {}

  /**
   * Loads the extension and follows tab audio until stop() or the browser
   * goes. A worker that dies or stops answering is started again (loading
   * the extension again does that), backing off while it keeps failing.
   */
  async run(): Promise<void> {
    let seen = -1;
    let delay = 1000;
    let worked = false;
    while (!this.stopped && !this.cdp.closed) {
      if (!this.sid) {
        if (!(await this.connect(worked))) {
          if (this.unsupported) return;
          await Bun.sleep(delay);
          delay = Math.min(delay * 2, 30_000);
          continue;
        }
        if (worked) this.log("audio: tab audio is back");
        worked = true;
        delay = 1000;
        seen = -1;
      }
      const sid = this.sid!;
      try {
        // next() answers within 20 s (at once if something changed).
        const r = await this.call(sid, `termiumAudio.next(${seen})`, 30_000);
        seen = r.ver;
        this.onChange(new Map((r.tabs as [string, boolean, boolean][]).map(([t, audible, muted]) => [t, { audible, muted }])));
      } catch (e) {
        if (this.stopped || this.cdp.closed) return;
        this.log(`audio: ${e instanceof Error ? e.message : e}; starting it again`);
        this.drop(sid);
      }
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.sid) this.drop(this.sid);
  }

  /** Writes and loads the extension, attaches to its worker, and checks that it answers. */
  private async connect(worked: boolean): Promise<boolean> {
    let sid: string | null = null;
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(join(this.dir, "manifest.json"), JSON.stringify(MANIFEST, null, 2));
      writeFileSync(join(this.dir, "worker.js"), WORKER);
      // Loaded again, a loaded extension restarts (its worker too).
      let id: string;
      try {
        ({ id } = await withTimeout(this.cdp.send("Extensions.loadUnpacked", { path: this.dir }), 10_000, "loading the extension"));
      } catch (e) {
        // Never loaded: this browser can't (or won't) load it; don't keep trying.
        if (!worked) this.unsupported = true;
        throw e;
      }
      for (let i = 0; i < 50 && !this.stopped && !sid; i++) {
        // (Asked for by type: getTargets otherwise lists what setDiscoverTargets follows, pages only.)
        const { targetInfos } = await this.cdp.send("Target.getTargets", { filter: [{ type: "service_worker" }] });
        const worker = targetInfos.find((t: any) => String(t.url).startsWith(`chrome-extension://${id}/`));
        if (worker) sid = (await this.cdp.send("Target.attachToTarget", { targetId: worker.targetId, flatten: true })).sessionId;
        else await Bun.sleep(100);
      }
      if (!sid) throw new Error("its service worker didn't start");
      this.cdp.send("Runtime.runIfWaitingForDebugger", {}, sid).catch(() => {});
      // Its script may not have run yet (a worker just started waits for its debuggers).
      for (let i = 0; (await this.call(sid, "typeof termiumAudio", 5000)) !== "object"; i++) {
        if (i >= 50) throw new Error("its service worker doesn't answer");
        await Bun.sleep(100);
      }
      this.sid = sid;
      return true;
    } catch (e) {
      this.log(`audio: no tab audio state or muting (${e instanceof Error ? e.message : e})`);
      if (sid) this.drop(sid);
      return false;
    }
  }

  /** Lets go of a worker session (calls still waiting on it fail). */
  private drop(sid: string): void {
    if (this.sid === sid) this.sid = null;
    this.cdp.failSession(sid);
    this.cdp.send("Target.detachFromTarget", { sessionId: sid }).catch(() => {});
  }

  private async call(sid: string, expression: string, ms: number): Promise<any> {
    const r = await withTimeout(this.cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sid), ms, "its service worker");
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r?.result?.value;
  }

  /** Mutes or unmutes the page's tab; false if the browser doesn't know it as a tab. */
  async setMuted(targetId: string, muted: boolean): Promise<boolean> {
    for (let attempt = 0; ; attempt++) {
      // Starting (just after startup, or after its worker went): wait for that a while.
      for (let i = 0; i < 150 && !this.sid && !this.unsupported && !this.stopped; i++) await Bun.sleep(100);
      const sid = this.sid;
      if (!sid) {
        throw new Error(
          this.unsupported
            ? "muting isn't available with this browser (see the session log)"
            : "tab audio isn't ready (its extension is starting again); try again",
        );
      }
      try {
        return !!(await this.call(sid, `termiumAudio.mute(${JSON.stringify(targetId)}, ${muted})`, 5000));
      } catch (e) {
        // Its worker went: run() starts it again (dropping the session wakes it); then once more.
        this.drop(sid);
        if (attempt > 0 || this.stopped) throw new Error(`muting failed (${e instanceof Error ? e.message : e}); try again`);
      }
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} didn't answer in ${ms / 1000} s`)), ms)));
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
