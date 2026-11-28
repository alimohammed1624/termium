// Which tabs play sound, and muting them. The DevTools protocol has neither
// (no per-tab "audible" state, no per-tab mute command), but the browser's
// own tab audio state is there for extensions (chrome.tabs: audible,
// mutedInfo). So termium loads a tiny extension of its own over its private
// DevTools pipe (Extensions.loadUnpacked: pipe only, and only with
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
  private failures = 0;

  constructor(
    private cdp: CDP,
    /** Where the extension's files are written (loaded from there). */
    private dir: string,
    private log: (msg: string) => void,
    /** Every page playing or muted, by DevTools target id (pages not in it: neither). */
    private onChange: (states: Map<string, AudioState>) => void,
  ) {}

  /** Loads the extension and follows tab audio until stop(); false if this browser can't. */
  async start(): Promise<boolean> {
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(join(this.dir, "manifest.json"), JSON.stringify(MANIFEST, null, 2));
      writeFileSync(join(this.dir, "worker.js"), WORKER);
      const { id } = await this.cdp.send("Extensions.loadUnpacked", { path: this.dir });
      // Its service worker starts as the extension loads.
      for (let i = 0; i < 50 && !this.stopped && !this.sid; i++) {
        // (Asked for by type: getTargets otherwise lists what setDiscoverTargets follows, pages only.)
        const { targetInfos } = await this.cdp.send("Target.getTargets", { filter: [{ type: "service_worker" }] });
        const worker = targetInfos.find((t: any) => t.type === "service_worker" && String(t.url).startsWith(`chrome-extension://${id}/`));
        if (worker) this.sid = (await this.cdp.send("Target.attachToTarget", { targetId: worker.targetId, flatten: true })).sessionId;
        else await Bun.sleep(100);
      }
      if (!this.sid) throw new Error("its service worker didn't start");
    } catch (e) {
      this.log(`audio: no tab audio state or muting (${e instanceof Error ? e.message : e})`);
      this.sid = null;
      return false;
    }
    void this.follow();
    return true;
  }

  stop(): void {
    this.stopped = true;
  }

  get available(): boolean {
    return this.sid !== null;
  }

  private async call(expression: string): Promise<any> {
    if (!this.sid) throw new Error("tab audio isn't available with this browser");
    const r = await this.cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, this.sid);
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r?.result?.value;
  }

  private async follow(): Promise<void> {
    let seen = -1;
    while (!this.stopped && this.sid) {
      try {
        const r = await this.call(`termiumAudio.next(${seen})`);
        seen = r.ver;
        this.failures = 0;
        this.onChange(new Map((r.tabs as [string, boolean, boolean][]).map(([t, audible, muted]) => [t, { audible, muted }])));
      } catch (e) {
        if (this.stopped || this.cdp.closed) return;
        // Its worker went away (a crash, or stopped): loading the extension again starts it.
        this.log(`audio: ${e instanceof Error ? e.message : e}`);
        this.sid = null;
        if (++this.failures > 3) return;
        await Bun.sleep(1000 * this.failures);
        if (!(await this.start())) return;
        return; // start() follows again
      }
    }
  }

  /** Mutes or unmutes the page's tab; false if the browser doesn't know it as a tab. */
  async setMuted(targetId: string, muted: boolean): Promise<boolean> {
    return !!(await this.call(`termiumAudio.mute(${JSON.stringify(targetId)}, ${muted})`));
  }
}
