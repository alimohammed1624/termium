// termium's core: spaces (windows) -> tabs -> split panes, each pane showing
// one headless browser page rendered with the kitty graphics protocol.

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import type { CDP } from "./cdp";
import type { InputEvent, KeyEvent, MouseEvent, Mods } from "./input";
import {
  computeLayout,
  enclosingSplit,
  inRect,
  leaf,
  leaves,
  neighbor,
  removeLeaf,
  splitLeaf,
  type Dir,
  type Node,
  type PaneGeom,
  type Rect,
  type SepGeom,
} from "./layout";
import { deleteAllImages, drawImage, out, setClipboard } from "./terminal";
import { SELECT_POPUP } from "./select-popup";
import { DEFAULT_SEARCH, LineEdit, fit, splitPaths, toUrl, truncate, width } from "./text";

// ---------------------------------------------------------------- model

export interface Page {
  targetId: string;
  sessionId: string;
  url: string;
  title: string;
  loading: boolean;
  crashed: boolean;
  dialog: { type: string; message: string; defaultPrompt: string } | null;
  /** Viewport we last gave the page, in CSS px. */
  css: { w: number; h: number; dsf: number } | null;
  casting: { w: number; h: number } | null;
  lastFrame: string | null;
  frameSeq: number;
  navSeq: number;
  /** When title/URL were last fetched. */
  infoAt: number;
  imageId: number | null;
  /** Where its image currently sits, so a stale placement can be redrawn. */
  placed: Rect | null;
}

interface Tab {
  id: number;
  root: Node<Page>;
  focused: Page;
  zoomed: boolean;
}

interface Space {
  id: number;
  name: string;
  tabs: Tab[];
  active: number;
}

type Placement =
  | { kind: "tab"; space: Space; index: number; editUrl: boolean; url?: string }
  | { kind: "split"; tab: Tab; next: Page; dir: Dir; editUrl: boolean; url?: string };

type Prompt =
  | { kind: "url"; edit: LineEdit; page: Page }
  | { kind: "file"; edit: LineEdit; page: Page; backendNodeId: number; multiple: boolean }
  | { kind: "rename"; edit: LineEdit; space: Space }
  | { kind: "dialog"; edit: LineEdit; page: Page };

type Mode = "normal" | "prefix" | "resize" | "spaces" | "help";

export interface AppOptions {
  scale: number | null; // explicit device scale factor
  search: string;
  downloadDir: string;
  quit: () => void;
  log: (msg: string) => void;
}

// ---------------------------------------------------------------- style

const C = {
  crust: "11111b",
  mantle: "181825",
  base: "1e1e2e",
  surface0: "313244",
  surface1: "45475a",
  overlay: "6c7086",
  subtext: "a6adc8",
  text: "cdd6f4",
  mauve: "cba6f7",
  blue: "89b4fa",
  green: "a6e3a1",
  red: "f38ba8",
  yellow: "f9e2af",
  peach: "fab387",
};
const rgb = (hex: string) => `${parseInt(hex.slice(0, 2), 16)};${parseInt(hex.slice(2, 4), 16)};${parseInt(hex.slice(4, 6), 16)}`;
const fg = (hex: string) => `\x1b[38;2;${rgb(hex)}m`;
const bg = (hex: string) => `\x1b[48;2;${rgb(hex)}m`;
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const at = (row: number, col: number) => `\x1b[${row};${col}H`;

/** Shortcuts that still work while the address bar (or another text prompt) is open. */
const PROMPT_GLOBALS = new Set([
  "ctrl+t", "ctrl+r", "f5", "shift+f5", "ctrl+shift+r", "alt+arrowleft", "alt+arrowright",
  "alt+=", "alt++", "alt+-", "alt+0",
]);
/** While a page is blocked on a JavaScript dialog, only these make sense. */
const DIALOG_GLOBALS = new Set(["ctrl+t", "alt+=", "alt++", "alt+-", "alt+0"]);

const SIDEBAR_W = 22;
const TOP_ROWS = 2;
const MARKER = "#termium-";

const HELP: [string, string][] = [
  ["Ctrl+L / F6", "edit address"],
  ["Ctrl+T", "new tab"],
  ["Ctrl+W", "close pane"],
  ["Alt+← / Alt+→", "back / forward"],
  ["Ctrl+R / F5", "reload"],
  ["Alt+= / Alt+- / Alt+0", "zoom in / out / reset"],
  ["Ctrl+C", "copy selection to clipboard"],
  ["Ctrl+Q", "quit"],
  ["", ""],
  ["Ctrl+B then…", ""],
  ["c", "new tab"],
  ["n / p / 1-9", "next / previous / go to tab"],
  ["X", "close tab"],
  ["v / -", "split right / down"],
  ["h j k l", "focus pane left/down/up/right"],
  ["z", "zoom pane"],
  ["r", "resize mode (h j k l, Esc)"],
  ["x", "close pane"],
  ["w", "spaces (j/k, Enter, 1-9, Esc)"],
  ["N / W / D", "new / rename / close space"],
  ["b", "toggle sidebar"],
  ["Ctrl+B", "send Ctrl+B to the page"],
  ["q", "quit"],
  ["?", "this help"],
];

// ---------------------------------------------------------------- app

export class App {
  spaces: Space[] = [];
  activeSpace = 0;
  pages = new Map<string, Page>(); // by sessionId
  private byTarget = new Map<string, Page>();

  cols = 80;
  rows = 24;
  cellW = 10;
  cellH = 20;
  pixelMouse = false;
  private zoom = 1;
  sidebar = true;

  private mode: Mode = "normal";
  private prompt: Prompt | null = null;
  private spaceCursor = 0;
  private toast: { text: string; until: number } | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  private geom = new Map<Page, PaneGeom<Page>>();
  private seps: SepGeom<Page>[] = [];
  private tabHits: { start: number; end: number; index: number }[] = [];
  private newTabHit: { start: number; end: number } | null = null;
  private navHits: { back: [number, number]; fwd: [number, number]; reload: [number, number]; url: [number, number] } | null = null;
  private spaceHits: { row: number; index: number }[] = [];
  private newSpaceRow = -1;

  private nextImage = 100;
  private nextTabId = 1;
  private nextSpaceId = 1;
  private nextMarker = 1;
  private placements = new Map<string, Placement>(); // by marker
  private pageKeysDown = new Set<string>();
  private mouseCapture: Page | null = null;
  private mouseButtons = 0;
  private lastClick = { time: 0, x: 0, y: 0, button: -1, count: 0 };
  private drag: { sep: SepGeom<Page>; moved: boolean } | null = null;
  private moveInFlight = false;
  private pendingMove: (() => Promise<unknown>) | null = null;
  private chromeQueued = false;
  private started = false;
  private startedAt = Date.now();
  /** Per-page user agent override without "HeadlessChrome". */
  private ua: object | null = null;
  private initialTargets = new Set<string>();

  constructor(
    private cdp: CDP,
    private opts: AppOptions,
  ) {}

  // ---------------------------------------------------------- startup

  async start(initialUrl: string | null): Promise<void> {
    const cdp = this.cdp;
    cdp.on("Target.attachedToTarget", (p) => this.onAttached(p).catch((e) => this.opts.log(String(e))));
    cdp.on("Target.detachedFromTarget", (p) => this.onGone(this.pages.get(p.sessionId)));
    cdp.on("Target.targetDestroyed", (p) => this.onGone(this.byTarget.get(p.targetId)));
    cdp.on("Target.targetInfoChanged", ({ targetInfo }) => {
      const page = this.byTarget.get(targetInfo.targetId);
      if (!page) return;
      page.url = targetInfo.url;
      page.title = targetInfo.title;
      this.queueChrome();
    });
    cdp.on("Page.screencastFrame", (p, sid) => this.onFrame(p, sid));
    cdp.on("Page.frameStartedLoading", (p, sid) => this.setLoading(sid, p.frameId, true));
    cdp.on("Page.frameStoppedLoading", (p, sid) => this.setLoading(sid, p.frameId, false));
    cdp.on("Page.navigatedWithinDocument", (p, sid) => {
      const page = sid ? this.pages.get(sid) : undefined;
      if (page && p.frameId === page.targetId) void this.refreshInfo(page);
    });
    cdp.on("Page.javascriptDialogOpening", (p, sid) => this.onDialog(sid, p));
    cdp.on("Page.javascriptDialogClosed", (_p, sid) => {
      const page = sid ? this.pages.get(sid) : undefined;
      if (!page) return;
      page.dialog = null;
      if (this.prompt?.kind === "dialog" && this.prompt.page === page) this.prompt = null;
      this.queueChrome();
    });
    cdp.on("Inspector.targetCrashed", (_p, sid) => {
      const page = sid ? this.pages.get(sid) : undefined;
      if (!page) return;
      page.crashed = true;
      page.loading = false;
      this.showToast("Page crashed. Ctrl+R reloads it.");
    });
    cdp.on("Page.fileChooserOpened", (p, sid) => {
      const page = sid ? this.pages.get(sid) : undefined;
      if (!page || p.backendNodeId === undefined) return;
      if (page !== this.focused) this.focusPage(page);
      this.prompt = {
        kind: "file",
        edit: new LineEdit(this.lastUploadDir, false),
        page,
        backendNodeId: p.backendNodeId,
        multiple: p.mode === "selectMultiple",
      };
      this.queueChrome();
    });
    cdp.on("Browser.downloadWillBegin", (p) => this.showToast(`Downloading ${p.suggestedFilename}…`));
    cdp.on("Browser.downloadProgress", (p) => {
      if (p.state === "completed") this.showToast(`Saved to ${this.opts.downloadDir}`);
      else if (p.state === "canceled") this.showToast("Download canceled");
    });

    await cdp
      .send("Browser.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: this.opts.downloadDir,
        eventsEnabled: true,
      })
      .catch((e) => this.opts.log(`downloads: ${e}`));

    // Present as regular Chrome: "HeadlessChrome" in the user agent and
    // client hints gets pages to serve bot checks (DuckDuckGo does).
    try {
      const v = await cdp.send("Browser.getVersion");
      const full = String(v.product).split("/")[1] ?? "";
      const major = full.split(".")[0] ?? "";
      const platform = process.platform === "darwin" ? "macOS" : "Linux";
      const brands = (ver: string, filler: string) => [
        { brand: "Chromium", version: ver },
        { brand: "Not_A Brand", version: filler },
      ];
      this.ua = {
        userAgent: String(v.userAgent).replace("HeadlessChrome", "Chrome"),
        platform: process.platform === "darwin" ? "MacIntel" : `Linux ${process.arch === "arm64" ? "aarch64" : "x86_64"}`,
        userAgentMetadata: {
          brands: brands(major, "24"),
          fullVersionList: brands(full, "24.0.0.0"),
          platform,
          platformVersion: "",
          architecture: process.arch === "arm64" ? "arm" : "x86",
          bitness: "64",
          model: "",
          mobile: false,
          wow64: false,
        },
      };
    } catch (e) {
      this.opts.log(`version: ${e}`);
    }

    // The first space and tab are created up front; the about:blank page
    // the browser started with is closed once ours exists.
    const space = this.newSpaceModel();
    this.spaces.push(space);
    const { targetInfos } = await cdp.send("Target.getTargets");
    for (const t of targetInfos) if (t.type === "page") this.initialTargets.add(t.targetId);
    this.started = true;
    await cdp.send("Target.setDiscoverTargets", { discover: true, filter: [{ type: "page" }] });
    await cdp.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      filter: [{ type: "page", exclude: false }, { exclude: true }],
    });
    const url = initialUrl ? toUrl(initialUrl, this.opts.search) : null;
    // Script title changes (document.title = ...) don't produce
    // targetInfoChanged in this browser, so poll titles once a second.
    this.titlePoll = setInterval(() => void this.pollTitles(), 1000);
    const firstReady = new Promise<void>((r) => (this.onFirstPage = r));
    await this.createPage({ kind: "tab", space, index: 0, editUrl: !url, url: url ?? undefined });
    // Input is held back until the first page exists so early keystrokes land in it.
    await Promise.race([firstReady, Bun.sleep(10_000)]);
    this.onFirstPage = null;
    this.ready = true;
    this.fullRedraw();
  }

  private onFirstPage: (() => void) | null = null;
  private early: InputEvent[] = [];
  /** False until the first page exists; input is queued until then. */
  private ready = false;

  /** Replays input that arrived before the first page was ready. */
  flushEarlyInput(): void {
    const queued = this.early.splice(0);
    for (const e of queued) this.handle(e);
  }

  private newSpaceModel(): Space {
    const id = this.nextSpaceId++;
    return { id, name: `space ${id}`, tabs: [], active: 0 };
  }

  private get space(): Space | undefined {
    return this.spaces[this.activeSpace];
  }

  private get tab(): Tab | undefined {
    const s = this.space;
    return s ? s.tabs[s.active] : undefined;
  }

  private get focused(): Page | undefined {
    return this.tab?.focused;
  }

  // ---------------------------------------------------------- pages

  private async createPage(placement: Placement): Promise<void> {
    const marker = `${MARKER}${this.nextMarker++}`;
    this.placements.set(marker, placement);
    // The new page takes focus: hold input until it exists so keys typed
    // right after Ctrl+T don't land in the page being left.
    this.holdInput(marker);
    try {
      await this.cdp.send("Target.createTarget", { url: `about:blank${marker}` });
    } catch (e) {
      this.placements.delete(marker);
      this.releaseInput(marker);
      this.showToast(`Could not open a page: ${e}`);
    }
  }

  private holding: string | null = null;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;

  private holdInput(marker: string): void {
    this.holding = marker;
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = setTimeout(() => this.releaseInput(marker), 5000);
  }

  private releaseInput(marker: string): void {
    if (this.holding !== marker) return;
    this.holding = null;
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = null;
    this.flushEarlyInput();
  }

  private async onAttached(p: any): Promise<void> {
    const { sessionId, targetInfo, waitingForDebugger } = p;
    const run = () =>
      waitingForDebugger
        ? this.cdp.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => {})
        : Promise.resolve();
    if (targetInfo.type !== "page" || this.byTarget.has(targetInfo.targetId)) {
      await run();
      return;
    }

    const page: Page = {
      targetId: targetInfo.targetId,
      sessionId,
      url: targetInfo.url,
      title: targetInfo.title,
      infoAt: 0,
      loading: false,
      crashed: false,
      dialog: null,
      css: null,
      casting: null,
      lastFrame: null,
      frameSeq: 0,
      navSeq: 0,
      imageId: null,
      placed: null,
    };

    const markerIdx = targetInfo.url.indexOf(MARKER);
    const marker = markerIdx >= 0 ? targetInfo.url.slice(markerIdx) : null;
    let placement = marker ? this.placements.get(marker) : undefined;
    if (marker) this.placements.delete(marker);

    if (!placement) {
      // Not ours: the startup about:blank, or a popup / target=_blank link.
      if (this.initialTargets.has(targetInfo.targetId)) {
        // The browser's initial blank page: we make our own, so close it.
        await run();
        this.cdp.send("Target.closeTarget", { targetId: targetInfo.targetId }).catch(() => {});
        return;
      }
      const opener = targetInfo.openerId ? this.byTarget.get(targetInfo.openerId) : undefined;
      const loc = opener ? this.locate(opener) : null;
      const space = loc?.space ?? this.space ?? this.spaces[0]!;
      const index = loc ? space.tabs.indexOf(loc.tab) + 1 : space.tabs.length;
      placement = { kind: "tab", space, index, editUrl: false };
    }

    this.pages.set(sessionId, page);
    this.byTarget.set(page.targetId, page);

    const sid = sessionId;
    // Don't await these before resuming: a page opened by another page
    // (target=_blank, window.open) only answers once it runs.
    const setup = Promise.all([
      this.cdp.send("Page.enable", {}, sid),
      this.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, sid),
      this.ua ? this.cdp.send("Emulation.setUserAgentOverride", this.ua, sid) : null,
      this.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: SELECT_POPUP, worldName: "termium", runImmediately: true }, sid),
      this.cdp.send("Page.setInterceptFileChooserDialog", { enabled: true }, sid),
    ]).catch((e) => this.opts.log(`setup ${sid}: ${e}`));

    // Put it into the model before applying metrics so it gets the right size.
    if (placement.kind === "tab") {
      const space = this.spaces.includes(placement.space) ? placement.space : this.space!;
      const tab: Tab = { id: this.nextTabId++, root: leaf(page), focused: page, zoomed: false };
      const index = Math.min(placement.index, space.tabs.length);
      space.tabs.splice(index, 0, tab);
      space.active = index;
      this.activeSpace = Math.max(0, this.spaces.indexOf(space));
    } else {
      const tab = placement.tab;
      if (this.locateTab(tab)) {
        tab.root = splitLeaf(tab.root, placement.next, page, placement.dir);
        tab.focused = page;
        tab.zoomed = false;
      } else {
        const space = this.space!;
        space.tabs.push({ id: this.nextTabId++, root: leaf(page), focused: page, zoomed: false });
        space.active = space.tabs.length - 1;
      }
    }

    this.relayout();
    await run();
    await setup;
    const target = placement.url;
    // A new page stays on about:blank#termium-N (shown as an empty address)
    // until something navigates it; navigating it away here would race the
    // user's first navigation.
    if (target) this.navigate(page, target);
    if (placement.editUrl && this.focused === page) this.openUrlPrompt(page, "");
    this.fullRedraw();
    this.onFirstPage?.();
    if (marker) this.releaseInput(marker);
  }

  private onGone(page: Page | undefined): void {
    if (!page) return;
    this.pages.delete(page.sessionId);
    this.byTarget.delete(page.targetId);
    if (page.imageId !== null) out(`\x1b_Ga=d,d=I,i=${page.imageId},q=2\x1b\\`);
    if (this.prompt && "page" in this.prompt && this.prompt.page === page) this.prompt = null;
    if (this.mouseCapture === page) this.mouseCapture = null;

    const loc = this.locate(page);
    if (loc) {
      const { space, tab } = loc;
      const root = removeLeaf(tab.root, page);
      if (root) {
        tab.root = root;
        if (tab.focused === page) tab.focused = leaves(root)[0]!;
        if (leaves(root).length === 1) tab.zoomed = false;
      } else {
        // Closing the active tab moves to the one after it (or before, if last).
        const i = space.tabs.indexOf(tab);
        space.tabs.splice(i, 1);
        if (space.active > i) space.active--;
        space.active = Math.max(0, Math.min(space.active, space.tabs.length - 1));
        if (space.tabs.length === 0 && this.spaces.length > 1) {
          const si = this.spaces.indexOf(space);
          this.spaces.splice(si, 1);
          if (this.activeSpace > si) this.activeSpace--;
          this.activeSpace = Math.max(0, Math.min(this.activeSpace, this.spaces.length - 1));
        }
      }
    }
    if (this.pages.size === 0 && !this.closingAll) {
      // Never leave an empty browser: open a fresh tab.
      const space = this.spaces[0] ?? this.newSpaceModel();
      if (!this.spaces.includes(space)) this.spaces.push(space);
      this.activeSpace = this.spaces.indexOf(space);
      void this.createPage({ kind: "tab", space, index: 0, editUrl: true });
    }
    this.relayout();
    this.fullRedraw();
  }

  closingAll = false;

  /** Keeps the address-line prompt consistent with the focused page. */
  private syncPrompt(): void {
    const page = this.focused;
    const p = this.prompt;
    if (p && p.kind !== "rename" && p.page !== page) this.prompt = null;
    if (p && p.kind === "rename" && p.space !== this.space) this.prompt = null;
    if (this.prompt?.kind === "dialog" && !this.prompt.page.dialog) this.prompt = null;
    if (page?.dialog && !this.prompt) {
      this.prompt = { kind: "dialog", edit: new LineEdit(page.dialog.defaultPrompt, true), page };
    }
  }

  private locate(page: Page): { space: Space; tab: Tab } | null {
    for (const space of this.spaces) {
      for (const tab of space.tabs) if (leaves(tab.root).includes(page)) return { space, tab };
    }
    return null;
  }

  private locateTab(tab: Tab): Space | null {
    return this.spaces.find((s) => s.tabs.includes(tab)) ?? null;
  }

  private setLoading(sid: string | undefined, frameId: string, loading: boolean): void {
    const page = sid ? this.pages.get(sid) : undefined;
    if (!page || frameId !== page.targetId) return;
    page.loading = loading;
    if (loading) page.crashed = false;
    else void this.refreshInfo(page);
    this.queueChrome();
  }

  private titlePoll: ReturnType<typeof setInterval> | null = null;

  private async pollTitles(): Promise<void> {
    if (this.closingAll || this.cdp.closed) return;
    try {
      const { targetInfos } = await this.cdp.send("Target.getTargets", { filter: [{ type: "page" }] });
      let changed = false;
      for (const info of targetInfos) {
        const page = this.byTarget.get(info.targetId);
        if (!page || (page.title === info.title && page.url === info.url)) continue;
        page.title = info.title;
        page.url = info.url;
        changed = true;
      }
      if (changed) this.queueChrome();
    } catch {}
  }

  /** Title and URL; targetInfoChanged alone can lag behind the page. */
  private async refreshInfo(page: Page): Promise<void> {
    try {
      page.infoAt = Date.now();
      const { targetInfo } = await this.cdp.send("Target.getTargetInfo", { targetId: page.targetId });
      page.url = targetInfo.url;
      page.title = targetInfo.title;
      this.queueChrome();
    } catch {}
  }

  private onDialog(sid: string | undefined, p: any): void {
    const page = sid ? this.pages.get(sid) : undefined;
    if (!page) return;
    page.dialog = { type: p.type, message: p.message, defaultPrompt: p.defaultPrompt ?? "" };
    const loc = this.locate(page);
    if (loc) {
      this.activeSpace = this.spaces.indexOf(loc.space);
      loc.space.active = loc.space.tabs.indexOf(loc.tab);
      loc.tab.focused = page;
    }
    this.prompt = { kind: "dialog", edit: new LineEdit(page.dialog.defaultPrompt, true), page };
    this.relayout();
    this.fullRedraw();
  }

  navigate(page: Page, url: string, attempt = 0): void {
    page.url = url;
    page.loading = true;
    const seq = ++page.navSeq;
    this.cdp
      .send("Page.navigate", { url }, page.sessionId)
      .then((r) => {
        // Helium holds requests for a few seconds after launch while its
        // built-in content blocker starts; on a fresh profile the held
        // navigation can be aborted. Retry once nothing newer replaced it.
        const startup = Date.now() - this.startedAt < 20_000;
        if (r?.errorText === "net::ERR_ABORTED" && !r.isDownload && startup && page.navSeq === seq && attempt < 2 && this.pages.has(page.sessionId)) {
          setTimeout(() => {
            if (page.navSeq === seq) this.navigate(page, url, attempt + 1);
          }, 250);
        }
      })
      .catch((e) => this.showToast(String(e)));
    this.queueChrome();
  }

  private async history(page: Page, delta: number): Promise<void> {
    try {
      const h = await this.cdp.send("Page.getNavigationHistory", {}, page.sessionId);
      const entry = h.entries[h.currentIndex + delta];
      if (entry) await this.cdp.send("Page.navigateToHistoryEntry", { entryId: entry.id }, page.sessionId);
    } catch (e) {
      this.opts.log(`history: ${e}`);
    }
  }

  private reload(page: Page, ignoreCache = false): void {
    page.crashed = false;
    this.cdp.send("Page.reload", { ignoreCache }, page.sessionId).catch(() => {});
  }

  private closePage(page: Page): void {
    this.cdp.send("Target.closeTarget", { targetId: page.targetId }).catch(() => this.onGone(page));
  }

  private closeTab(tab: Tab): void {
    for (const page of leaves(tab.root)) this.closePage(page);
  }

  // ---------------------------------------------------------- geometry

  setGeometry(cols: number, rows: number, cellW: number, cellH: number): void {
    this.cols = cols;
    this.rows = rows;
    this.cellW = cellW;
    this.cellH = cellH;
    if (this.started) {
      this.relayout();
      this.fullRedraw();
    }
  }

  /** Device pixels per CSS pixel: follows the cell size so web text matches terminal text. */
  get dsf(): number {
    const base = this.opts.scale ?? Math.max(1, Math.round((this.cellH / 19) * 4) / 4);
    return Math.round(base * this.zoom * 100) / 100;
  }

  private mainCol(): number {
    return (this.sidebar || this.mode === "spaces") && this.cols >= SIDEBAR_W + 30 ? SIDEBAR_W + 1 : 1;
  }

  private paneArea(): Rect {
    const col = this.mainCol();
    return { col, row: TOP_ROWS + 1, cols: Math.max(1, this.cols - col + 1), rows: Math.max(1, this.rows - TOP_ROWS) };
  }

  /** Recomputes pane geometry and fixes every page's viewport and screencast. */
  relayout(): void {
    this.syncPrompt();
    this.geom.clear();
    this.seps = [];
    const tab = this.tab;
    const visible = new Set<Page>();
    if (tab) {
      const multi = leaves(tab.root).length > 1;
      const root = tab.zoomed ? leaf(tab.focused) : tab.root;
      const { panes, seps } = computeLayout(root, this.paneArea(), multi);
      for (const p of panes) {
        this.geom.set(p.item, p);
        if (p.content.cols > 0 && p.content.rows > 0) visible.add(p.item);
      }
      this.seps = tab.zoomed ? [] : seps;
    }
    for (const page of this.pages.values()) {
      if (visible.has(page)) this.showPage(page);
      else this.hidePage(page);
    }
  }

  private showPage(page: Page): void {
    const g = this.geom.get(page)!;
    const devW = g.content.cols * this.cellW;
    const devH = g.content.rows * this.cellH;
    const dsf = this.dsf;
    const w = Math.max(1, Math.round(devW / dsf));
    const h = Math.max(1, Math.round(devH / dsf));
    const sid = page.sessionId;
    if (!page.css || page.css.w !== w || page.css.h !== h || page.css.dsf !== dsf) {
      page.css = { w, h, dsf };
      this.cdp
        .send("Emulation.setDeviceMetricsOverride", {
          width: w,
          height: h,
          deviceScaleFactor: dsf,
          mobile: false,
          screenWidth: w,
          screenHeight: h,
        }, sid)
        .catch((e) => this.opts.log(`metrics: ${e}`));
    }
    if (!page.casting || page.casting.w !== devW || page.casting.h !== devH) {
      const restart = !!page.casting;
      page.casting = { w: devW, h: devH };
      const start = () =>
        this.cdp
          .send("Page.startScreencast", { format: "png", maxWidth: devW, maxHeight: devH, everyNthFrame: 1 }, sid)
          .catch((e) => this.opts.log(`screencast: ${e}`));
      if (restart) this.cdp.send("Page.stopScreencast", {}, sid).catch(() => {}).then(start);
      else start();
      // Static pages may not produce a frame on their own; grab one.
      const seq = page.frameSeq;
      setTimeout(() => {
        if (page.frameSeq === seq && this.geom.has(page)) this.snapshot(page);
      }, 250);
    }
  }

  private hidePage(page: Page): void {
    if (page.casting) {
      page.casting = null;
      this.cdp.send("Page.stopScreencast", {}, page.sessionId).catch(() => {});
    }
    if (page.imageId !== null) {
      out(`\x1b_Ga=d,d=I,i=${page.imageId},q=2\x1b\\`);
      page.imageId = null;
      page.placed = null;
    }
  }

  private async snapshot(page: Page): Promise<void> {
    try {
      const { data } = await this.cdp.send("Page.captureScreenshot", { format: "png" }, page.sessionId);
      if (page.frameSeq === 0 || !page.lastFrame) {
        page.lastFrame = data;
        this.paint(page);
      }
    } catch {}
  }

  private onFrame(p: any, sid: string | undefined): void {
    const page = sid ? this.pages.get(sid) : undefined;
    if (!page) return;
    page.lastFrame = p.data;
    page.frameSeq++;
    // Ack once the terminal has taken the frame, so the browser only
    // produces frames as fast as the terminal can show them.
    const ack = () => this.cdp.send("Page.screencastFrameAck", { sessionId: p.sessionId }, sid).catch(() => {});
    if (!this.paint(page, ack)) ack();
  }

  /** Draws the page's latest frame into its pane; false if there was nothing to draw. */
  private paint(page: Page, done?: () => void): boolean {
    const g = this.geom.get(page);
    if (!g || !page.lastFrame || this.mode === "help") return false;
    const r = g.content;
    if (r.cols < 1 || r.rows < 1) return false;
    const id = this.nextImage++;
    if (this.nextImage > 4_000_000_000) this.nextImage = 100;
    out(drawImage(page.lastFrame, id, page.imageId, r.row, r.col, r.cols, r.rows) + this.cursorSeq(), done);
    page.imageId = id;
    page.placed = { ...r };
    return true;
  }

  // ---------------------------------------------------------- drawing

  queueChrome(): void {
    if (this.chromeQueued) return;
    this.chromeQueued = true;
    setTimeout(() => {
      this.chromeQueued = false;
      this.drawChrome();
    }, 16);
  }

  /** Clears everything and redraws chrome and every visible page. */
  fullRedraw(): void {
    if (!this.started) return;
    for (const page of this.pages.values()) {
      page.imageId = null;
      page.placed = null;
    }
    out(`${RESET}${deleteAllImages()}\x1b[2J`);
    this.drawChrome();
    if (this.mode === "help") return;
    for (const page of this.geom.keys()) this.paint(page);
  }

  private drawChrome(): void {
    if (!this.started) return;
    let s = "\x1b[?25l";
    const mainCol = this.mainCol();
    const mainW = this.cols - mainCol + 1;
    if (mainCol > 1) s += this.drawSidebar();
    s += this.drawTabBar(mainCol, mainW);
    s += this.drawUrlBar(mainCol, mainW);
    if (this.mode === "help") {
      out(s + RESET + this.helpOverlay() + this.cursorSeq());
      return;
    }
    s += this.drawPaneChrome();
    out(s + RESET + this.cursorSeq());
  }

  private drawSidebar(): string {
    let s = "";
    const w = SIDEBAR_W;
    const line = (row: number, text: string, style: string) => {
      s += at(row, 1) + style + fit(text, w) + RESET;
    };
    const base = bg(C.mantle) + fg(C.subtext);
    line(1, " termium", bg(C.mantle) + fg(C.mauve) + BOLD);
    line(2, " SPACES", base + "\x1b[2m");
    this.spaceHits = [];
    let row = 3;
    this.spaces.forEach((space, i) => {
      if (row > this.rows - 2) return;
      const active = i === this.activeSpace;
      const cursor = this.mode === "spaces" && i === this.spaceCursor;
      const marker = cursor ? "▸" : active ? "●" : " ";
      const count = `${space.tabs.length}`;
      const name = truncate(`${marker} ${i + 1} ${space.name}`, w - count.length - 2);
      const text = ` ${name}${" ".repeat(Math.max(1, w - 2 - width(name) - count.length))}${count} `;
      const style = cursor
        ? bg(C.surface1) + fg(C.text) + BOLD
        : active
          ? bg(C.surface0) + fg(C.text) + BOLD
          : base;
      line(row, text, style);
      this.spaceHits.push({ row, index: i });
      row++;
    });
    this.newSpaceRow = row <= this.rows - 1 ? row : -1;
    if (this.newSpaceRow > 0) line(row++, " + new space", base + fg(C.overlay));
    for (; row < this.rows; row++) line(row, "", base);
    const hint = this.mode === "spaces" ? " j/k Enter Esc" : " ^B ? for keys";
    line(this.rows, hint, base + fg(C.overlay));
    return s;
  }

  private drawTabBar(col: number, w: number): string {
    const space = this.space;
    const tabs = space?.tabs ?? [];
    const items = tabs.map((tab, i) => {
      const pages = leaves(tab.root);
      const title = pageTitle(tab.focused);
      const extra = pages.length > 1 ? ` ⊞${pages.length}` : "";
      const dot = pages.some((p) => p.dialog) ? "! " : pages.some((p) => p.loading) ? "◌ " : "";
      return ` ${i + 1} ${dot}${truncate(title, 22)}${extra} `;
    });
    const plus = " + ";
    // Scroll so the active tab is visible.
    let first = 0;
    const active = space?.active ?? 0;
    const total = (from: number, to: number) => items.slice(from, to + 1).reduce((a, t) => a + width(t) + 1, 0);
    while (first < active && total(first, active) + width(plus) > w) first++;

    let s = at(1, col) + bg(C.crust);
    let used = 0;
    this.tabHits = [];
    for (let i = first; i < items.length; i++) {
      const text = items[i]!;
      const tw = width(text);
      if (used + tw + width(plus) > w) break;
      const style = i === active ? bg(C.base) + fg(C.text) + BOLD : bg(C.crust) + fg(C.overlay);
      s += style + text + RESET + bg(C.crust) + fg(C.surface1) + "│";
      this.tabHits.push({ start: col + used, end: col + used + tw, index: i });
      used += tw + 1;
    }
    this.newTabHit = { start: col + used, end: col + used + width(plus) };
    s += bg(C.crust) + fg(C.subtext) + plus;
    used += width(plus);
    const label = this.space ? ` ${this.space.name} ` : "";
    const pad = w - used;
    if (pad > 0) {
      s += bg(C.crust) + fg(C.overlay) + (pad > width(label) + 1 ? " ".repeat(pad - width(label)) + label : " ".repeat(pad));
    }
    return s + RESET;
  }

  private modeLabel(): string {
    switch (this.mode) {
      case "prefix": return " ^B ";
      case "resize": return " RESIZE ";
      case "spaces": return " SPACES ";
      case "help": return " HELP ";
      default: return "";
    }
  }

  private drawUrlBar(col: number, w: number): string {
    const page = this.focused;
    const barBg = bg(C.base);
    let s = at(2, col) + barBg;
    const mode = this.modeLabel();
    const zoom = this.zoom !== 1 ? ` ${Math.round(this.zoom * 100)}% ` : "";
    const toast = this.toast && this.toast.until > Date.now() ? ` ${this.toast.text} ` : "";
    const right = toast + zoom;
    const rightW = Math.min(width(right), Math.max(0, Math.floor(w / 2)));
    const modeW = width(mode);

    const prompt = this.prompt;
    if (prompt && prompt.kind === "dialog") {
      const d = prompt.page.dialog;
      const label =
        d?.type === "prompt" ? `${d.message} ` :
        d?.type === "confirm" ? `${d?.message}  [Enter] OK  [Esc] Cancel` :
        d?.type === "beforeunload" ? "Leave this page? [Enter] Leave  [Esc] Stay" :
        `${d?.message ?? ""}  [Enter] OK`;
      const fieldW = w - modeW - 4;
      let text = fit(` ⚠ ${label}`, d?.type === "prompt" ? Math.min(width(label) + 4, Math.floor(fieldW / 2)) : fieldW);
      s += bg(C.yellow) + fg(C.crust) + BOLD + text + RESET;
      if (d?.type === "prompt") {
        const rest = w - modeW - width(text);
        const v = prompt.edit.view(rest - 2);
        this.promptCursor = { row: 2, col: col + width(text) + 1 + v.cursorCol };
        s += bg(C.surface0) + fg(C.text) + " " + fit(v.text, rest - 1) + RESET;
      } else {
        this.promptCursor = null;
        s += barBg + " ".repeat(Math.max(0, w - modeW - width(text)));
      }
      s += bg(C.mauve) + fg(C.crust) + BOLD + mode + RESET;
      this.navHits = null;
      return s;
    }

    const back = " ← ";
    const fwd = " → ";
    const reload = page?.loading ? " ✕ " : " ⟳ ";
    const btnStyle = barBg + fg(C.subtext);
    s += btnStyle + back + fwd + reload + " ";
    const urlStart = col + width(back + fwd + reload) + 1;
    const fieldW = Math.max(4, w - (urlStart - col) - rightW - modeW - 1);
    this.navHits = {
      back: [col, col + 3],
      fwd: [col + 3, col + 6],
      reload: [col + 6, col + 9],
      url: [urlStart, urlStart + fieldW],
    };

    if (prompt && (prompt.kind === "url" || prompt.kind === "rename" || prompt.kind === "file")) {
      const label =
        prompt.kind === "rename" ? "Rename space: " :
        prompt.kind === "file" ? (prompt.multiple ? "Upload files (space-separated): " : "Upload file: ") : "";
      const v = prompt.edit.view(fieldW - 2 - width(label));
      const text = prompt.edit.selectAll
        ? `\x1b[7m${v.text}\x1b[27m`
        : v.text;
      s += bg(C.surface1) + fg(C.text) + " " + fg(C.overlay) + label + fg(C.text) + text +
        " ".repeat(Math.max(0, fieldW - 1 - width(label) - width(v.text))) + RESET;
      this.promptCursor = prompt.edit.selectAll ? null : { row: 2, col: urlStart + 1 + width(label) + v.cursorCol };
    } else {
      this.promptCursor = null;
      const url = page ? displayUrl(page) : "";
      const secure = url.startsWith("https://");
      const shown = url.replace(/^https:\/\//, "");
      const icon = page?.crashed ? fg(C.red) + "✖ " : secure ? fg(C.green) + "🔒" : fg(C.overlay) + "  ";
      s += bg(C.surface0) + " " + icon + fg(C.text) + fit(shown, fieldW - 1 - 2) + RESET;
    }
    s += barBg + " ";
    if (rightW > 0) s += barBg + fg(C.peach) + fit(right, rightW);
    if (modeW) s += bg(C.mauve) + fg(C.crust) + BOLD + mode;
    const used = (urlStart - col) + fieldW + 1 + rightW + modeW;
    if (used < w) s += RESET + barBg + " ".repeat(w - used);
    return s + RESET;
  }

  private promptCursor: { row: number; col: number } | null = null;
  private lastUploadDir = `${homedir()}/`;

  private cursorSeq(): string {
    const c = this.promptCursor;
    if (!c || this.mode === "help") return "\x1b[?25l";
    return `${at(c.row, c.col)}\x1b[6 q\x1b[?25h`;
  }

  private drawPaneChrome(): string {
    let s = "";
    const tab = this.tab;
    for (const [page, g] of this.geom) {
      if (!g.header) continue;
      const focused = tab?.focused === page;
      const style = focused ? bg(C.surface1) + fg(C.text) + BOLD : bg(C.mantle) + fg(C.overlay);
      const host = page.url.includes(MARKER) ? "" : hostOf(page.url);
      const title = pageTitle(page) === page.url.replace(/^https?:\/\//, "") ? "" : pageTitle(page);
      const flag = page.dialog ? "! " : page.loading ? "◌ " : "";
      const text = ` ${flag}${title}${title && host ? " — " : ""}${host}`;
      s += at(g.header.row, g.header.col) + style + fit(text, g.header.cols) + RESET;
    }
    for (const sep of this.seps) {
      if (sep.split.dir !== "h") continue;
      for (let r = 0; r < sep.rect.rows; r++) {
        s += at(sep.rect.row + r, sep.rect.col) + bg(C.crust) + fg(C.surface1) + "│";
      }
    }
    return s + RESET;
  }

  /** The key reference, drawn over the (blanked) pane area. */
  private helpOverlay(): string {
    const area = this.paneArea();
    const keyW = Math.max(...HELP.map(([k]) => width(k)));
    const descW = Math.max(...HELP.map(([, d]) => width(d)));
    const boxW = Math.min(area.cols - 2, keyW + descW + 7);
    const boxH = Math.min(area.rows - 1, HELP.length + 4);
    const top = area.row + Math.max(0, Math.floor((area.rows - boxH) / 2));
    const left = area.col + Math.max(0, Math.floor((area.cols - boxW) / 2));
    let s = deleteAllImages();
    for (let r = 0; r < area.rows; r++) s += at(area.row + r, area.col) + bg(C.crust) + " ".repeat(area.cols);
    const panel = bg(C.base) + fg(C.text);
    s += at(top, left) + panel + BOLD + fg(C.mauve) + fit(" termium keys", boxW) + RESET;
    s += at(top + 1, left) + panel + fit("", boxW);
    HELP.slice(0, boxH - 4).forEach(([k, d], i) => {
      const line = `  ${k.padEnd(keyW)}  ${d}`;
      s += at(top + 2 + i, left) + panel + (d === "" ? fg(C.mauve) : "") + fit(line, boxW) + RESET;
    });
    s += at(top + boxH - 2, left) + panel + fit("", boxW);
    s += at(top + boxH - 1, left) + panel + fg(C.overlay) + fit("  any key closes", boxW) + RESET;
    return s + RESET;
  }

  showToast(text: string, ms = 3000): void {
    this.toast = { text, until: Date.now() + ms };
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.queueChrome(), ms + 20);
    this.queueChrome();
  }

  // ---------------------------------------------------------- input

  handle(ev: InputEvent): void {
    if (ev.type === "key" && ev.event !== "release" && comboOf(ev) === "ctrl+q" && this.started) {
      this.opts.quit();
      return;
    }
    if (!this.ready || this.holding) {
      this.early.push(ev);
      return;
    }
    if (this.early.length) {
      const queued = this.early.splice(0);
      for (const e of queued) this.handle(e);
    }
    switch (ev.type) {
      case "key":
        return this.onKey(ev);
      case "mouse":
        return this.onMouse(ev);
      case "paste": {
        const p = this.prompt;
        if (p && (p.kind !== "dialog" || p.page.dialog?.type === "prompt")) {
          p.edit.insert(ev.text);
          this.queueChrome();
        } else if (this.focused) {
          this.cdp.send("Input.insertText", { text: ev.text }, this.focused.sessionId).catch(() => {});
        }
        return;
      }
      case "focus":
        return;
    }
  }

  private onKey(ev: KeyEvent): void {
    const release = ev.event === "release";
    if (release) {
      // Only release keys whose press reached the page.
      if (this.pageKeysDown.delete(ev.code || ev.key) && this.focused) this.sendKey(this.focused, ev);
      return;
    }
    if (isModifier(ev)) {
      if (!this.prompt && this.mode === "normal" && this.focused) this.sendKey(this.focused, ev);
      return;
    }
    const combo = comboOf(ev);

    if (this.mode === "help") {
      this.mode = "normal";
      this.fullRedraw();
      return;
    }
    if (this.mode === "prefix") {
      this.mode = "normal";
      this.prefixAction(combo, ev);
      this.queueChrome();
      return;
    }
    if (this.mode === "resize") return this.resizeKey(combo);
    if (this.mode === "spaces") return this.spacesKey(combo);
    if (combo === "ctrl+b") {
      this.mode = "prefix";
      this.queueChrome();
      return;
    }
    if (this.prompt) {
      const allowed = this.prompt.kind === "dialog" ? DIALOG_GLOBALS : PROMPT_GLOBALS;
      if (allowed.has(combo) && this.globalShortcut(combo)) return;
      return this.promptKey(ev);
    }
    if (this.globalShortcut(combo)) return;
    const page = this.focused;
    if (!page) return;
    this.sendKey(page, ev);
    if (combo === "ctrl+c" || combo === "ctrl+x") void this.copySelection(page);
  }

  private globalShortcut(combo: string): boolean {
    const page = this.focused;
    switch (combo) {
      case "ctrl+l":
      case "f6":
      case "alt+d":
        if (page) this.openUrlPrompt(page);
        return true;
      case "ctrl+t":
        this.newTab();
        return true;
      case "ctrl+w":
        if (page) this.closePage(page);
        return true;
      case "ctrl+q":
        this.opts.quit();
        return true;
      case "alt+arrowleft":
        if (page) void this.history(page, -1);
        return true;
      case "alt+arrowright":
        if (page) void this.history(page, 1);
        return true;
      case "ctrl+r":
      case "f5":
        if (page) this.reload(page);
        return true;
      case "ctrl+shift+r":
      case "shift+f5":
        if (page) this.reload(page, true);
        return true;
      case "alt+=":
      case "alt++":
        this.setZoom(this.zoom * 1.1);
        return true;
      case "alt+-":
        this.setZoom(this.zoom / 1.1);
        return true;
      case "alt+0":
        this.setZoom(1);
        return true;
    }
    return false;
  }

  private prefixAction(combo: string, ev: KeyEvent): void {
    const tab = this.tab;
    const page = this.focused;
    const space = this.space;
    if (/^[1-9]$/.test(combo)) return this.selectTab(Number(combo) - 1);
    switch (combo) {
      case "ctrl+b":
        if (page) {
          this.sendKey(page, ev);
          this.pageKeysDown.delete(ev.code || ev.key);
          this.sendKey(page, { ...ev, event: "release" });
        }
        return;
      case "c": return this.newTab();
      case "n": return this.selectTab((space?.active ?? 0) + 1, true);
      case "p": return this.selectTab((space?.active ?? 0) - 1, true);
      case "shift+x": if (tab) this.closeTab(tab); return;
      case "x": if (page) this.closePage(page); return;
      case "v": return this.split("h");
      case "-": return this.split("v");
      case "h": case "j": case "k": case "l":
      case "arrowleft": case "arrowdown": case "arrowup": case "arrowright":
        return this.focusDir(combo);
      case "z":
        if (tab && leaves(tab.root).length > 1) {
          tab.zoomed = !tab.zoomed;
          this.relayout();
          this.fullRedraw();
        }
        return;
      case "r":
        if (tab && leaves(tab.root).length > 1) this.mode = "resize";
        return;
      case "w":
        this.spaceCursor = this.activeSpace;
        this.setMode("spaces");
        return;
      case "shift+n": return this.newSpace();
      case "shift+w":
        if (space) this.prompt = { kind: "rename", edit: new LineEdit(space.name, true), space };
        return;
      case "shift+d":
        if (space) for (const t of [...space.tabs]) this.closeTab(t);
        return;
      case "b":
        this.sidebar = !this.sidebar;
        return this.relayoutAndRedraw();
      case "q": this.opts.quit(); return;
      case "?":
        this.mode = "help";
        this.fullRedraw();
        return;
    }
  }

  private relayoutAndRedraw(): void {
    this.relayout();
    this.fullRedraw();
  }

  private resizeKey(combo: string): void {
    const tab = this.tab;
    const page = this.focused;
    const dirs: Record<string, [Dir, number]> = {
      h: ["h", -0.05], arrowleft: ["h", -0.05], l: ["h", 0.05], arrowright: ["h", 0.05],
      k: ["v", -0.05], arrowup: ["v", -0.05], j: ["v", 0.05], arrowdown: ["v", 0.05],
      "shift+h": ["h", -0.15], "shift+l": ["h", 0.15], "shift+k": ["v", -0.15], "shift+j": ["v", 0.15],
    };
    const d = dirs[combo];
    if (d && tab && page) {
      const found = enclosingSplit(tab.root, page, d[0]);
      if (found) {
        found.split.ratio = Math.max(0.1, Math.min(0.9, found.split.ratio + d[1]));
        this.relayoutAndRedraw();
      }
      return;
    }
    this.mode = "normal";
    this.queueChrome();
  }

  private spacesKey(combo: string): void {
    const n = this.spaces.length;
    if (combo === "j" || combo === "arrowdown") this.spaceCursor = (this.spaceCursor + 1) % n;
    else if (combo === "k" || combo === "arrowup") this.spaceCursor = (this.spaceCursor - 1 + n) % n;
    else if (/^[1-9]$/.test(combo)) {
      const i = Number(combo) - 1;
      if (i < n) this.switchSpace(i);
      this.mode = "normal";
    } else if (combo === "enter") {
      this.mode = "normal";
      this.switchSpace(this.spaceCursor);
    } else if (combo === "shift+n") {
      this.mode = "normal";
      this.newSpace();
    } else {
      this.mode = "normal";
    }
    this.setMode(this.mode, true);
  }

  /** Changes mode, re-laying out when that shows or hides the sidebar. */
  private setMode(mode: Mode, wasSpaces = this.mode === "spaces"): void {
    this.mode = mode;
    const sidebarChanged = !this.sidebar && wasSpaces !== (mode === "spaces");
    if (sidebarChanged) this.relayoutAndRedraw();
    else this.queueChrome();
  }

  private promptKey(ev: KeyEvent): void {
    const prompt = this.prompt!;
    if (prompt.kind === "dialog" && prompt.page.dialog?.type !== "prompt") {
      if (ev.key === "Enter" || ev.key === "Escape") {
        this.answerDialog(prompt.page, ev.key === "Enter", "");
      }
      return;
    }
    const result = prompt.edit.key(ev);
    if (result === "cancel") {
      if (prompt.kind === "dialog") this.answerDialog(prompt.page, false, "");
      this.prompt = null;
    } else if (result === "submit") {
      this.prompt = null;
      const text = prompt.edit.text;
      if (prompt.kind === "url") {
        const url = toUrl(text, this.opts.search);
        if (url && this.pages.has(prompt.page.sessionId)) this.navigate(prompt.page, url);
      } else if (prompt.kind === "rename") {
        if (text.trim()) prompt.space.name = text.trim();
      } else if (prompt.kind === "file") {
        this.uploadFiles(prompt, text);
      } else {
        this.answerDialog(prompt.page, true, text);
      }
    }
    this.queueChrome();
  }

  private uploadFiles(prompt: Extract<Prompt, { kind: "file" }>, text: string): void {
    const home = homedir();
    let files = splitPaths(text).map((f) => (f === "~" || f.startsWith("~/") ? home + f.slice(1) : f));
    if (!prompt.multiple) files = files.slice(0, 1);
    const missing = files.find((f) => !existsSync(f) || !statSync(f).isFile());
    if (!files.length || missing) {
      this.showToast(missing ? `No such file: ${missing}` : "No file given");
      this.prompt = { ...prompt, edit: new LineEdit(text, false) };
      return;
    }
    this.lastUploadDir = `${dirname(files[0]!)}/`;
    this.cdp
      .send("DOM.setFileInputFiles", { files, backendNodeId: prompt.backendNodeId }, prompt.page.sessionId)
      .then(() => this.showToast(`Attached ${files.length === 1 ? files[0] : `${files.length} files`}`))
      .catch((e) => this.showToast(`Upload failed: ${e}`));
  }

  private answerDialog(page: Page, accept: boolean, promptText: string): void {
    if (page.dialog?.type === "beforeunload" && !accept) page.navSeq++;
    this.cdp
      .send("Page.handleJavaScriptDialog", { accept, promptText }, page.sessionId)
      .catch((e) => this.opts.log(`dialog: ${e}`));
    page.dialog = null;
    this.prompt = null;
    this.queueChrome();
  }

  private openUrlPrompt(page: Page, text?: string): void {
    const current = text ?? (page.url === "about:blank" || page.url.includes(MARKER) ? "" : page.url);
    this.prompt = { kind: "url", edit: new LineEdit(current, true), page };
    this.queueChrome();
  }

  private sendKey(page: Page, ev: KeyEvent): void {
    const modifiers = modBits(ev.mods);
    const base = {
      modifiers,
      key: ev.key,
      code: ev.code,
      windowsVirtualKeyCode: ev.vk,
      nativeVirtualKeyCode: ev.vk,
      location: ev.location,
    };
    const sid = page.sessionId;
    const send = (params: object) => this.cdp.send("Input.dispatchKeyEvent", params, sid).catch(() => {});
    if (ev.event === "release") {
      void send({ type: "keyUp", ...base });
      return;
    }
    const text = ev.text;
    void send({
      type: text ? "keyDown" : "rawKeyDown",
      ...base,
      text,
      unmodifiedText: text,
      autoRepeat: ev.event === "repeat",
      commands: editCommands(ev),
    });
    if (ev.legacy) void send({ type: "keyUp", ...base });
    else this.pageKeysDown.add(ev.code || ev.key);
  }

  private async copySelection(page: Page): Promise<void> {
    try {
      const { result } = await this.cdp.send(
        "Runtime.evaluate",
        {
          expression: `(() => { const a = document.activeElement;
            if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA") && typeof a.selectionStart === "number")
              return a.value.slice(a.selectionStart, a.selectionEnd);
            return String(getSelection()); })()`,
          returnByValue: true,
        },
        page.sessionId,
      );
      const text = typeof result?.value === "string" ? result.value : "";
      if (text) {
        out(setClipboard(text));
        this.showToast(`Copied ${text.length} characters`, 1500);
      }
    } catch {}
  }

  private setZoom(z: number): void {
    this.zoom = Math.max(0.3, Math.min(5, Math.round(z * 100) / 100));
    if (Math.abs(this.zoom - 1) < 0.04) this.zoom = 1;
    this.relayoutAndRedraw();
  }

  // ---------------------------------------------------------- actions

  newTab(url?: string): void {
    const space = this.space;
    if (!space) return;
    void this.createPage({ kind: "tab", space, index: space.active + 1, editUrl: !url, url });
  }

  private split(dir: Dir): void {
    const tab = this.tab;
    const page = this.focused;
    if (!tab || !page) return;
    void this.createPage({ kind: "split", tab, next: page, dir, editUrl: true });
  }

  private selectTab(i: number, wrap = false): void {
    const space = this.space;
    if (!space || space.tabs.length === 0) return;
    const n = space.tabs.length;
    if (wrap) i = ((i % n) + n) % n;
    if (i < 0 || i >= n || i === space.active) return;
    space.active = i;
    this.prompt = this.prompt?.kind === "rename" ? this.prompt : null;
    this.relayoutAndRedraw();
  }

  private switchSpace(i: number): void {
    if (i < 0 || i >= this.spaces.length) return;
    this.activeSpace = i;
    this.prompt = null;
    this.relayoutAndRedraw();
  }

  private newSpace(): void {
    const space = this.newSpaceModel();
    this.spaces.push(space);
    this.activeSpace = this.spaces.length - 1;
    void this.createPage({ kind: "tab", space, index: 0, editUrl: true });
    this.relayoutAndRedraw();
  }

  private focusDir(combo: string): void {
    const tab = this.tab;
    const page = this.focused;
    if (!tab || !page || tab.zoomed) return;
    const map: Record<string, "h" | "j" | "k" | "l"> = {
      h: "h", j: "j", k: "k", l: "l", arrowleft: "h", arrowdown: "j", arrowup: "k", arrowright: "l",
    };
    const next = neighbor([...this.geom.values()], page, map[combo]!);
    if (next) this.focusPage(next);
  }

  private focusPage(page: Page): void {
    const tab = this.tab;
    if (!tab || tab.focused === page) return;
    tab.focused = page;
    this.syncPrompt();
    this.queueChrome();
  }

  // ---------------------------------------------------------- mouse

  private onMouse(ev: MouseEvent): void {
    // Pixel position (0-based) of the pointer within the grid.
    const px = this.pixelMouse ? ev.x - 1 : (ev.x - 0.5) * this.cellW;
    const py = this.pixelMouse ? ev.y - 1 : (ev.y - 0.5) * this.cellH;
    const col = Math.floor(px / this.cellW) + 1;
    const row = Math.floor(py / this.cellH) + 1;

    if (this.mode === "help") {
      if (ev.action === "press") {
        this.mode = "normal";
        this.fullRedraw();
      }
      return;
    }

    if (this.drag) {
      if (ev.action === "move") return this.dragTo(col, row);
      if (ev.action === "release") {
        this.drag = null;
        this.relayoutAndRedraw();
      }
      return;
    }

    // Pointer captured by a page while a button is held.
    const captured = this.mouseCapture;
    if (captured && (ev.action === "move" || ev.action === "release")) {
      this.pageMouse(captured, ev, px, py);
      return;
    }

    if (ev.action === "press" && this.chromeClick(ev, col, row)) return;

    const g = [...this.geom.values()].find((p) => inRect(p.content, col, row));
    if (!g) return;
    if (ev.action === "press") {
      if (this.prompt?.kind === "url" || this.prompt?.kind === "rename") {
        this.prompt = null;
        this.queueChrome();
      }
      if (this.mode !== "normal") this.setMode("normal");
      this.focusPage(g.item);
    }
    this.pageMouse(g.item, ev, px, py);
  }

  /** Handles clicks on the sidebar, tab bar, URL bar, pane headers and separators. */
  private chromeClick(ev: MouseEvent, col: number, row: number): boolean {
    const mainCol = this.mainCol();
    if (col < mainCol) {
      if (ev.button !== 0) return true;
      const hit = this.spaceHits.find((h) => h.row === row);
      if (hit) {
        if (this.mode === "spaces") this.mode = "normal";
        this.switchSpace(hit.index);
      } else if (row === this.newSpaceRow) this.newSpace();
      return true;
    }
    if (row === 1) {
      const hit = this.tabHits.find((h) => col >= h.start && col < h.end);
      if (hit) {
        const tab = this.space?.tabs[hit.index];
        if (ev.button === 1 && tab) this.closeTab(tab);
        else if (ev.button === 0) this.selectTab(hit.index);
      } else if (this.newTabHit && col >= this.newTabHit.start && col < this.newTabHit.end && ev.button === 0) {
        this.newTab();
      }
      return true;
    }
    if (row === 2) {
      const page = this.focused;
      const n = this.navHits;
      if (!page || !n || ev.button !== 0) return true;
      if (col >= n.back[0] && col < n.back[1]) void this.history(page, -1);
      else if (col >= n.fwd[0] && col < n.fwd[1]) void this.history(page, 1);
      else if (col >= n.reload[0] && col < n.reload[1]) {
        if (page.loading) this.cdp.send("Page.stopLoading", {}, page.sessionId).catch(() => {});
        else this.reload(page);
      } else if (col >= n.url[0] && col < n.url[1] && !this.prompt) this.openUrlPrompt(page);
      return true;
    }
    if (ev.button === 7 || ev.button === 8) {
      const page = this.focused;
      if (page) void this.history(page, ev.button === 7 ? -1 : 1);
      return true;
    }
    const sep = this.seps.find((s) => inRect(s.rect, col, row));
    if (sep && ev.button === 0) {
      // Stacked panes share the lower pane's header as their divider.
      const pane = [...this.geom.values()].find((p) => p.header && inRect(p.header, col, row));
      if (pane) this.focusPage(pane.item);
      this.drag = { sep, moved: false };
      return true;
    }
    const header = [...this.geom.values()].find((p) => p.header && inRect(p.header, col, row));
    if (header) {
      if (ev.button === 1) this.closePage(header.item);
      else this.focusPage(header.item);
      return true;
    }
    return false;
  }

  private dragTo(col: number, row: number): void {
    const d = this.drag!;
    const { split, parent } = d.sep;
    const ratio =
      split.dir === "h"
        ? (col - parent.col) / Math.max(1, parent.cols - 1)
        : (row - parent.row) / Math.max(1, parent.rows);
    const next = Math.max(0.1, Math.min(0.9, ratio));
    if (Math.abs(next - split.ratio) < 0.005) return;
    split.ratio = next;
    d.moved = true;
    this.relayoutAndRedraw();
    // Keep dragging the same split after the relayout rebuilt the handles.
    const same = this.seps.find((s) => s.split === split);
    if (same) d.sep = same;
  }

  private pageMouse(page: Page, ev: MouseEvent, px: number, py: number): void {
    const g = this.geom.get(page);
    if (!g || !page.css) return;
    const devW = g.content.cols * this.cellW;
    const devH = g.content.rows * this.cellH;
    const x = Math.max(0, Math.min(page.css.w - 1, ((px - (g.content.col - 1) * this.cellW) * page.css.w) / devW));
    const y = Math.max(0, Math.min(page.css.h - 1, ((py - (g.content.row - 1) * this.cellH) * page.css.h) / devH));
    const modifiers = modBits(ev.mods);
    const sid = page.sessionId;
    const send = (params: object) => this.cdp.send("Input.dispatchMouseEvent", params, sid).catch(() => {});
    // Back/forward buttons navigate through chromeClick; never forward them.
    const names = ["left", "middle", "right", "none", "", "", "", "", ""];
    const bits = [1, 4, 2, 0, 0, 0, 0, 8, 16];

    if (ev.action === "wheel") {
      const step = 60;
      let dx = ev.wheel === "left" ? -step : ev.wheel === "right" ? step : 0;
      let dy = ev.wheel === "up" ? -step : ev.wheel === "down" ? step : 0;
      if (ev.mods.shift && dx === 0) [dx, dy] = [dy, 0];
      void send({ type: "mouseWheel", x, y, deltaX: dx, deltaY: dy, modifiers });
      return;
    }
    if (ev.action === "move") {
      const button = this.mouseButtons & 1 ? "left" : this.mouseButtons & 2 ? "right" : this.mouseButtons & 4 ? "middle" : "none";
      this.queueMove(() => send({ type: "mouseMoved", x, y, button, buttons: this.mouseButtons, modifiers }));
      return;
    }
    const name = names[ev.button] ?? "none";
    if (name === "none" || !name) return;
    if (ev.action === "press") {
      const now = Date.now();
      const lc = this.lastClick;
      const near = Math.abs(lc.x - px) < this.cellW && Math.abs(lc.y - py) < this.cellH;
      lc.count = now - lc.time < 450 && near && lc.button === ev.button ? Math.min(3, lc.count + 1) : 1;
      Object.assign(lc, { time: now, x: px, y: py, button: ev.button });
      this.mouseButtons |= bits[ev.button] ?? 0;
      this.mouseCapture = page;
      void send({ type: "mousePressed", x, y, button: name, buttons: this.mouseButtons, clickCount: lc.count, modifiers });
    } else {
      this.mouseButtons &= ~(bits[ev.button] ?? 0);
      if (this.mouseButtons === 0) this.mouseCapture = null;
      void send({ type: "mouseReleased", x, y, button: name, buttons: this.mouseButtons, clickCount: this.lastClick.count, modifiers });
    }
  }

  /** Coalesces pointer motion: at most one move in flight, latest wins. */
  private queueMove(fn: () => Promise<unknown>): void {
    if (this.moveInFlight) {
      this.pendingMove = fn;
      return;
    }
    this.moveInFlight = true;
    fn().finally(() => {
      this.moveInFlight = false;
      const next = this.pendingMove;
      this.pendingMove = null;
      if (next) this.queueMove(next);
    });
  }
}

// ---------------------------------------------------------------- helpers

function isModifier(ev: KeyEvent): boolean {
  return ev.key === "Shift" || ev.key === "Control" || ev.key === "Alt" || ev.key === "Meta";
}

/** "ctrl+shift+r", "alt+arrowleft", "?" (shift dropped for symbols). */
export function comboOf(ev: KeyEvent): string {
  const k = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key.toLowerCase();
  const letterOrNamed = ev.key.length > 1 || /[a-z]/i.test(ev.key);
  const parts: string[] = [];
  if (ev.mods.ctrl) parts.push("ctrl");
  if (ev.mods.alt) parts.push("alt");
  if (ev.mods.meta) parts.push("super");
  if (ev.mods.shift && letterOrNamed) parts.push("shift");
  parts.push(k === " " ? "space" : k);
  return parts.join("+");
}

function modBits(m: Mods): number {
  return (m.alt ? 1 : 0) | (m.ctrl ? 2 : 0) | (m.meta ? 4 : 0) | (m.shift ? 8 : 0);
}

/** Editing commands headless Chromium doesn't map from keys on its own. */
function editCommands(ev: KeyEvent): string[] | undefined {
  if (!ev.mods.ctrl || ev.mods.alt || ev.mods.meta) return undefined;
  switch (ev.key.toLowerCase()) {
    case "a": return ev.mods.shift ? undefined : ["selectAll"];
    case "c": return ["copy"];
    case "x": return ["cut"];
    case "v": return ["paste"];
    case "z": return ev.mods.shift ? ["redo"] : ["undo"];
    case "y": return ["redo"];
  }
  return undefined;
}

function hostOf(url: string): string {
  try {
    const u = new URL(url);
    return u.host || (u.protocol === "about:" ? url : "");
  } catch {
    return "";
  }
}

function pageTitle(page: Page): string {
  const blank = (s: string) => !s || s.includes(MARKER) || s === "about:blank";
  if (!blank(page.title)) return page.title;
  return blank(page.url) ? "New Tab" : page.url.replace(/^https?:\/\//, "");
}

function displayUrl(page: Page): string {
  if (page.url.includes(MARKER) || page.url === "about:blank") return "";
  return page.url;
}

export { DEFAULT_SEARCH };
