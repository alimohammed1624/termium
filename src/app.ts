// termium's core: spaces (windows) -> tabs -> split panes, each pane showing
// one headless browser page rendered with the kitty graphics protocol.

import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, renameSync, rmSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { randomInt } from "node:crypto";
import { basename, dirname, extname, join, resolve as resolvePath } from "node:path";
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
  replaceLeaf,
  splitLeaf,
  type Dir,
  type Node,
  type PaneGeom,
  type Rect,
  type SepGeom,
} from "./layout";
import {
  PLACEHOLDER_IDS,
  PLACEHOLDER_MAX,
  SYNC_END,
  SYNC_START,
  deleteImage,
  drawImage,
  drawImagePieces,
  out,
  placeholderCells,
  placeholderImageId,
  placeholderSpan,
  setClipboard,
  transmitVirtual,
} from "./terminal";
import { decodePng, encodeRegion, type Raster } from "./png";
import { SELECT_POPUP } from "./select-popup";
import { CONTEXT_PROBE, ClickAreas, Menu, around, type MenuEntry, type MenuStyle } from "./menu";
import { DEFAULT_SEARCH, LineEdit, fit, splitPaths, toUrl, truncate, width } from "./text";
import type { SavedLayout, SavedNode } from "./session";
import { UPGRADE_CMD, displayVersion, isNewer, parseVersion, stepLabel, type Step } from "./update";

// ---------------------------------------------------------------- model

export interface Page {
  /** A short number for the page, unique in the session (what `termium ctl` calls a tab). */
  num: number;
  /** Bumped on every new document in the page (or its frames): see agentIds. */
  docGen?: number;
  /** Element ids `termium ctl snapshot` handed out for the document of generation `gen`. */
  agentIds?: { gen: number; nodes: Set<number> };
  /** A size check waiting for the once-a-second limit (see trailingSizeCheck). */
  sizeRecheck?: ReturnType<typeof setTimeout>;
  /** An agent is closing it (see agentClose): "refused" once the page said it has unsaved changes. */
  agentClosing?: "yes" | "force" | "refused";
  /** Its browser context (another DevTools client's newContext() makes others). */
  contextId?: string;
  targetId: string;
  sessionId: string;
  url: string;
  title: string;
  loading: boolean;
  crashed: boolean;
  /** A pending JavaScript dialog, and the session (page or iframe) to answer it on. */
  dialog: { type: string; message: string; defaultPrompt: string; sessionId: string; edit?: LineEdit } | null;
  /** Set while termium is closing the page (beforeunload may still keep it). */
  closing: boolean;
  /** A file input waiting for a path (shown when the page is focused). */
  fileChooser: { sessionId: string; backendNodeId: number; multiple: boolean } | null;

  /** Viewport the page should have, in CSS px (mouse mapping uses it). */
  css: { w: number; h: number; dsf: number } | null;
  /** Screencast size the page should have, in device px (null: hidden). */
  casting: { w: number; h: number } | null;
  /** The last (low-resolution) screencast frame, at HiDPI where frames only signal changes. */
  lastCast?: string;
  /** What the browser has actually been given and confirmed. */
  appliedCss: { w: number; h: number; dsf: number } | null;
  appliedCast: { w: number; h: number } | null;
  /** The viewport/screencast target already queued, to skip duplicates. */
  queuedKey: string | null;
  /** Viewport changes, screencast restarts and screenshots run one at a time. */
  ops: Promise<void>;
  lastFrame: string | null;
  frameSeq: number;
  navSeq: number;
  /** When a Page.navigate was sent that hasn't answered yet (0 if none). */
  navStarted: number;
  /** When title/URL were last fetched. */
  infoAt: number;
  /** Image ids of its picture on screen (several when a wide pane is tiled). */
  imageIds: number[];
  /** Placeholder ids (256-colour indexes) it holds, one per tile, with unicode placeholders (tmux). */
  phIds: number[];
  /** Where its image currently sits, so a stale placement can be redrawn. */
  placed: Rect | null;
  /** Restart the screencast even if its size is unchanged (a terminal attached). */
  restartCast?: boolean;
  /** When its viewport or screencast last changed: frames of another size just after are stale. */
  viewportAt?: number;
  /** Since its viewport or screencast last changed, no frame of the right shape has come yet (see onFrame). */
  awaitingShape?: boolean;
  /** Screencast starts that failed in a row (retried a while). */
  castRetries?: number;
  /** When termium last put its viewport back after another DevTools client changed it. */
  reassertedAt?: number;
  /** A navigation of its main frame has started and not yet committed (its old document still answers). */
  navigating?: boolean;
  /** A size check after a resize, pending (see sizeChanged). */
  sizeCheck?: ReturnType<typeof setTimeout>;
  /**
   * The page's size in CSS px while another DevTools client holds it at
   * one of its own (see holdsForeignSize): frames are drawn stretched to
   * the pane, and the mouse is mapped to match.
   */
  actual?: { w: number; h: number };
  /** Checks, while `actual` is set, whether that client has let go. */
  foreignTimer?: ReturnType<typeof setInterval>;
  /** termium's viewport failed to take this many times in a row (a page busy loading can miss it). */
  foreignTries?: number;
  loadingTries?: number;
  foreignPolls?: number;
}

/** A page as `termium ctl tabs` lists it. */
export interface AgentTab {
  id: number;
  targetId: string;
  url: string;
  title: string;
  /** The page the attached terminal is focused on (input goes there). */
  active: boolean;
  /** Shown on screen now (in the current tab of the current space, with a terminal attached). */
  visible: boolean;
  space: number;
  spaceName: string;
  tab: number;
  pane: number;
  loading: boolean;
  dialog: { type: string; message: string } | null;
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
  /** Tabs most recently shown first: closing the current tab returns to the previous one. */
  recent: Tab[];
}

type Placement =
  | { kind: "tab"; space: Space; index: number; editUrl: boolean; url?: string; background?: boolean; agent?: boolean }
  | { kind: "split"; tab: Tab; next: Page; dir: Dir; editUrl: boolean; url?: string }
  | { kind: "replace"; old: Page; url: string };

type Prompt =
  | { kind: "url"; edit: LineEdit; page: Page }
  | { kind: "file"; edit: LineEdit; page: Page; sessionId: string; backendNodeId: number; multiple: boolean }
  | { kind: "rename"; edit: LineEdit; space: Space }
  | { kind: "dialog"; edit: LineEdit; page: Page }
  | { kind: "confirm"; tag: "quit" | "close" | "restart"; edit: LineEdit; message: string; onYes: () => void };

type Mode = "normal" | "prefix" | "resize" | "spaces" | "help" | "update";

/**
 * The update box: the offer (update now, later, skip), the update's
 * progress, then restart; or why it failed and how to update by hand.
 * "installed": a newer termium is on disk (updated from the shell) while
 * this session still runs the old one.
 */
interface UpdateBox {
  tag: string;
  state: "offer" | "working" | "done" | "failed" | "installed";
  step?: Step;
  error?: string;
  /** The binary an update replaced. */
  path?: string;
}

/** What the session server does for the update box. */
export interface UpdateHooks {
  /** Why `u` can't update this termium (run from source, folder not writable…), or null. */
  blocker(): string | null;
  /** Download, verify and install release `tag` (reported back through updateStep/updateDone). */
  start(tag: string): void;
  /** Never offer `tag` again: resolves to whether that was saved (for later sessions too). */
  skip(tag: string): Promise<boolean>;
  /** Restart the session into the termium on disk, reopening its spaces and tabs (`confirmed`: the person said yes to unsaved changes). */
  restart(confirmed: boolean): void;
}


export interface AppOptions {
  scale: number | null; // explicit device scale factor
  search: string;
  downloadDir: string;
  /** Where downloads land (under generated names) before being moved to downloadDir. */
  downloadStaging: string;
  quit: () => void;
  /** Detaches the terminal; the session keeps running. */
  detach: () => void;
  log: (msg: string) => void;
  /** The version this session runs. */
  version: string;
  update?: UpdateHooks;
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
  "ctrl+t", "ctrl+w", "ctrl+r", "f5", "shift+f5", "ctrl+shift+r", "alt+arrowleft", "alt+arrowright",
  "alt+=", "alt++", "alt+-", "alt+0",
]);
/**
 * Browser shortcuts a page never sees in Chrome (window/tab management).
 * Forwarded, the headless browser would act on them (Ctrl+Shift+W closes
 * every page), so they're dropped.
 */
const BROWSER_RESERVED = new Set([
  "ctrl+n", "ctrl+shift+n", "ctrl+shift+t", "ctrl+shift+w", "ctrl+tab", "ctrl+shift+tab", "alt+f4", "ctrl+shift+q",
]);
/**
 * Browser shortcuts pages may use themselves (Ctrl+S in an editor, Ctrl+K
 * palettes). They're delivered to the page as DOM events only, so the
 * page sees them but the browser's own action (save dialog, history,
 * devtools, zoom…) can't run behind termium's back.
 */
const BROWSER_SHORTCUTS = new Set([
  "ctrl+s", "ctrl+p", "ctrl+o", "ctrl+d", "ctrl+f", "ctrl+g", "ctrl+shift+g", "ctrl+h", "ctrl+j", "ctrl+u",
  "ctrl+k", "ctrl+e", "ctrl+=", "ctrl+-", "ctrl+0", "ctrl+shift+b", "ctrl+shift+o", "ctrl+shift+delete",
  "ctrl+shift+i", "ctrl+shift+j", "ctrl+shift+c", "ctrl+shift+m", "ctrl+pageup", "ctrl+pagedown",
  "ctrl+shift+pageup", "ctrl+shift+pagedown", "f3", "f7", "f12", "alt+home", "alt+f", "alt+e", "alt+shift+i",
  "alt+shift+p", "ctrl+1", "ctrl+2", "ctrl+3", "ctrl+4", "ctrl+5", "ctrl+6", "ctrl+7", "ctrl+8", "ctrl+9",
]);

/** Ctrl+B as a key, for what menus do in its name (Ctrl+B Ctrl+B sends it to the page). */
const CTRL_B: KeyEvent = {
  type: "key", key: "b", code: "KeyB", vk: 66, text: "", mods: { shift: false, alt: false, ctrl: true, meta: false },
  event: "press", location: 0, legacy: false,
};

/** A plain letter key, for a click that does what that key does. */
const letterKey = (k: string): KeyEvent => ({
  ...CTRL_B, key: k, code: `Key${k.toUpperCase()}`, vk: k.toUpperCase().charCodeAt(0), text: k, mods: { ...CTRL_B.mods, ctrl: false },
});

/** While a page is blocked on a JavaScript dialog, only these make sense. */
const DIALOG_GLOBALS = new Set(["ctrl+t", "alt+=", "alt++", "alt+-", "alt+0"]);

/** The viewport of a page opened while no terminal is attached (until one is). */
const DETACHED_VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false, screenWidth: 1920, screenHeight: 1080 };

const MENU_STYLE: MenuStyle = {
  panel: bg(C.surface0) + fg(C.text),
  active: bg(C.blue) + fg(C.crust),
  key: fg(C.overlay),
  disabled: fg(C.surface1),
  separator: fg(C.surface1),
  title: fg(C.mauve) + BOLD,
};

const SIDEBAR_W = 22;
const TOP_ROWS = 2;
/** URL fragment that marks pages termium created; random so real URLs never match. */
const MARKER = `#termium-${crypto.randomUUID().slice(0, 8)}-`;

const HELP: [string, string][] = [
  ["Ctrl+L / F6 / Alt+D", "edit address"],
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
  ["d", "detach (termium attach resumes)"],
  ["U", "update termium / restart into it"],
  ["q", "quit"],
  ["?", "this help"],
];

// ---------------------------------------------------------------- app

export class App {
  /** Screencast starts failed on purpose so far (TERMIUM_TEST_FAIL_CASTS, tests only). */
  static failedCasts = 0;
  spaces: Space[] = [];
  activeSpace = 0;
  pages = new Map<string, Page>(); // by sessionId
  private byTarget = new Map<string, Page>();

  cols = 80;
  rows = 24;
  cellW = 10;
  cellH = 20;
  pixelMouse = false;
  /** The attached terminal's working directory (relative paths typed there mean this). */
  cwd = process.cwd();
  /** Draw pages with unicode placeholders (inside tmux) rather than placing images at cells. */
  placeholders = false;
  /** Whether a terminal is attached; detached, nothing is drawn and screencasts stop. */
  attached = false;
  private phInUse = new Set<number>();
  private phNext = 1;
  /** High byte of placeholder image ids, picked per terminal (see placeholderImageId). */
  private phHigh = 1;
  /** Placeholder colours are RGB (24-bit ids) rather than 256-colour indexes. */
  private phRgb = false;
  /** Random start of this terminal's RGB placeholder colours. */
  private phBase = 0;
  /** Placeholder indexes whose pictures still wait for their (deferred) delete. */
  private phReleasing: number[] = [];
  private staleTimer: ReturnType<typeof setTimeout> | null = null;
  private repaintTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Pictures of pages that went off screen, deleted with the next
   * (synchronized) update rather than at once, so their panes never show
   * empty in between.
   */
  private staleImages: number[] = [];
  /** Inside fullRedraw: one synchronized update around everything it draws. */
  private redrawing = false;

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
  /** Clickable chrome registered as it's drawn (buttons, the × on tabs and panes...). */
  private clicks = new ClickAreas();
  /** An open context menu or dropdown: it has the mouse and keyboard until it closes. */
  private menu: Menu | null = null;
  /** The tab shown when the menu opened. */
  private menuTab: Tab | undefined;
  /** The tab under the pointer (it shows its ×), or -1. */
  private tabHover = -1;
  /** First tab shown when the tab bar was scrolled by hand (wheel, ‹ ›); null: keep the active tab in view. */
  private tabScroll: number | null = null;
  private tabRange = { first: 0, last: -1 };
  /** A tab or space being dragged to a new place (pressed on it, button still down). */
  private reorder: { kind: "tab"; tab: Tab } | { kind: "space"; space: Space } | null = null;

  private nextImage = 100;
  private nextTabId = 1;
  private nextSpaceId = 1;
  private nextMarker = 1;
  private nextPageNum = 1;
  private placements = new Map<string, Placement>(); // by marker
  /** Keys whose keydown went to a page, and which page, so the keyup follows it. */
  private pageKeysDown = new Map<string, { page: Page; ev: KeyEvent }>();
  /** iframe (out-of-process) and worker sessions, mapped to the page they belong to. */
  private frameOwner = new Map<string, Page>();
  private downloads = new Map<string, string>(); // guid -> suggested file name
  private lastMiddlePress = 0;
  private mouseCapture: Page | null = null;
  private mouseButtons = 0;
  private lastClick = { time: 0, x: 0, y: 0, button: -1, count: 0 };
  private drag: { sep: SepGeom<Page>; moved: boolean } | null = null;
  private hoverPage: Page | null = null;
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

  /** Starts the UI; how much of `restore` was reopened ("none" without one). */
  async start(initialUrl: string | null, restore?: SavedLayout | null, notice?: string): Promise<"all" | "some" | "none"> {
    const cdp = this.cdp;
    cdp.on("Target.attachedToTarget", (p, parent) => this.onAttached(p, parent).catch((e) => this.opts.log(String(e))));
    cdp.on("Target.detachedFromTarget", (p) => {
      // Commands still waiting on that session will never be answered.
      this.cdp.failSession(p.sessionId);
      this.frameOwner.delete(p.sessionId);
      this.onGone(this.pages.get(p.sessionId));
    });
    cdp.on("Target.targetDestroyed", (p) => this.onGone(this.byTarget.get(p.targetId)));
    cdp.on("Target.targetInfoChanged", ({ targetInfo }) => {
      const page = this.byTarget.get(targetInfo.targetId);
      if (!page) return;
      page.url = targetInfo.url;
      page.title = targetInfo.title;
      this.queueChrome();
    });
    cdp.on("Page.screencastFrame", (p, sid) => this.onFrame(p, sid));
    // Whoever resized it: termium, or another DevTools client (see sizeChanged).
    cdp.on("Page.frameResized", (_p, sid) => {
      const page = sid ? this.pages.get(sid) : undefined;
      if (page) this.sizeChanged(page);
    });
    cdp.on("Page.frameStartedLoading", (p, sid) => this.setLoading(sid, p.frameId, true));
    cdp.on("Page.frameStoppedLoading", (p, sid) => this.setLoading(sid, p.frameId, false));
    const navigating = (on: boolean) => (p: any, sid?: string) => {
      const page = sid ? this.pages.get(sid) : undefined;
      if (page && (p.frameId ?? p.frame?.id) === page.targetId) page.navigating = on;
    };
    cdp.on("Page.frameStartedNavigating", navigating(true));
    cdp.on("Page.frameNavigated", navigating(false));
    // A new document (in the page or one of its frames): element ids handed out before are void.
    cdp.on("Page.frameNavigated", (_p, sid) => {
      const page = this.ownerOf(sid);
      if (page) page.docGen = (page.docGen ?? 0) + 1;
    });
    cdp.on("Page.frameStoppedLoading", navigating(false));
    cdp.on("Page.navigatedWithinDocument", (p, sid) => {
      const page = sid ? this.pages.get(sid) : undefined;
      if (page && p.frameId === page.targetId) void this.refreshInfo(page);
    });
    cdp.on("Page.javascriptDialogOpening", (p, sid) => this.onDialog(sid, p));
    cdp.on("Page.javascriptDialogClosed", (_p, sid) => {
      const page = this.ownerOf(sid);
      if (!page) return;
      page.dialog = null;
      if (this.prompt?.kind === "dialog" && this.prompt.page === page) this.prompt = null;
      this.queueChrome();
    });
    const crashed = (page: Page | undefined) => {
      if (!page || page.crashed) return;
      page.crashed = true;
      page.loading = false;
      this.showToast("Page crashed. Ctrl+R reloads it, or go to another address.");
    };
    cdp.on("Inspector.targetCrashed", (_p, sid) => crashed(sid ? this.pages.get(sid) : undefined));
    cdp.on("Target.targetCrashed", (p) => crashed(this.byTarget.get(p.targetId)));
    cdp.on("Page.fileChooserOpened", (p, sid) => {
      const page = this.ownerOf(sid);
      if (!page || !sid || p.backendNodeId === undefined) return;
      page.fileChooser = { sessionId: sid, backendNodeId: p.backendNodeId, multiple: p.mode === "selectMultiple" };
      if (page === this.focused) {
        if (this.prompt?.kind === "url" || this.prompt?.kind === "file") this.prompt = null;
        this.syncPrompt();
      } else {
        this.showToast("A page in another tab wants a file; it will ask when you switch to it", 4000);
      }
      this.queueChrome();
    });
    cdp.on("Browser.downloadWillBegin", (p) => {
      this.downloads.set(p.guid, p.suggestedFilename || "download");
      this.showToast(`Downloading ${p.suggestedFilename}…`);
    });
    cdp.on("Browser.downloadProgress", (p) => {
      if (p.state === "completed") this.finishDownload(p.guid);
      else if (p.state === "canceled") {
        this.downloads.delete(p.guid);
        rmSync(join(this.opts.downloadStaging, p.guid), { force: true });
        this.showToast("Download canceled");
      }
    });

    // Downloads land under generated names in a staging dir and are moved
    // into place with a name that never replaces an existing file.
    // Downloads interrupted by an earlier exit are partial: drop them.
    rmSync(this.opts.downloadStaging, { recursive: true, force: true });
    mkdirSync(this.opts.downloadStaging, { recursive: true });
    await cdp
      .send("Browser.setDownloadBehavior", {
        behavior: "allowAndName",
        downloadPath: this.opts.downloadStaging,
        eventsEnabled: true,
      })
      .catch((e) => this.opts.log(`downloads: ${e}`));
    // Notifications ask (and are refused, headless) rather than reporting a
    // flat "denied" up front, as in a regular browser.
    await cdp
      .send("Browser.setPermission", { permission: { name: "notifications" }, setting: "prompt" })
      .catch((e) => this.opts.log(`permissions: ${e}`));

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
      // Pages, plus workers that run on their own (they need the user agent too).
      filter: [{ type: "page" }, { type: "service_worker" }, { type: "shared_worker" }, { exclude: true }],
    });
    const url = initialUrl ? toUrl(initialUrl, this.opts.search) : null;
    // Script title changes (document.title = ...) don't produce
    // targetInfoChanged in this browser, so poll titles once a second.
    this.titlePoll = setInterval(() => void this.pollTitles(), 1000);
    const firstReady = new Promise<void>((r) => (this.onFirstPage = r));
    // Restarted (into an updated termium): the spaces, tabs and splits it had.
    const result = restore
      ? await this.restoreLayout(restore, space).catch((e): "none" => {
          this.opts.log(`restore: ${e instanceof Error ? e.stack : e}`);
          return "none";
        })
      : "none";
    const restored = result !== "none";
    if (!restored) {
      await this.createPage({ kind: "tab", space, index: 0, editUrl: !url, url: url ?? undefined });
      // Input is held back until the first page exists so early keystrokes land in it.
      await Promise.race([firstReady, Bun.sleep(10_000)]);
    } else if (url) {
      this.newTab(url);
    }
    this.onFirstPage = null;
    this.ready = true;
    this.fullRedraw();
    if (notice && restored) this.showToast(notice, 6000);
    return result;
  }

  /** Spaces, tabs and splits with their pages' addresses, for a restart. */
  /** The browser's default context (termium's own pages are in it). */
  private defaultContext: string | undefined;

  /**
   * Spaces, tabs and splits with their pages' addresses, for a restart.
   * Pages of other browser contexts (a DevTools client's isolated
   * newContext()) aren't kept: reopened, they'd lose that isolation.
   */
  layoutSnapshot(): SavedLayout {
    let notKept = 0;
    const keep = (p: Page) => !p.contextId || !this.defaultContext || p.contextId === this.defaultContext;
    const node = (n: Node<Page>): SavedNode | null => {
      if (n.kind === "leaf") {
        if (!keep(n.item)) {
          notKept++;
          return null;
        }
        return { url: n.item.url.includes(MARKER) || n.item.url === "about:blank" ? "" : n.item.url };
      }
      const a = node(n.a);
      const b = node(n.b);
      return a && b ? { dir: n.dir, ratio: n.ratio, a, b } : (a ?? b);
    };
    const spaces = this.spaces.map((s) => {
      const tabs: SavedLayout["spaces"][number]["tabs"] = [];
      let active = 0;
      s.tabs.forEach((t, i) => {
        const root = node(t.root);
        if (!root) return;
        if (i <= s.active) active = tabs.length;
        const kept = leaves(t.root).filter(keep);
        tabs.push({ root, focus: Math.max(0, kept.indexOf(t.focused)), zoomed: t.zoomed });
      });
      return { name: s.name, active, tabs };
    });
    return { spaces, activeSpace: this.activeSpace, sidebar: this.sidebar, zoom: this.zoom, notKept };
  }

  /** The person at the terminal is in the middle of something (address bar, a prompt, help, a key prefix...). */
  /** The person has something open that takes their keys (address bar, a prompt, a dialog, help, the update box, a key prefix). */
  humanEditing(): boolean {
    return this.attached && (this.mode !== "normal" || !!this.prompt);
  }

  /**
   * For agents only (`termium ctl`): the person is editing something (see
   * humanEditing) or typed in the last moment. With `dialogOf`, that page's
   * own dialog on screen doesn't count (an agent answering it), the person typing does.
   */
  humanBusy(dialogOf?: Page): boolean {
    // (That page's own dialog doesn't count, unless the person has started typing an answer into it.)
    const own = !!dialogOf && this.prompt?.kind === "dialog" && this.prompt.page === dialogOf;
    const edited = own && !!dialogOf.dialog?.edit && !["", dialogOf.dialog.defaultPrompt].includes(dialogOf.dialog.edit.text);
    const prompt = this.prompt && (!own || edited);
    return this.attached && (this.mode !== "normal" || !!prompt || Date.now() - this.lastKeyAt < 1500);
  }

  /** When the person last pressed a key (typing into a page counts: it's busy for a moment after). */
  private lastKeyAt = 0;

  /** A page address is termium's own placeholder for a blank page (not a real #termium-... fragment). */
  isPlaceholder(url: string): boolean {
    return url.includes(MARKER);
  }

  /** Opens a saved layout (pages load from their addresses): "all" of its pages came up, "some", or "none". */
  private async restoreLayout(saved: SavedLayout, first: Space): Promise<"all" | "some" | "none"> {
    const valid = (n: any, depth = 0): n is SavedNode =>
      depth < 32 && !!n && typeof n === "object" &&
      (typeof n.url === "string" || ((n.dir === "h" || n.dir === "v") && valid(n.a, depth + 1) && valid(n.b, depth + 1)));
    const leftmost = (n: SavedNode): string => ("url" in n ? n.url : leftmost(n.a));
    const count = (n: SavedNode): number => ("url" in n ? 1 : count(n.a) + count(n.b));
    // Pages in the snapshot (an unreadable tab counts as one), and pages that came up.
    let expected = 0;
    let opened = 0;
    const clampInt = (v: unknown, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.floor(Number(v)) || 0));
    const build = async (n: SavedNode, p: Page, tab: Tab): Promise<void> => {
      if ("url" in n) return;
      const url = leftmost(n.b);
      const q = await this.placePage({ kind: "split", tab, next: p, dir: n.dir, editUrl: false, url: url || undefined });
      if (q) opened++;
      await build(n.a, p, tab);
      if (q) await build(n.b, q, tab);
    };
    const ratios = (n: Node<Page>, s: SavedNode) => {
      if (n.kind !== "split" || "url" in s) return;
      const r = Number(s.ratio);
      if (Number.isFinite(r)) n.ratio = Math.max(0.1, Math.min(0.9, r));
      ratios(n.a, s.a);
      ratios(n.b, s.b);
    };
    let any = false;
    const spaces = Array.isArray(saved.spaces) ? saved.spaces : [];
    if (spaces.length > 64) expected += spaces.length - 64;
    for (const [si, ss] of spaces.slice(0, 64).entries()) {
      const space = si === 0 ? first : this.newSpaceModel();
      if (si > 0) this.spaces.push(space);
      if (typeof ss?.name === "string" && ss.name.trim()) space.name = ss.name.slice(0, 64);
      const tabs = Array.isArray(ss?.tabs) ? ss.tabs : [];
      if (tabs.length > 200) expected += tabs.length - 200;
      for (const st of tabs.slice(0, 200)) {
        if (!valid(st?.root)) {
          expected++;
          continue;
        }
        expected += count(st.root);
        const url = leftmost(st.root);
        const page = await this.placePage({ kind: "tab", space, index: space.tabs.length, editUrl: false, url: url || undefined, background: true });
        if (!page) continue;
        any = true;
        opened++;
        const tab = this.locate(page)?.tab;
        if (!tab) continue;
        await build(st.root, page, tab);
        ratios(tab.root, st.root);
        const ls = leaves(tab.root);
        tab.focused = ls[clampInt(st.focus, 0, ls.length - 1)] ?? tab.focused;
        tab.zoomed = !!st.zoomed && ls.length > 1;
      }
      space.active = clampInt(ss?.active, 0, Math.max(0, space.tabs.length - 1));
    }
    // Spaces none of whose pages came back go (the first stays).
    this.spaces = this.spaces.filter((s, i) => i === 0 || s.tabs.length > 0);
    if (!any) return "none";
    this.activeSpace = clampInt(saved.activeSpace, 0, this.spaces.length - 1);
    if (!this.space?.tabs.length) this.activeSpace = Math.max(0, this.spaces.findIndex((s) => s.tabs.length > 0));
    this.sidebar = saved.sidebar !== false;
    const z = Number(saved.zoom);
    if (Number.isFinite(z) && z !== 1) this.zoom = Math.max(0.3, Math.min(5, Math.round(z * 100) / 100));
    this.relayout();
    if (opened < expected) this.opts.log(`restore: ${opened} of ${expected} pages reopened`);
    return opened < expected ? "some" : "all";
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
    return { id, name: `space ${id}`, tabs: [], active: 0, recent: [] };
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

  /** Called once a page created for a placement is in the model (null: it never came). */
  private placedCallbacks = new Map<string, (page: Page | null) => void>();

  /** Creates a page and waits until it's in place: null if it doesn't come within 10 s. */
  private placePage(placement: Placement): Promise<Page | null> {
    return new Promise((resolve) => {
      let marker = "";
      const timer = setTimeout(() => {
        this.placedCallbacks.delete(marker);
        resolve(null);
      }, 10_000);
      marker = this.createPageMarked(placement, (page) => {
        clearTimeout(timer);
        resolve(page);
      });
    });
  }

  private async createPage(placement: Placement): Promise<void> {
    await new Promise<void>((resolve) => this.createPageMarked(placement, undefined, resolve));
  }

  private createPageMarked(placement: Placement, onPlaced?: (page: Page | null) => void, created?: () => void): string {
    const marker = `${MARKER}${this.nextMarker++}`;
    void this.createTarget(marker, placement, onPlaced).finally(() => created?.());
    return marker;
  }

  private async createTarget(marker: string, placement: Placement, onPlaced?: (page: Page | null) => void): Promise<void> {
    this.placements.set(marker, placement);
    if (onPlaced) this.placedCallbacks.set(marker, onPlaced);
    // The new page takes focus: hold input until it exists so keys typed
    // right after Ctrl+T don't land in the page being left.
    this.holdInput(marker);
    try {
      // Its own window: headless tabs sharing a window hide each other, and
      // panes of a split must all stay live.
      await this.cdp.send("Target.createTarget", { url: `about:blank${marker}`, newWindow: true });
    } catch (e) {
      this.placements.delete(marker);
      this.releaseInput(marker);
      this.showToast(`Could not open a page: ${e}`);
      const cb = this.placedCallbacks.get(marker);
      this.placedCallbacks.delete(marker);
      cb?.(null);
    }
  }

  /** Reasons input is currently queued (a page being created, a paste in progress). */
  private holds = new Map<string, ReturnType<typeof setTimeout>>();

  private holdInput(reason: string): void {
    const old = this.holds.get(reason);
    if (old) clearTimeout(old);
    this.holds.set(reason, setTimeout(() => this.releaseInput(reason), 5000));
  }

  private releaseInput(reason: string): void {
    const timer = this.holds.get(reason);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.holds.delete(reason);
    if (this.holds.size === 0) this.flushEarlyInput();
  }

  private ownerOf(sid: string | undefined): Page | undefined {
    return sid ? (this.pages.get(sid) ?? this.frameOwner.get(sid)) : undefined;
  }

  /** What every document session (page or out-of-process iframe) gets. */
  private documentSetup(sid: string): Promise<unknown> {
    return Promise.all([
      this.cdp.send("Page.enable", {}, sid),
      this.cdp.send("Inspector.enable", {}, sid),
      this.ua ? this.cdp.send("Emulation.setUserAgentOverride", this.ua, sid) : null,
      this.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: SELECT_POPUP, worldName: "termium", runImmediately: true }, sid),
      this.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: CONTEXT_PROBE, worldName: "termium", runImmediately: true }, sid),
      this.cdp.send("Page.setInterceptFileChooserDialog", { enabled: true }, sid),
      // Cross-site iframes and dedicated workers are separate targets.
      this.cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sid),
    ]).catch((e) => this.opts.log(`setup ${sid}: ${e}`));
  }

  private async onAttached(p: any, parent?: string): Promise<void> {
    const { sessionId, targetInfo, waitingForDebugger } = p;
    const run = () =>
      waitingForDebugger
        ? this.cdp.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => {})
        : Promise.resolve();
    if (targetInfo.type === "iframe") {
      const owner = this.ownerOf(parent);
      if (owner) this.frameOwner.set(sessionId, owner);
      const setup = this.documentSetup(sessionId);
      await run();
      await setup;
      return;
    }
    if (targetInfo.type !== "page") {
      // Workers: same user agent as their pages, then let them run.
      if (this.ua && /worker/.test(targetInfo.type)) {
        this.cdp.send("Network.setUserAgentOverride", this.ua, sessionId).catch(() => {});
      }
      await run();
      return;
    }
    if (this.byTarget.has(targetInfo.targetId)) {
      await run();
      return;
    }

    const page: Page = {
      num: 0, // numbered below, once it's known to stay
      // Document generations start somewhere random: an id from before a
      // restart (new server, new pages, same numbers) is never good again.
      docGen: 1_000_000 + randomInt(999_000_000),
      contextId: targetInfo.browserContextId,
      targetId: targetInfo.targetId,
      sessionId,
      url: targetInfo.url,
      title: targetInfo.title,
      infoAt: 0,
      loading: false,
      crashed: false,
      dialog: null,
      closing: false,
      fileChooser: null,
      css: null,
      casting: null,
      appliedCss: null,
      appliedCast: null,
      queuedKey: null,
      ops: Promise.resolve(),
      lastFrame: null,
      frameSeq: 0,
      navSeq: 0,
      navStarted: 0,
      imageIds: [],
      phIds: [],
      placed: null,
    };

    const markerIdx = targetInfo.url.indexOf(MARKER);
    const marker = markerIdx >= 0 ? targetInfo.url.slice(markerIdx) : null;
    let placement = marker ? this.placements.get(marker) : undefined;
    if (marker) this.placements.delete(marker);
    // termium's own pages are in the browser's default context.
    if (placement && targetInfo.browserContextId) this.defaultContext ??= targetInfo.browserContextId;

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
      // A middle-clicked link opens in the background, as in Chrome.
      const middle = Date.now() - this.lastMiddlePress < 1500;
      if (middle) this.lastMiddlePress = 0; // one middle click, one background tab
      // A popup from a page you aren't looking at doesn't take focus either.
      // A page another DevTools client opens (no opener in termium) waits in the
      // background while the person is busy (editing the address, a prompt or
      // help, or typing a moment ago): their draft and keys stay where they are.
      // Popups and links from pages keep opening in front, as ever (the
      // person's own clicks and keys open those).
      const background = middle || (!!opener && opener !== this.focused) || (!opener && this.humanBusy());
      placement = { kind: "tab", space, index, editUrl: false, background };
    }

    page.num = this.nextPageNum++;
    this.pages.set(sessionId, page);
    this.byTarget.set(page.targetId, page);

    const sid = sessionId;
    // Don't await these before resuming: a page opened by another page
    // (target=_blank, window.open) only answers once it runs.
    // Every page counts as focused (as the window you're looking at would);
    // input only ever goes to the one you've focused in termium.
    const setup = Promise.all([
      this.documentSetup(sid),
      this.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, sid),
      // No terminal to size it to (a session an agent started): a desktop-sized
      // page rather than the small headless window. A terminal attaching resizes it.
      this.attached ? null : this.cdp.send("Emulation.setDeviceMetricsOverride", DETACHED_VIEWPORT, sid),
    ]).catch((e) => this.opts.log(`setup ${sid}: ${e}`));

    // Put it into the model before applying metrics so it gets the right size.
    const replacing = placement.kind === "replace" ? this.locate(placement.old) : null;
    if (placement.kind === "replace" && replacing) {
      const old = placement.old;
      replacing.tab.root = replaceLeaf(replacing.tab.root, old, page);
      if (replacing.tab.focused === old) replacing.tab.focused = page;
      this.pages.delete(old.sessionId);
      this.byTarget.delete(old.targetId);
      this.cdp.send("Target.closeTarget", { targetId: old.targetId }).catch(() => {});
    } else if (placement.kind === "replace") {
      const space = this.space!;
      space.tabs.splice(space.active + 1, 0, { id: this.nextTabId++, root: leaf(page), focused: page, zoomed: false });
      space.active++;
    } else if (placement.kind === "tab") {
      const space = this.spaces.includes(placement.space) ? placement.space : this.space!;
      const tab: Tab = { id: this.nextTabId++, root: leaf(page), focused: page, zoomed: false };
      const index = Math.min(placement.index, space.tabs.length);
      space.tabs.splice(index, 0, tab);
      // An agent's tab opens in the background while the person is busy (checked as it arrives).
      if (placement.background || (placement.agent && this.humanBusy())) {
        if (space.active >= index && space.tabs.length > 1) space.active++;
      } else {
        space.active = index;
        this.activeSpace = Math.max(0, this.spaces.indexOf(space));
      }
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
    const placed = marker ? this.placedCallbacks.get(marker) : undefined;
    if (marker) this.placedCallbacks.delete(marker);
    placed?.(page);
    await run();
    await setup;
    const target = placement.kind === "replace" ? (placement.url === "about:blank" ? undefined : placement.url) : placement.url;
    // A new page stays on about:blank#termium-N (shown as an empty address)
    // until something navigates it; navigating it away here would race the
    // user's first navigation.
    if (target) this.navigate(page, target);
    if (placement.kind !== "replace" && placement.editUrl && this.focused === page) this.openUrlPrompt(page, "");
    this.fullRedraw();
    this.onFirstPage?.();
    if (marker) this.releaseInput(marker);
  }

  private onGone(page: Page | undefined): void {
    if (!page) return;
    this.clearForeign(page);
    // An open menu may be about this page or its tab or space (redrawn away below).
    this.menu = null;
    this.phTiles.delete(page);
    if (this.hoverPage === page) this.hoverPage = null;
    this.pages.delete(page.sessionId);
    this.byTarget.delete(page.targetId);
    this.staleImages.push(...page.imageIds);
    page.imageIds = [];
    this.releasePlaceholder(page);
    if (this.prompt && "page" in this.prompt && this.prompt.page === page) this.prompt = null;
    if (this.mouseCapture === page) {
      this.mouseCapture = null;
      this.mouseButtons = 0;
    }

    const loc = this.locate(page);
    if (loc) {
      const { space, tab } = loc;
      const root = removeLeaf(tab.root, page);
      if (root) {
        tab.root = root;
        if (tab.focused === page) tab.focused = leaves(root)[0]!;
        if (leaves(root).length === 1) tab.zoomed = false;
      } else {
        // Closing the active tab goes back to the tab shown before it (as
        // Chrome does for a tab you just opened), else to its neighbour.
        const i = space.tabs.indexOf(tab);
        const wasActive = space.active === i;
        space.tabs.splice(i, 1);
        space.recent = space.recent.filter((t) => t !== tab && space.tabs.includes(t));
        const back = wasActive ? space.recent[0] : undefined;
        if (back) space.active = space.tabs.indexOf(back);
        else if (space.active > i) space.active--;
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

  /** Remembers the shown tab, and makes the focused page the browser's active one. */
  private noteShown(): void {
    const space = this.space;
    const tab = this.tab;
    if (space && tab && space.recent[0] !== tab) space.recent = [tab, ...space.recent.filter((t) => t !== tab)].slice(0, 32);
    this.activateFocused();
  }

  private activeTarget: string | null = null;

  /**
   * Each page has its own browser window, so activating the focused one
   * hides nothing; it's what makes keyboard input, insertText and the
   * clipboard act on that page.
   */
  private activateFocused(): void {
    const page = this.focused;
    if (!page || this.activeTarget === page.targetId) return;
    this.activeTarget = page.targetId;
    this.cdp.send("Target.activateTarget", { targetId: page.targetId }).catch(() => {});
  }

  /** Keeps the address-line prompt consistent with the focused page. */
  private syncPrompt(): void {
    const page = this.focused;
    const p = this.prompt;
    if (p && p.kind !== "rename" && p.kind !== "confirm" && p.page !== page) this.prompt = null;
    if (p && p.kind === "rename" && p.space !== this.space) this.prompt = null;
    if (this.prompt?.kind === "dialog" && !this.prompt.page.dialog) this.prompt = null;
    if (page?.dialog && !this.prompt) {
      // (Its answer as typed so far lives with the dialog: it comes back as it was after help or the update box.)
      const d = page.dialog;
      this.prompt = { kind: "dialog", edit: (d.edit ??= new LineEdit(d.defaultPrompt, true)), page };
    }
    if (page?.fileChooser && !this.prompt) {
      const fc = page.fileChooser;
      this.prompt = {
        kind: "file",
        edit: new LineEdit(this.lastUploadDir, false),
        page,
        sessionId: fc.sessionId,
        backendNodeId: fc.backendNodeId,
        multiple: fc.multiple,
      };
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
    const page = this.ownerOf(sid);
    if (!page || !sid) return;
    // An agent's close never puts a "Leave this page?" in front of the person:
    // it's answered here ("leave" for --force; else "stay", and the agent is told).
    if (page.agentClosing && p.type === "beforeunload") {
      const leave = page.agentClosing === "force";
      if (!leave) page.agentClosing = "refused";
      this.cdp.send("Page.handleJavaScriptDialog", { accept: leave }, sid).catch(() => {});
      return;
    }
    page.dialog = { type: p.type, message: p.message, defaultPrompt: p.defaultPrompt ?? "", sessionId: sid };
    const loc = this.locate(page);
    // A page termium is closing asks "leave?": show it. Otherwise a dialog in
    // a page you're not looking at waits (marked "!") instead of grabbing focus.
    if (loc && (page === this.focused || page.closing)) {
      this.activeSpace = this.spaces.indexOf(loc.space);
      loc.space.active = loc.space.tabs.indexOf(loc.tab);
      loc.tab.focused = page;
      if (this.prompt?.kind !== "dialog") this.prompt = null;
      this.relayout();
      this.fullRedraw();
    } else if (loc) {
      const where = this.spaces.indexOf(loc.space) === this.activeSpace
        ? `tab ${loc.space.tabs.indexOf(loc.tab) + 1}`
        : `${loc.space.name}, tab ${loc.space.tabs.indexOf(loc.tab) + 1}`;
      this.showToast(`A page in ${where} is waiting for an answer`, 4000);
    }
  }

  navigate(page: Page, url: string, attempt = 0): void {
    page.url = url;
    page.loading = true;
    const seq = ++page.navSeq;
    page.navStarted = Date.now();
    this.cdp
      .send("Page.navigate", { url }, page.sessionId)
      .then((r) => {
        if (page.navSeq === seq) page.navStarted = 0;
        // Helium holds requests for a few seconds after launch while its
        // built-in content blocker starts; on a fresh profile the held
        // navigation can be aborted. Retry once nothing newer replaced it.
        const startup = Date.now() - this.startedAt < 20_000;
        const web = /^https?:/i.test(url);
        if (r?.errorText === "net::ERR_ABORTED" && web && !r.isDownload && startup && page.navSeq === seq && attempt < 2 && this.pages.has(page.sessionId)) {
          setTimeout(() => {
            if (page.navSeq === seq) this.navigate(page, url, attempt + 1);
          }, 250);
        }
      })
      .catch((e) => this.showToast(String(e)));
    this.queueChrome();
  }

  /** Moves a finished download into the download dir under a name that is free. */
  private finishDownload(guid: string): void {
    const suggested = this.downloads.get(guid) ?? "download";
    this.downloads.delete(guid);
    const from = join(this.opts.downloadStaging, guid);
    try {
      mkdirSync(this.opts.downloadDir, { recursive: true });
      const to = freeName(this.opts.downloadDir, safeFileName(suggested));
      try {
        // Replaces only the empty placeholder freeName just claimed.
        renameSync(from, to);
      } catch (e: any) {
        if (e?.code !== "EXDEV") {
          rmSync(to, { force: true });
          throw e;
        }
        copyFileSync(from, to);
        unlinkSync(from);
      }
      this.showToast(`Saved ${to}`);
    } catch (e) {
      this.showToast(`Download failed: ${e}`);
    }
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

  /** Crashed. (A hung renderer is found by `responsive`; a slow server is neither.) */
  private wedged(page: Page): boolean {
    return page.crashed;
  }

  /** Whether the page's renderer answers at all (a hung one never does). */
  private async responsive(page: Page, timeoutMs = 1500): Promise<boolean> {
    const probe = this.cdp
      .send("Runtime.evaluate", { expression: "1", returnByValue: true }, page.sessionId)
      .then(() => true, () => false);
    return Promise.race([probe, Bun.sleep(timeoutMs).then(() => false)]);
  }

  /** Navigates; a crashed page, or one whose renderer is hung, is replaced by a fresh one. */
  private go(page: Page, url: string): void {
    if (this.wedged(page)) return this.recover(page, url);
    this.navigate(page, url);
    this.watchHang(page, page.navSeq, url);
  }

  private reload(page: Page, ignoreCache = false): void {
    if (this.wedged(page)) return this.recover(page, page.url);
    const seq = ++page.navSeq;
    page.navStarted = Date.now();
    this.cdp
      .send("Page.reload", { ignoreCache }, page.sessionId)
      .then(() => {
        if (page.navSeq === seq) page.navStarted = 0;
      })
      .catch(() => {});
    this.watchHang(page, seq, page.url);
  }

  /**
   * A navigation still loading after 8 s on a page whose renderer doesn't
   * answer means a hung page (a busy one answers eventually; a slow server
   * has a responsive renderer): replace it.
   */
  private watchHang(page: Page, seq: number, url: string): void {
    setTimeout(async () => {
      const stuck = () => page.navSeq === seq && (page.loading || page.navStarted !== 0);
      if (!stuck() || page.dialog || !this.pages.has(page.sessionId)) return;
      // Busy pages answer eventually: only two unanswered probes a few
      // seconds apart count as hung. Then it's replaced unless a newer
      // navigation came meanwhile, whether or not it still looks like it's
      // loading (a hung renderer's load can end without the page coming back).
      if (await this.responsive(page, 3000)) return;
      await Bun.sleep(2000);
      if (page.navSeq !== seq || page.dialog || !this.pages.has(page.sessionId)) return;
      if (await this.responsive(page, 3000)) return;
      if (page.navSeq === seq && !page.dialog && this.pages.has(page.sessionId)) {
        this.showToast("The page stopped responding; opened it again");
        this.recover(page, url);
      }
    }, 8000);
  }

  /**
   * A crashed page (especially one that crashed mid-navigation) may not
   * come back from a reload, so it's replaced in place by a fresh page.
   */
  private recover(page: Page, url: string): void {
    const target = url && !url.includes(MARKER) ? url : "about:blank";
    void this.createPage({ kind: "replace", old: page, url: target });
  }

  /** Closes a page the way a browser does: its beforeunload handler may ask first. */
  private closePage(page: Page): void {
    page.closing = true;
    const force = () => this.cdp.send("Target.closeTarget", { targetId: page.targetId }).catch(() => this.onGone(page));
    this.cdp.send("Page.close", {}, page.sessionId).catch(force);
    // A hung page never answers; close it anyway unless it's asking the user.
    setTimeout(() => {
      if (this.pages.has(page.sessionId) && page.closing && !page.dialog) void force();
    }, 4000);
  }

  private closeTab(tab: Tab): void {
    const pages = leaves(tab.root);
    // A single page asks for itself (its own "Leave this page?").
    if (pages.length === 1) this.closePage(pages[0]!);
    else void this.closeGroup(pages, "tab");
  }

  /**
   * Quits, asking first (as Chrome does) if a page may have unsaved changes.
   * Pressed again while that very question is showing, it quits; any other
   * prompt (or the question having gone away) means it asks again.
   */
  /**
   * Which terminal is attached: bumped on every attach and detach. Work a
   * key started asynchronously (an unsaved-changes probe, a skip being
   * saved, a restart being checked) belongs to the terminal that pressed
   * it: when it resolves for another terminal (or none), it does nothing and
   * shows nothing.
   */
  private terminalGen = 0;
  /** A ticket for async work started now; `ticket.valid()` is false once another terminal attached (or this one left). */
  ticket(opts: { sameUi?: boolean } = { sameUi: true }): { valid: () => boolean } {
    const gen = this.terminalGen;
    // With sameUi, it's also void once the person has opened anything since
    // (started editing the address, a prompt, help...): what they're doing
    // now isn't replaced by a question they asked earlier.
    const mode = this.mode;
    const prompt = this.prompt;
    return {
      valid: () => gen === this.terminalGen && this.attached && (!opts.sameUi || (mode === this.mode && prompt === this.prompt)),
    };
  }

  private async requestQuit(): Promise<void> {
    const p = this.prompt;
    if (p?.kind === "confirm" && p.tag === "quit") return this.opts.quit();
    const pages = [...this.pages.values()];
    const t = this.ticket();
    const asking = (await Promise.all(pages.map((page) => this.wouldAsk(page)))).filter(Boolean).length;
    if (!t.valid()) return;
    const downloading = this.downloads.size;
    if (asking === 0 && downloading === 0) return this.opts.quit();
    const reasons = [
      asking ? `${asking === 1 ? "a page" : `${asking} pages`} may have unsaved changes` : "",
      downloading ? `${downloading === 1 ? "a download is" : `${downloading} downloads are`} in progress` : "",
    ].filter(Boolean).join(" and ");
    this.prompt = {
      kind: "confirm",
      tag: "quit",
      message: `${reasons[0]!.toUpperCase()}${reasons.slice(1)}. Quit anyway?`,
      onYes: () => this.opts.quit(),
      edit: new LineEdit("", false),
    };
    this.queueChrome();
  }

  /**
   * Closes several pages (a tab's panes, a space) all-or-nothing: if any of
   * them would ask "Leave this page?", termium asks once for the group, and
   * either closes every page or keeps every page.
   */
  private async closeGroup(pages: Page[], what: string): Promise<void> {
    const guarded: Page[] = [];
    const t = this.ticket();
    for (const page of pages) if (await this.wouldAsk(page)) guarded.push(page);
    if (!t.valid()) return;
    const closeAll = () => {
      for (const page of pages) {
        page.closing = true;
        this.cdp.send("Target.closeTarget", { targetId: page.targetId }).catch(() => this.onGone(page));
      }
    };
    if (guarded.length === 0) return closeAll();
    this.prompt = {
      kind: "confirm",
      tag: "close",
      message: `${guarded.length === 1 ? "A page" : `${guarded.length} pages`} in this ${what} may have unsaved changes. Close anyway?`,
      onYes: closeAll,
      edit: new LineEdit("", false),
    };
    this.queueChrome();
  }

  /**
   * Whether closing the page would make it ask first: a beforeunload
   * handler in it or any of its frames, on a page the user has interacted
   * with (pages without user activation don't get to ask).
   */
  private async wouldAsk(page: Page): Promise<boolean> {
    const sessions = [page.sessionId, ...[...this.frameOwner].filter(([, p]) => p === page).map(([sid]) => sid)];
    const probe = async (sid: string) => {
      const group = "termium-unload";
      // The page's own JavaScript context in every frame this session
      // renders (cross-origin ones included): enabling Runtime replays the
      // existing contexts.
      const contexts: number[] = [];
      const collect = (p: any, from?: string) => {
        if (from === sid && p.context?.auxData?.isDefault) contexts.push(p.context.id);
      };
      this.cdp.on("Runtime.executionContextCreated", collect);
      try {
        await this.cdp.send("Runtime.enable", {}, sid);
      } finally {
        this.cdp.off("Runtime.executionContextCreated", collect);
        this.cdp.send("Runtime.disable", {}, sid).catch(() => {});
      }
      let guarded = false;
      let activated = false;
      for (const contextId of contexts) {
        try {
          const { result } = await this.cdp.send("Runtime.evaluate", { expression: "window", contextId, objectGroup: group }, sid);
          const { listeners } = await this.cdp.send("DOMDebugger.getEventListeners", { objectId: result.objectId }, sid);
          const state = await this.cdp.send(
            "Runtime.evaluate",
            {
              expression: `[typeof window.onbeforeunload === "function",
                navigator.userActivation ? navigator.userActivation.hasBeenActive : true]`,
              contextId,
              returnByValue: true,
            },
            sid,
          );
          const [handler, active] = (state?.result?.value ?? [false, false]) as boolean[];
          if (listeners.some((l: any) => l.type === "beforeunload") || handler) guarded = true;
          if (active) activated = true;
        } catch {
          // A context that went away meanwhile.
        }
      }
      this.cdp.send("Runtime.releaseObjectGroup", { objectGroup: group }, sid).catch(() => {});
      return guarded && activated;
    };
    // Tests stand in for a slow page (a busy renderer) with a delay here.
    if (Number(process.env.TERMIUM_TEST_SLOW_PROBE_MS) > 0) await Bun.sleep(Number(process.env.TERMIUM_TEST_SLOW_PROBE_MS));
    // A page that can't be checked (it's showing a dialog, or busy) might
    // have unsaved changes: count it as one that asks.
    if (page.dialog) return true;
    const one = (sid: string) => Promise.race([probe(sid).catch(() => true), Bun.sleep(1500).then(() => true)]);
    return (await Promise.all(sessions.map(one))).some(Boolean);
  }

  // ---------------------------------------------------------- geometry

  /**
   * A terminal attached: draw everything for it from scratch, at its size.
   * Image ids and positions from an earlier terminal mean nothing to it.
   */
  attach(t: { cols: number; rows: number; cellW: number; cellH: number; pixelMouse: boolean; placeholders: boolean; rgbIds?: boolean; cwd?: string }): void {
    if (t.cwd) this.cwd = t.cwd;
    // Nothing half-typed on the previous terminal carries over (a pending
    // Ctrl+B prefix would turn this one's first key into a command), nor
    // anything it had open that takes keys (the update box, help, address
    // editing, a yes/no question): this terminal starts typing into the
    // page. (A page's own dialog or file chooser stays: the page waits on it.)
    this.resetInput();
    if (this.mode === "update" || this.mode === "help") this.mode = "normal";
    if (this.prompt && (this.prompt.kind === "url" || this.prompt.kind === "rename" || this.prompt.kind === "confirm")) this.prompt = null;
    this.terminalGen++;
    this.attached = true;
    this.pixelMouse = t.pixelMouse;
    this.placeholders = t.placeholders;
    const shown = new Set(this.tab ? leaves(this.tab.root) : []);
    for (const page of this.pages.values()) {
      page.imageIds = [];
      page.phIds = [];
      page.placed = null;
      // Restart the screencasts, so a frame comes even if the size didn't
      // change (and a frame the previous terminal never acknowledged doesn't
      // hold them up). What the pages about to be drawn have cached may be
      // stale (changed while detached) or of another size: they wait for a
      // fresh frame. Other tabs keep theirs, shown at once on a switch.
      if (shown.has(page)) {
        page.lastFrame = null;
        page.lastCast = undefined;
      }
      page.queuedKey = null;
      page.restartCast = true;
    }
    this.phInUse.clear();
    this.phReleasing = [];
    this.staleImages = [];
    this.phRgb = !!t.rgbIds;
    this.phBase = Math.floor(Math.random() * 0xffff00);
    this.phNext = 1 + Math.floor(Math.random() * PLACEHOLDER_IDS);
    // Ids of our own, unlikely to meet another program's in the same
    // terminal (tmux panes share one): only these are ever deleted.
    this.phHigh = 1 + Math.floor(Math.random() * 255);
    this.nextImage = 1 + Math.floor(Math.random() * 0x7f000000);
    this.cols = t.cols;
    this.rows = t.rows;
    this.cellW = t.cellW;
    this.cellH = t.cellH;
    if (this.started) {
      this.relayoutAndRedraw();
      this.repaintSoon();
    }
  }

  /**
   * tmux drops passthrough (our pictures) while it's redrawing a window,
   * which is just when a resize or attach makes us draw everything. With
   * placeholders, send the pictures once more after it has settled; a
   * page that isn't changing wouldn't send another on its own.
   */
  private repaintSoon(): void {
    if (!this.placeholders) return;
    if (this.repaintTimer) clearTimeout(this.repaintTimer);
    this.repaintTimer = setTimeout(() => {
      this.repaintTimer = null;
      this.repaintVisible();
    }, 400);
  }

  /** Sends every visible page's picture again (the client's terminal may have lost them). */
  repaintVisible(): void {
    if (!this.attached || this.closingAll || this.covered()) return;
    for (const page of this.geom.keys()) if (page.imageIds.length) this.paint(page);
  }

  /** The terminal went away: stop drawing and stop the screencasts until one attaches again. */
  detach(): void {
    this.terminalGen++;
    this.attached = false;
    this.resetInput();
    if (this.started) this.relayout();
  }

  /**
   * Forgets input state that belongs to a terminal: pending prefix or mode,
   * and lets go of keys and mouse buttons still held on it, telling the
   * pages (their keyup/mouseup would otherwise never come).
   */
  private resetInput(): void {
    if (this.mode === "prefix" || this.mode === "resize" || this.mode === "spaces") this.mode = "normal";
    this.menu = null;
    this.reorder = null;
    this.tabHover = -1;
    for (const { page, ev } of this.pageKeysDown.values()) {
      if (this.pages.has(page.sessionId)) this.sendKey(page, { ...ev, event: "release" });
    }
    for (const { page, ev } of this.syntheticDown.values()) {
      if (this.pages.has(page.sessionId)) this.domKey(page, { ...ev, event: "release" }, "keyup");
    }
    const at = this.mousePressedAt;
    if (this.mouseButtons && at && this.pages.has(at.page.sessionId)) {
      let buttons = this.mouseButtons;
      for (const [bit, name] of [[1, "left"], [2, "right"], [4, "middle"], [8, "back"], [16, "forward"]] as const) {
        if (!(buttons & bit)) continue;
        buttons &= ~bit;
        this.cdp
          .send("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: name, buttons, clickCount: 1 }, at.page.sessionId)
          .catch(() => {});
      }
    }
    this.mousePressedAt = null;
    this.mouseCapture = null;
    this.mouseButtons = 0;
    this.drag = null;
    this.hoverPage = null;
    this.pageKeysDown.clear();
    this.syntheticDown.clear();
  }

  /** Drops input queued (before the app was ready) by a terminal that's gone. */
  dropQueuedInput(): void {
    this.early = [];
  }

  setGeometry(cols: number, rows: number, cellW: number, cellH: number): void {
    this.cols = cols;
    this.rows = rows;
    this.cellW = cellW;
    this.cellH = cellH;
    this.menu = null; // placed for the old size
    if (this.started) {
      this.relayout();
      this.fullRedraw();
      this.repaintSoon();
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
    // A menu is about what was shown when it opened (a tab, its panes): another tab now, it goes.
    if (this.menu && this.menuTab !== this.tab) this.menu = null;
    this.syncPrompt();
    this.noteShown();
    this.geom.clear();
    this.seps = [];
    const tab = this.tab;
    const visible = new Set<Page>();
    if (tab && this.attached) {
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
    page.css = { w, h, dsf };
    page.casting = { w: devW, h: devH };
    const key = `${w}x${h}@${dsf}/${devW}x${devH}`;
    if (page.queuedKey === key) return;
    page.queuedKey = key;
    const seq = page.frameSeq;
    void this.serial(page, () => this.applyViewport(page)).then(() => {
      if (page.casting && !sameSize(page.appliedCast, page.casting) && page.queuedKey === key && this.geom.has(page)) {
        // The screencast didn't start (the page was between documents, just
        // after a crash or replacement: "not attached to an active page").
        // Without a retry it never would, and the pane would never update.
        if ((page.castRetries = (page.castRetries ?? 0) + 1) <= 20) {
          page.queuedKey = null;
          setTimeout(() => {
            if (this.geom.has(page) && this.pages.has(page.sessionId) && page.queuedKey === null) this.showPage(page);
          }, 300);
          return;
        }
      } else {
        page.castRetries = 0;
      }
      // Static pages may not produce a frame on their own; grab one.
      setTimeout(() => {
        if (page.frameSeq === seq && this.geom.has(page)) void this.snapshot(page);
      }, 250);
    });
  }

  /**
   * Runs a page's viewport changes, screencast restarts and screenshots one
   * at a time: a viewport change sent while a screenshot is being taken can
   * be undone when the screenshot finishes. Each step is bounded so a hung
   * page can't stall the queue for good.
   */
  private serial(page: Page, job: () => Promise<unknown>): Promise<void> {
    const run = () => Promise.race([job(), Bun.sleep(5000)]);
    const next = page.ops.then(run).then(
      () => {},
      (e) => this.opts.log(`page ${page.targetId}: ${e}`),
    );
    page.ops = next;
    return next;
  }

  /** Gives the browser the page's wanted viewport and screencast size, and checks it took. */
  private async applyViewport(page: Page): Promise<void> {
    const sid = page.sessionId;
    const want = page.css;
    // Applied before, but another DevTools client (an agent's Puppeteer or
    // Playwright) may have changed it meanwhile: checked again.
    if (want && sameSize(page.appliedCss, want) && !(await this.viewportIs(page, want))) page.appliedCss = null;
    if (want && !sameSize(page.appliedCss, want)) {
      page.viewportAt = Date.now();
      page.awaitingShape = true;
      let took = false;
      for (let attempt = 0; attempt < 4; attempt++) {
        await this.cdp.send("Emulation.setDeviceMetricsOverride", {
          width: want.w,
          height: want.h,
          deviceScaleFactor: want.dsf,
          mobile: false,
          // A desktop-sized screen around the page.
          screenWidth: Math.max(want.w, 1920),
          screenHeight: Math.max(want.h + 120, 1080),
        }, sid);
        // A busy page can drop the change: confirm it and send it again if not.
        if ((took = await this.viewportIs(page, want))) break;
        await Bun.sleep(80 * (attempt + 1));
      }
      page.appliedCss = want;
      if (!took) await this.holdsForeignSize(page, want);
      else this.clearForeign(page);
      // (window.outerWidth/outerHeight stay at the headless window's size:
      // resizing that window shrinks the captured frames. See README.)
    }
    const cast = page.casting;
    if (cast && (!sameSize(page.appliedCast, cast) || page.restartCast)) {
      page.restartCast = false;
      page.viewportAt = Date.now();
      page.awaitingShape = true;
      if (page.appliedCast) await this.cdp.send("Page.stopScreencast", {}, sid).catch(() => {});
      page.appliedCast = null; // until it has started (a failed start is retried: see showPage)
      // Tests make the first few starts fail, as Chrome's do mid-replacement.
      if (Number(process.env.TERMIUM_TEST_FAIL_CASTS) > App.failedCasts++) throw new Error("Page.startScreencast: test failure");
      await this.cdp.send("Page.startScreencast", { format: "png", maxWidth: cast.w, maxHeight: cast.h, everyNthFrame: 1 }, sid);
      page.appliedCast = cast;
    }
  }

  /**
   * The page was resized. If it's shown and no longer termium's size,
   * another DevTools client changed it (Puppeteer's default 800x600,
   * setViewport, or its override going away as it disconnects): termium
   * puts its own back (see holdsForeignSize for when that client's
   * override holds). Hidden pages are checked when they're shown.
   */
  private sizeChanged(page: Page): void {
    if (page.sizeCheck) return;
    page.sizeCheck = setTimeout(async () => {
      page.sizeCheck = undefined;
      // Not shown (no terminal, or another tab): it keeps the size it had.
      if ((!this.attached || !this.geom.has(page)) && this.pages.has(page.sessionId)) return void this.keepDetachedSize(page);
      const css = page.css;
      if (!css || !this.geom.has(page) || !this.pages.has(page.sessionId)) return;
      if (page.actual) return void this.checkForeign(page);
      const size = await this.pageSize(page);
      if (!size || (Math.abs(size.w - css.w) <= 1 && Math.abs(size.h - css.h) <= 1) || page.css !== css) return;
      const since = Date.now() - (page.reassertedAt ?? 0);
      if (since < 1000) return void this.trailingSizeCheck(page, 1000 - since);
      page.reassertedAt = Date.now();
      this.opts.log(`page ${page.num}: resized to ${size.w}x${size.h} by another client; restoring ${css.w}x${css.h}`);
      this.reassertViewport(page);
    }, 150);
  }

  /**
   * A page not shown (no terminal attached, or a tab in the background)
   * keeps the size it had (its last pane's, or 1280x800 if it never had one). Another DevTools client letting go of its
   * own size leaves it at the headless window's: that size is put back.
   */
  private async keepDetachedSize(page: Page): Promise<void> {
    const css = page.css;
    // (A background tab never shown yet has no size of its own: it gets one when shown.)
    if (!css && this.attached) return;
    const want = css ? { width: css.w, height: css.h, deviceScaleFactor: css.dsf } : DETACHED_VIEWPORT;
    const size = await this.pageSize(page);
    if (!size || (this.attached && this.geom.has(page)) || (Math.abs(size.w - want.width) <= 1 && Math.abs(size.h - want.height) <= 1)) return;
    // Put back at most once a second; a change meanwhile (a client letting go
    // just after setting its size) is checked again then, never dropped.
    const since = Date.now() - (page.reassertedAt ?? 0);
    if (since < 1000) return void this.trailingSizeCheck(page, 1000 - since);
    page.reassertedAt = Date.now();
    this.opts.log(`page ${page.num}: resized to ${size.w}x${size.h} while detached; restoring ${want.width}x${want.height}`);
    await this.cdp
      .send("Emulation.setDeviceMetricsOverride", { ...DETACHED_VIEWPORT, ...want, mobile: false }, page.sessionId)
      .catch(() => {});
  }

  /** Looks at a page's size again in `ms` (once, however many changes come meanwhile). */
  private trailingSizeCheck(page: Page, ms: number): void {
    if (page.sizeRecheck) return;
    page.sizeRecheck = setTimeout(() => {
      page.sizeRecheck = undefined;
      if (this.pages.has(page.sessionId)) this.sizeChanged(page);
    }, ms + 50);
  }

  /** Sends the page its viewport again (another DevTools client changed it). */
  private reassertViewport(page: Page): void {
    page.appliedCss = null;
    page.queuedKey = null;
    if (this.geom.has(page)) this.showPage(page);
  }

  /** The page's size as it reports it, in CSS px (null if it doesn't answer). */
  private async pageSize(page: Page): Promise<{ w: number; h: number } | null> {
    const probe = this.cdp
      .send("Runtime.evaluate", { expression: "[innerWidth, innerHeight]", returnByValue: true }, page.sessionId)
      .then((r) => {
        const [w, h] = (r?.result?.value ?? []) as number[];
        return typeof w === "number" && typeof h === "number" ? { w, h } : null;
      })
      .catch(() => null);
    return Promise.race([probe, Bun.sleep(1000).then(() => null)]);
  }

  /**
   * termium's viewport didn't take: another DevTools client holds the page
   * at its own size (its override outranks termium's while it stays
   * connected, and the screencast doesn't say so). The page is shown at
   * that size, stretched to the pane, with the mouse mapped to match,
   * until that client lets go; then termium's size is put back.
   */
  private async holdsForeignSize(page: Page, want: { w: number; h: number }): Promise<void> {
    const size = await this.pageSize(page);
    if (!size || (Math.abs(size.w - want.w) <= 1 && Math.abs(size.h - want.h) <= 1)) return this.clearForeign(page);
    // A page busy loading can miss it too (its old document answers, at the
    // old size): tried again a moment later, and while it's loading, again
    // until it has loaded (up to 15 s).
    if (!page.actual) {
      const loading = page.loading || page.navigating || page.navStarted !== 0;
      if (loading) page.loadingTries = (page.loadingTries ?? 0) + 1;
      else page.foreignTries = (page.foreignTries ?? 0) + 1;
      if (loading ? page.loadingTries! <= 30 : page.foreignTries! < 2) {
        setTimeout(() => {
          if (this.pages.has(page.sessionId) && !page.actual) this.reassertViewport(page);
        }, 500);
        return;
      }
    }
    page.foreignTries = page.loadingTries = 0;
    const known = page.actual;
    page.actual = size;
    if (known && known.w === size.w && known.h === size.h) return;
    this.opts.log(`page ${page.num}: another DevTools client holds it at ${size.w}x${size.h}`);
    if (page === this.focused) this.showToast(`Another DevTools client set this page to ${size.w}x${size.h}; termium's size comes back when it disconnects`, 5000);
    page.foreignTimer ??= setInterval(() => void this.checkForeign(page), 1500);
  }

  private async checkForeign(page: Page): Promise<void> {
    // Gone, or no longer shown (it's checked again when it is).
    if (!this.pages.has(page.sessionId) || !this.geom.has(page) || !page.css) return this.clearForeign(page);
    const size = await this.pageSize(page);
    const css = page.css;
    if (!size || !page.actual) return;
    if (Math.abs(size.w - css.w) <= 1 && Math.abs(size.h - css.h) <= 1) {
      this.opts.log(`page ${page.num}: back to termium's size`);
      this.clearForeign(page);
    } else if (size.w !== page.actual.w || size.h !== page.actual.h) {
      // That client let go (or changed it again): termium's size, if it takes.
      this.opts.log(`page ${page.num}: now ${size.w}x${size.h}; restoring ${css.w}x${css.h}`);
      page.actual = size;
      this.reassertViewport(page);
    } else if ((page.foreignPolls = (page.foreignPolls ?? 0) + 1) % 4 === 0) {
      // Unchanged: tried again now and then all the same, in case it was let go unseen.
      this.reassertViewport(page);
    }
  }

  private clearForeign(page: Page): void {
    if (page.foreignTimer) clearInterval(page.foreignTimer);
    page.foreignTimer = undefined;
    page.actual = undefined;
    page.foreignTries = page.loadingTries = page.foreignPolls = 0;
  }

  /** Whether the page reports the viewport it was given (unknown, e.g. a page in a dialog, counts as yes). */
  private async viewportIs(page: Page, want: { w: number; h: number; dsf: number }): Promise<boolean> {
    const probe = this.cdp
      .send("Runtime.evaluate", { expression: "[innerWidth, innerHeight, devicePixelRatio]", returnByValue: true }, page.sessionId)
      .then((r) => {
        const [w, h, dpr] = (r?.result?.value ?? []) as number[];
        return Math.abs((w ?? 0) - want.w) <= 1 && Math.abs((h ?? 0) - want.h) <= 1 && Math.abs((dpr ?? 0) - want.dsf) < 0.02;
      })
      .catch(() => true);
    return Promise.race([probe, Bun.sleep(1000).then(() => true)]);
  }

  private hidePage(page: Page): void {
    if (page.casting) {
      page.casting = null;
      page.queuedKey = null;
      void this.serial(page, async () => {
        if (page.casting) return; // shown again meanwhile
        page.appliedCast = null;
        await this.cdp.send("Page.stopScreencast", {}, page.sessionId).catch(() => {});
      });
    }
    if (page.imageIds.length) {
      this.staleImages.push(...page.imageIds);
      page.imageIds = [];
      page.placed = null;
    }
    this.releasePlaceholder(page);
  }

  /** Deletes every picture of ours on screen (never another program's). */
  private deleteOwnImages(): string {
    for (const page of this.pages.values()) {
      this.staleImages.push(...page.imageIds);
      page.imageIds = [];
      page.placed = null;
    }
    return this.takeStale();
  }

  /**
   * Deletes for pictures that went off screen; goes after what replaces
   * them, in the same update. With placeholders (tmux) a delete would
   * reach the terminal at once while tmux still shows the old cells, so
   * there they're sent a little later instead, and the old ids stay
   * reserved until then.
   */
  private takeStale(): string {
    if (this.placeholders) {
      this.scheduleStale();
      return "";
    }
    const ids = this.staleImages.splice(0);
    return ids.map(deleteImage).join("");
  }

  private scheduleStale(): void {
    if (this.staleTimer || (!this.staleImages.length && !this.phReleasing.length)) return;
    this.staleTimer = setTimeout(() => {
      this.staleTimer = null;
      const ids = this.staleImages.splice(0);
      for (const i of this.phReleasing.splice(0)) this.phInUse.delete(i);
      if (ids.length && this.attached) out(ids.map(deleteImage).join(""));
    }, 300);
  }

  /** The 24-bit colour standing for placeholder index i. */
  private phColour(i: number): number {
    return this.phRgb ? ((this.phBase + i) % 0xffffff) + 1 : i;
  }

  /** Wraps one update so the terminal shows it at once (unless a full redraw already does). */
  private sync(s: string): string {
    return this.redrawing ? s : SYNC_START + s + SYNC_END;
  }

  /**
   * A free placeholder image id (a 256-colour index). Handed out round
   * robin, so cells still showing a page that just went away don't pick up
   * the next page's picture before they're redrawn.
   */
  private placeholderIds(page: Page, n: number): number[] | null {
    while (page.phIds.length > n) this.phReleasing.push(page.phIds.pop()!);
    while (page.phIds.length < n) {
      let found = 0;
      for (let i = 0; i < PLACEHOLDER_IDS && !found; i++) {
        const id = ((this.phNext - 1 + i) % PLACEHOLDER_IDS) + 1;
        if (this.phInUse.has(id)) continue;
        this.phInUse.add(id);
        this.phNext = (id % PLACEHOLDER_IDS) + 1;
        found = id;
      }
      if (!found) return null;
      page.phIds.push(found);
    }
    return page.phIds;
  }

  private releasePlaceholder(page: Page): void {
    // Freed once their pictures are deleted (see takeStale).
    this.phReleasing.push(...page.phIds);
    page.phIds = [];
    this.scheduleStale();
  }

  private snapshot(page: Page): Promise<void> {
    return this.serial(page, async () => {
      const { data } = await this.cdp.send("Page.captureScreenshot", { format: "png" }, page.sessionId);
      if (page.frameSeq === 0 || !page.lastFrame) {
        page.lastFrame = data;
        this.paint(page);
      }
    });
  }

  private onFrame(p: any, sid: string | undefined): void {
    const page = sid ? this.pages.get(sid) : undefined;
    if (!page) return;
    const m = p.metadata;
    // Just after a resize or a restarted screencast (until a frame of the new
    // shape comes, for 2 s at most), a frame of the viewport as it was can
    // come: its metadata says another size, or it already gives the new size
    // but the picture has the old shape. Such frames are dropped; the right
    // one follows. Outside that window, every frame is shown.
    // (While another DevTools client holds the page at its own size, frames
    // of that size are right too: termium trying its own size now and then
    // mustn't freeze the pane.)
    const recent = Date.now() - (page.viewportAt ?? 0) < 2000;
    const sizes = page.css ? [page.css, ...(page.actual ? [page.actual] : [])] : [];
    const fits = sizes.some((s) => frameFits(p.data, s));
    if (page.awaitingShape && (!recent || fits)) page.awaitingShape = false;
    const otherSize = !!(m && sizes.length && sizes.every((s) => Math.abs(m.deviceWidth - s.w) > 1 || Math.abs(m.deviceHeight - s.h) > 1));
    if (page.css && recent && (otherSize || (page.awaitingShape && !fits))) {
      this.cdp.send("Page.screencastFrameAck", { sessionId: p.sessionId }, sid).catch(() => {});
      return;
    }
    if (page.css && page.css.dsf > 1.01) {
      // Taking a screenshot can itself produce a screencast frame with the
      // same picture; only a frame that differs from the last one is a change.
      if (p.data === page.lastCast) {
        this.cdp.send("Page.screencastFrameAck", { sessionId: p.sessionId }, sid).catch(() => {});
        return;
      }
      page.lastCast = p.data;
      // Screencast frames come at CSS-pixel size whatever the scale factor,
      // which is blurry on HiDPI. There a frame only says "something
      // changed": take a full-resolution screenshot instead.
      this.cdp.send("Page.screencastFrameAck", { sessionId: p.sessionId }, sid).catch(() => {});
      page.frameSeq++;
      this.captureSharp(page);
      return;
    }
    page.lastFrame = p.data;
    page.frameSeq++;
    // Ack once the terminal has taken the frame, so the browser only
    // produces frames as fast as the terminal can show them.
    const ack = () => this.cdp.send("Page.screencastFrameAck", { sessionId: p.sessionId }, sid).catch(() => {});
    if (!this.paint(page, ack)) ack();
  }

  private capturing = new Set<Page>();
  private captureAgain = new Set<Page>();

  /** One full-resolution capture at a time per page; changes during it trigger one more. */
  private captureSharp(page: Page): void {
    if (this.capturing.has(page)) {
      this.captureAgain.add(page);
      return;
    }
    this.capturing.add(page);
    void this.serial(page, async () => {
      const { data } = await this.cdp.send("Page.captureScreenshot", { format: "png", optimizeForSpeed: true }, page.sessionId);
      await new Promise<void>((resolve) => {
        page.lastFrame = data;
        if (!this.paint(page, resolve)) resolve();
      });
    }).finally(() => {
        this.capturing.delete(page);
        if (this.captureAgain.delete(page) && this.pages.has(page.sessionId)) this.captureSharp(page);
      });
  }

  /** Draws the page's latest frame into its pane; false if there was nothing to draw. */
  private paint(page: Page, done?: () => void): boolean {
    const g = this.geom.get(page);
    if (!g || !page.lastFrame || this.covered() || this.closingAll || page === this.panelPage) return false;
    const r = g.content;
    if (r.cols < 1 || r.rows < 1) return false;
    if (this.placeholders) return this.paintPlaceholders(page, r, done);
    const id = this.nextImage++;
    if (this.nextImage > 0xfffffff0) this.nextImage = 1;
    // New picture placed first, old one deleted after, in one synchronized update.
    const replaces = page.imageIds[0] ?? null;
    // An open menu over the pane: the picture goes around it (it would hide the menu's text).
    const pieces = this.menu ? around(r, this.menu.rect) : [r];
    const size = pieces.length === 1 && pieces[0] === r ? null : pngSize(page.lastFrame);
    const draw = size
      ? drawImagePieces(page.lastFrame, id, replaces, pieces.map((p) => {
          const x = Math.round(((p.col - r.col) * size.w) / r.cols);
          const y = Math.round(((p.row - r.row) * size.h) / r.rows);
          const w = Math.max(1, Math.round(((p.col - r.col + p.cols) * size.w) / r.cols) - x);
          const h = Math.max(1, Math.round(((p.row - r.row + p.rows) * size.h) / r.rows) - y);
          return { ...p, x, y, w, h };
        }))
      : drawImage(page.lastFrame, id, replaces, r.row, r.col, r.cols, r.rows);
    out(this.sync(draw + this.takeStale() + this.cursorSeq()), done);
    page.imageIds = [id];
    page.placed = { ...r };
    return true;
  }

  /**
   * Unicode placeholders (tmux): one image id per page, replaced in place;
   * the cells only need writing when the pane moved or was cleared. A pane
   * more than PLACEHOLDER_MAX cells across or down (the marks only count so
   * far) is cut into tiles, each its own image.
   */
  private paintPlaceholders(page: Page, r: Rect, done?: () => void): boolean {
    const nx = Math.ceil(r.cols / PLACEHOLDER_MAX);
    const ny = Math.ceil(r.rows / PLACEHOLDER_MAX);
    let raster: Raster | null = null;
    if (nx * ny > 1) {
      raster = decodePng(Buffer.from(page.lastFrame!, "base64"));
      if (!raster) this.opts.log("can't tile this frame (unexpected PNG format)");
    }
    const tiles: (Rect & { x: number; y: number; w: number; h: number })[] = [];
    if (!raster) {
      // One image (clipped to what placeholders can address if the pane is bigger).
      tiles.push({ ...r, x: 0, y: 0, w: 0, h: 0 });
    } else {
      for (let ty = 0; ty < ny; ty++) {
        for (let tx = 0; tx < nx; tx++) {
          const c0 = Math.floor((tx * r.cols) / nx);
          const c1 = Math.floor(((tx + 1) * r.cols) / nx);
          const r0 = Math.floor((ty * r.rows) / ny);
          const r1 = Math.floor(((ty + 1) * r.rows) / ny);
          const x0 = Math.round((c0 * raster.width) / r.cols);
          const x1 = Math.round((c1 * raster.width) / r.cols);
          const y0 = Math.round((r0 * raster.height) / r.rows);
          const y1 = Math.round((r1 * raster.height) / r.rows);
          tiles.push({ row: r.row + r0, col: r.col + c0, cols: c1 - c0, rows: r1 - r0, x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
        }
      }
    }
    const indexes = this.placeholderIds(page, tiles.length);
    if (!indexes) return false;
    const ids = indexes.map((i) => placeholderImageId(this.phHigh, this.phColour(i)));
    const p = page.placed;
    const moved =
      ids.length !== page.imageIds.length || ids.some((id, i) => id !== page.imageIds[i]) ||
      !p || p.row !== r.row || p.col !== r.col || p.cols !== r.cols || p.rows !== r.rows;
    for (const old of page.imageIds) if (!ids.includes(old)) this.staleImages.push(old);
    // Stale deletes first: their ids may be the ones handed out again here.
    let s = this.takeStale();
    tiles.forEach((t, i) => {
      const data = raster ? encodeRegion(raster, t.x, t.y, t.w, t.h).toString("base64") : page.lastFrame!;
      const cols = Math.min(t.cols, PLACEHOLDER_MAX);
      const rows = Math.min(t.rows, PLACEHOLDER_MAX);
      s += transmitVirtual(data, ids[i]!, cols, rows);
      if (moved) s += placeholderCells(this.phHigh, this.phColour(indexes[i]!), this.phRgb, t.row, t.col, cols, rows);
    });
    this.phTiles.set(page, tiles.map((t, i) => ({ row: t.row, col: t.col, cols: t.cols, rows: t.rows, index: indexes[i]! })));
    // Cells written just now over an open menu: the menu goes back on top.
    if (moved && this.menu) s += this.drawMenu();
    out(this.sync(s + this.cursorSeq()), done);
    page.imageIds = ids;
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
    if (!this.started || this.closingAll || !this.attached) return;
    // Everything below is one synchronized update: the terminal never shows
    // the cleared screen, only the finished redraw.
    // Pictures aren't deleted: each page's is replaced by its next one (and
    // a picture's old copy deleted after the new one is placed). Through
    // tmux, pictures pass straight to the outer terminal while tmux holds
    // back the text, so deleting them here would show as empty panes; and
    // the terminal may show other programs' pictures (other tmux panes),
    // so nothing is ever deleted wholesale.
    const s = SYNC_START + RESET + this.takeStale();
    for (const page of this.pages.values()) page.placed = null;
    out(s + "\x1b[2J");
    this.redrawing = true;
    try {
      this.drawChrome();
      if (!this.covered()) for (const page of this.geom.keys()) this.paint(page);
    } finally {
      this.redrawing = false;
      out(SYNC_END);
    }
  }

  /** The pane area shows an overlay (help, the update box), not the pages. */
  private covered(): boolean {
    return this.mode === "help" || this.mode === "update";
  }

  private drawChrome(): void {
    if (!this.started || this.closingAll || !this.attached) return;
    // A dialog or file chooser hidden by another prompt comes back once that's done.
    this.syncPrompt();
    let s = "\x1b[?25l";
    this.clicks.clear();
    const mainCol = this.mainCol();
    const mainW = this.cols - mainCol + 1;
    if (mainCol > 1) s += this.drawSidebar();
    s += this.drawTabBar(mainCol, mainW);
    s += this.drawUrlBar(mainCol, mainW);
    if (this.mode === "help") {
      out(this.sync(s + RESET + this.helpOverlay() + this.cursorSeq()));
      return;
    }
    if (this.mode === "update") {
      out(this.sync(s + RESET + this.updateOverlay() + this.cursorSeq()));
      return;
    }
    s += this.drawPaneChrome();
    s += this.dialogPanel();
    if (this.menu) s += this.drawMenu();
    out(this.sync(s + RESET + this.takeStale() + this.cursorSeq()));
  }

  private drawSidebar(): string {
    let s = "";
    const w = SIDEBAR_W;
    const line = (row: number, text: string, style: string) => {
      s += at(row, 1) + style + fit(text, w) + RESET;
    };
    const base = bg(C.mantle) + fg(C.subtext);
    line(1, " termium", bg(C.mantle) + fg(C.mauve) + BOLD);
    // Hides the sidebar (Ctrl+B b); in the spaces picker it shows because of the picker: leaves it.
    s += at(1, w - 2) + bg(C.mantle) + fg(C.overlay) + " « " + RESET;
    this.clicks.add(1, w - 2, 3, (b) => {
      if (b !== 0) return;
      // Shown only for the spaces picker: putting the picker away hides it again.
      if (this.mode === "spaces" && !this.sidebar) this.setMode("normal");
      else this.chromeAction("b");
    });
    line(2, " SPACES", base + "\x1b[2m");
    this.spaceHits = [];
    let row = 3;
    const fits = Math.max(1, this.rows - 4);
    const keep = this.mode === "spaces" ? this.spaceCursor : this.activeSpace;
    const firstSpace = Math.max(0, Math.min(keep - fits + 1, this.spaces.length - fits));
    this.spaces.forEach((space, i) => {
      if (i < firstSpace || row > this.rows - 2) return;
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
    if (this.mode !== "spaces") this.clicks.add(this.rows, 1, width(hint) + 1, (b) => b === 0 && this.chromeAction("?"));
    return s;
  }

  private drawTabBar(col: number, full: number): string {
    // The update badge keeps its place at the right end (shortened, never hidden).
    const badge = this.badge(full);
    const bw = badge ? Math.min(width(badge.text), Math.max(0, full - 4)) : 0;
    const w = full - bw;
    this.badgeHit = badge && bw ? [col + w, col + full] : null;
    const space = this.space;
    const tabs = space?.tabs ?? [];
    const items = tabs.map((tab, i) => {
      const pages = leaves(tab.root);
      const title = pageTitle(tab.focused);
      const extra = pages.length > 1 ? ` ⊞${pages.length}` : "";
      const dot = pages.some((p) => p.dialog) ? "! " : pages.some((p) => p.loading) ? "◌ " : "";
      // The active tab and the one under the pointer show a close button (its room is kept on every tab, so tabs don't shift).
      const close = i === space!.active || i === this.tabHover ? "× " : "  ";
      return ` ${i + 1} ${dot}${truncate(title, 22)}${extra} ${close}`;
    });
    const plus = " + ";
    // Scroll so the active tab is visible.
    let first = 0;
    const active = space?.active ?? 0;
    const total = (from: number, to: number) => items.slice(from, to + 1).reduce((a, t) => a + width(t) + 1, 0);
    const markers = (from: number) => (from > 0 ? 1 : 0) + (active < items.length - 1 ? 1 : 0);
    while (first < active && total(first, active) + width(plus) + markers(first) > w) first++;
    // Scrolled by hand (wheel, ‹ ›): that, whether or not the active tab is in view.
    if (this.tabScroll !== null && this.tabScrollFor === this.tab) first = Math.max(0, Math.min(this.tabScroll, items.length - 1));
    else this.tabScroll = null;

    let s = at(1, col) + bg(C.crust);
    let used = 0;
    this.tabHits = [];
    if (first > 0) {
      // Tabs scrolled off to the left.
      s += fg(C.peach) + "‹";
      this.clicks.add(1, col, 1, (b) => b === 0 && this.scrollTabs(-1));
      used += 1;
    }
    let last = first - 1;
    for (let i = first; i < items.length; i++) {
      const text = items[i]!;
      const tw = width(text);
      const more = i < items.length - 1 ? 1 : 0; // room for a "›" if tabs follow
      if (used + tw + width(plus) + more > w) break;
      last = i;
      const style = i === active ? bg(C.base) + fg(C.text) + BOLD : bg(C.crust) + fg(C.overlay);
      s += style + text + RESET + bg(C.crust) + fg(C.surface1) + "│";
      this.tabHits.push({ start: col + used, end: col + used + tw, index: i });
      const x = col + used + tw - 2;
      if (text.endsWith("× ")) this.clicks.add(1, x, 1, (b) => (b === 2 ? this.tabMenu(i, x) : this.closeTabAt(i)));
      used += tw + 1;
    }
    if (last < first && items.length > 0) {
      // Not even the first tab shown (the active one, unless scrolled by hand) fits whole: cut it to the space there is.
      const room = Math.max(1, w - used - width(plus) - (first < items.length - 1 ? 1 : 0));
      const text = truncate(items[first]!, room);
      s += (first === active ? bg(C.base) + fg(C.text) + BOLD : bg(C.crust) + fg(C.overlay)) + text + RESET + bg(C.crust);
      this.tabHits.push({ start: col + used, end: col + used + width(text), index: first });
      used += width(text);
      last = first;
    }
    this.tabRange = { first, last };
    if (last < items.length - 1) {
      // Tabs that don't fit on the right.
      s += bg(C.crust) + fg(C.peach) + "›";
      this.clicks.add(1, col + used, 1, (b) => b === 0 && this.scrollTabs(1));
      used += 1;
    }
    this.newTabHit = { start: col + used, end: col + used + width(plus) };
    s += bg(C.crust) + fg(C.subtext) + plus;
    used += width(plus);
    const label = this.space ? ` ${this.space.name} ` : "";
    const pad = w - used;
    if (pad > 0) {
      s += bg(C.crust) + fg(C.overlay) + (pad > width(label) + 1 ? " ".repeat(pad - width(label)) + label : " ".repeat(pad));
    }
    if (badge && bw) s += RESET + at(1, col + w) + badge.style + truncate(badge.text, bw);
    return s + RESET;
  }

  private modeLabel(): string {
    switch (this.mode) {
      case "prefix": return " ^B ";
      case "resize": return " RESIZE ";
      case "spaces": return " SPACES ";
      case "help": return " HELP ";
      case "update": return " UPDATE ";
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
    const modeW = width(mode);
    // Update news, unless a toast has something to say right now; the address keeps 20 columns.
    const notice = toast ? { text: "", style: "" } : this.notice(Math.max(0, w - 30 - modeW - width(zoom)));
    const right = (toast || notice.text) + zoom;
    const rightW = Math.min(width(right), Math.max(0, notice.text ? w - 30 - modeW : Math.floor(w / 2)));

    const prompt = this.prompt;
    // Clickable answers at the right end of the line, each with its key.
    const buttons = (list: [label: string, yes: boolean][]) => {
      const texts = list.map(([label]) => ` ${label} `);
      const bw = texts.reduce((a, t) => a + width(t) + 1, 0);
      return {
        w: bw,
        draw: (at0: number) => {
          let x = at0;
          let out = "";
          list.forEach(([, yes], i) => {
            out += bg(C.yellow) + " " + bg(C.base) + fg(C.text) + BOLD + texts[i] + RESET;
            this.clicks.add(2, x + 1, width(texts[i]!), (b) => b === 0 && this.answerPrompt(yes));
            x += width(texts[i]!) + 1;
          });
          return out;
        },
      };
    };
    if (prompt && prompt.kind === "confirm") {
      const b = buttons([["Yes  Enter", true], ["No  Esc", false]]);
      const text = fit(` ⚠ ${prompt.message}`, Math.max(0, w - modeW - b.w));
      this.promptCursor = null;
      this.navHits = null;
      return s + bg(C.yellow) + fg(C.crust) + BOLD + text + RESET + b.draw(col + width(text)) +
        bg(C.mauve) + fg(C.crust) + BOLD + mode + RESET;
    }
    if (prompt && prompt.kind === "dialog") {
      const d = prompt.page.dialog;
      const label =
        d?.type === "prompt" ? `${d.message} ` :
        d?.type === "beforeunload" ? "Leave this page?" :
        `${d?.message ?? ""}`;
      const b = buttons(
        d?.type === "beforeunload" ? [["Leave  Enter", true], ["Stay  Esc", false]] :
        d?.type === "confirm" || d?.type === "prompt" ? [["OK  Enter", true], ["Cancel  Esc", false]] :
        [["OK  Enter", true]],
      );
      const fieldW = w - modeW - 4 - b.w;
      let text = fit(` ⚠ ${label}`, d?.type === "prompt" ? Math.min(width(label) + 4, Math.floor(fieldW / 2)) : Math.max(0, fieldW + 4));
      s += bg(C.yellow) + fg(C.crust) + BOLD + text + RESET;
      if (d?.type === "prompt") {
        const rest = w - modeW - width(text) - b.w;
        const v = prompt.edit.view(rest - 2);
        this.promptCursor = { row: 2, col: col + width(text) + 1 + v.cursorCol };
        s += bg(C.surface0) + fg(C.text) + " " + fit(v.text, rest - 1) + RESET;
        s += b.draw(col + w - modeW - b.w);
      } else {
        this.promptCursor = null;
        s += b.draw(col + width(text));
        s += barBg + " ".repeat(Math.max(0, w - modeW - width(text) - b.w));
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
    const menuW = 3; // the ≡ button at the end
    const fieldW = Math.max(4, w - (urlStart - col) - rightW - modeW - 1 - menuW);
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
    const rightCol = urlStart + fieldW + 1;
    this.noticeHit = notice.text && rightW > 0 ? [rightCol, rightCol + Math.min(width(notice.text), rightW)] : null;
    if (rightW > 0) s += barBg + (notice.text ? notice.style : fg(C.peach)) + fit(right, rightW);
    if (modeW) s += bg(C.mauve) + fg(C.crust) + BOLD + mode;
    const used = (urlStart - col) + fieldW + 1 + rightW + modeW;
    if (used < w - menuW) s += RESET + barBg + " ".repeat(w - menuW - used);
    // Every action, with its keys.
    s += RESET + at(2, col + w - menuW) + barBg + fg(C.text) + BOLD + " ≡ ";
    this.clicks.add(2, col + w - menuW, menuW, (b) => b === 0 && this.openMainMenu(col + w - 1));
    return s + RESET;
  }

  private promptCursor: { row: number; col: number } | null = null;
  private lastUploadDir = `${homedir()}/`;

  private cursorSeq(): string {
    const c = this.promptCursor;
    if (!c || this.covered()) return "\x1b[?25l";
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
      const { row, col, cols } = g.header;
      if (cols < 8) {
        s += at(row, col) + style + fit(text, cols) + RESET;
        continue;
      }
      // A close button at the right end (right-click the header for more).
      s += at(row, col) + style + fit(text, cols - 3) + " × " + RESET;
      this.clicks.add(row, col + cols - 3, 3, (b) => (b === 2 ? this.paneMenu(page, col + cols - 3, row) : this.closePage(page)));
    }
    for (const sep of this.seps) {
      if (sep.split.dir !== "h") continue;
      for (let r = 0; r < sep.rect.rows; r++) {
        s += at(sep.rect.row + r, sep.rect.col) + bg(C.crust) + fg(C.surface1) + "│";
      }
    }
    return s + RESET;
  }

  /** The page whose pane shows a long dialog message in full (its picture is hidden meanwhile). */
  private panelPage: Page | null = null;

  /**
   * A dialog message too long for the address line (or with line breaks)
   * is shown in full over its page's pane; the address line keeps the
   * buttons.
   */
  private dialogPanel(): string {
    const p = this.prompt;
    const d = p?.kind === "dialog" ? p.page.dialog : null;
    const g = p?.kind === "dialog" ? this.geom.get(p.page) : undefined;
    const message = d && d.type !== "beforeunload" ? d.message : "";
    const fits = message && !/\n/.test(message) && width(message) + 40 < this.cols - this.mainCol();
    const page = p?.kind === "dialog" && message && !fits && g ? p.page : null;
    if (this.panelPage && this.panelPage !== page) {
      // Message gone: clear it and put the page's picture back.
      this.panelPage = null;
      setTimeout(() => this.fullRedraw(), 0);
    }
    if (!page || !g) return "";
    this.panelPage = page;
    const r = g.content;
    let s = page.imageIds.map(deleteImage).join("");
    page.imageIds = [];
    page.placed = null;
    const inner = Math.max(10, Math.min(r.cols - 4, 100));
    const lines: string[] = [];
    for (const para of message.replace(/\r/g, "").split("\n")) {
      let rest = para;
      do {
        lines.push(truncate(rest, inner + 1).replace(/…$/, ""));
        rest = rest.slice(lines[lines.length - 1]!.length);
      } while (rest.length > 0 && lines.length < r.rows - 3);
    }
    const shown = lines.slice(0, Math.max(1, r.rows - 3));
    const left = r.col + Math.max(0, Math.floor((r.cols - inner - 4) / 2));
    const top = r.row + 1;
    for (let i = 0; i < r.rows; i++) s += at(r.row + i, r.col) + bg(C.crust) + " ".repeat(r.cols);
    s += at(top, left) + bg(C.base) + fg(C.yellow) + BOLD + fit("  ⚠ The page says:", inner + 4) + RESET;
    shown.forEach((line, i) => {
      s += at(top + 1 + i, left) + bg(C.base) + fg(C.text) + fit(`  ${line}`, inner + 4) + RESET;
    });
    return s;
  }

  /** The key reference, drawn over the (blanked) pane area; two columns if it's short. */
  private helpOverlay(): string {
    const area = this.paneArea();
    const keyW = Math.max(...HELP.map(([k]) => width(k)));
    const descW = Math.max(...HELP.map(([, d]) => width(d)));
    const colW = keyW + descW + 6;
    // A newer termium: what it is and how to get it, across the top.
    const news: [style: string, text: string][] = [];
    const cur = this.opts.version;
    if (!this.updatesShown) {
      // This terminal opted out of update news.
    } else if (this.updateInstalled) {
      news.push([fg(C.yellow) + BOLD, `  restart to update  termium ${cur} → ${displayVersion(this.updateInstalled)}`]);
      news.push([fg(C.text), "  installed; this session runs the old one until it restarts: Ctrl+B U"]);
    } else if (this.updateLatest) {
      news.push([fg(C.green) + BOLD, `  update available  termium ${cur} → ${displayVersion(this.updateLatest)}`]);
      news.push([fg(C.text), "  Ctrl+B U updates, or run:"]);
    }
    const cmd = news.length && !this.updateInstalled;
    const wantW = Math.max(colW, cmd ? width(UPGRADE_CMD) + 4 : 0, ...news.map(([, t]) => width(t) + 2));
    if (cmd) {
      for (const l of wrapWords(UPGRADE_CMD, Math.max(1, Math.min(area.cols, wantW) - 4))) news.push([fg(C.blue), `  ${l}`]);
    }
    if (news.length) news.push(["", ""]);
    const fitsOne = HELP.length + news.length + 4 <= area.rows;
    const columns = !fitsOne && area.cols >= colW * 2 + 2 ? 2 : 1;
    const perCol = Math.ceil(HELP.length / columns);
    const boxW = Math.min(area.cols, Math.max(colW * columns + 2, wantW));
    const boxH = Math.min(area.rows, perCol + news.length + 4);
    const shown = Math.max(0, Math.min(perCol, boxH - 4 - news.length)); // entry rows per column that fit
    const top = area.row + Math.max(0, Math.floor((area.rows - boxH) / 2));
    const left = area.col + Math.max(0, Math.floor((area.cols - boxW) / 2));
    // (With placeholders the overlay's text replaces the cells showing them.)
    let s = this.placeholders ? "" : this.deleteOwnImages();
    for (let r = 0; r < area.rows; r++) s += at(area.row + r, area.col) + bg(C.crust) + " ".repeat(area.cols);
    const panel = bg(C.base) + fg(C.text);
    const hidden = Math.max(0, HELP.length - shown * columns);
    s += at(top, left) + panel + BOLD + fg(C.mauve) + fit(" termium keys", boxW) + RESET;
    s += at(top + 1, left) + panel + fit("", boxW);
    const newsRows = Math.min(news.length, Math.max(0, boxH - 4));
    for (let r = 0; r < newsRows; r++) s += at(top + 2 + r, left) + panel + news[r]![0] + fit(news[r]![1], boxW) + RESET;
    for (let r = 0; r < shown; r++) {
      let line = "";
      for (let c = 0; c < columns; c++) {
        const entry = HELP[c * perCol + r];
        const text = entry && entry[0] ? `  ${entry[0].padEnd(keyW)}  ${entry[1]}` : "";
        line += columns === 1 ? text : fit(text, c === 0 ? colW : boxW - colW);
      }
      const heading = columns === 1 && HELP[r]?.[1] === "" && HELP[r]?.[0] !== "";
      s += at(top + 2 + newsRows + r, left) + panel + (heading ? fg(C.mauve) : "") + fit(line, boxW) + RESET;
    }
    s += at(top + boxH - 2, left) + panel + fit("", boxW);
    const footer = hidden > 0 ? `  ${hidden} more: make the terminal taller · any key closes` : "  any key closes";
    s += at(top + boxH - 1, left) + panel + fg(C.overlay) + fit(footer, boxW) + RESET;
    return s + RESET;
  }

  // ---------------------------------------------------------- updates
  //
  // Update news never takes the keyboard on its own: a newer release, an
  // update's progress and the restart it needs show as a notice in the
  // address line (when nothing else is open there) and a badge in the tab
  // bar. Only Ctrl+B U, or a click on the notice or the badge, opens the
  // update box, whose keys answer it; any other key closes the box and goes
  // on as usual, and a paste always reaches the page.

  /** A newer release (the tab bar's badge). */
  private updateLatest: string | null = null;
  /** A newer termium installed on disk: this session runs the old one until it restarts. */
  private updateInstalled: string | null = null;
  /** The attached terminal wants update news (it didn't opt out): otherwise none is shown. */
  private updatesShown = false;
  /** What there is to answer or know (an offer, an update under way, its outcome, a restart due). */
  private updateBox: UpdateBox | null = null;
  /**
   * The newest release offered in this session's life: a release is offered
   * once, and after that only a newer one is (whether the first was
   * answered "later" or replaced in the notice by a newer one).
   */
  private lastOffered: string | null = null;
  /** Installed versions a restart was offered for. */
  private offered = new Set<string>();
  private badgeHit: [number, number] | null = null;
  private noticeHit: [number, number] | null = null;
  /** Why `u` can't update here, worked out when the box opens. */
  private updateBlocker: string | null = null;

  /** Set before a terminal attaches: whether it shows update news at all. */
  setUpdatesShown(on: boolean): void {
    if (this.updatesShown === on) return;
    this.updatesShown = on;
    if (!on && this.mode === "update") {
      this.mode = "normal";
      this.fullRedraw();
    }
    this.queueChrome();
  }

  /** A release the user skipped (never offered). */
  private skippedTag: string | null = null;

  /** Whether `tag` may be offered: not skipped, and newer than anything offered in this session. */
  private mayOffer(tag: string): boolean {
    return tag !== this.skippedTag && (!this.lastOffered || isNewer(tag, this.lastOffered));
  }

  /** A release the user skipped (maybe in another session): never offered, and an offer of it on screen is withdrawn. */
  updateSkipped(tag: string | null | undefined): void {
    if (!tag) return;
    this.skippedTag = tag;
    const box = this.updateBox;
    if (box?.state !== "offer" || box.tag !== tag) return;
    this.updateBox = null;
    if (this.mode === "update") this.closeUpdate(false);
    else this.queueChrome();
  }

  /**
   * The latest release is `tag` (the newest stable one a check found): a
   * badge or offer of a release newer than that (one pulled since, say), or
   * not newer than this termium, is withdrawn.
   */
  latestRelease(tag: string): void {
    if (!parseVersion(tag)) return;
    const stale = (t: string | null) => !!t && (isNewer(t, tag) || !isNewer(t, this.opts.version));
    if (stale(this.updateLatest)) {
      this.updateLatest = isNewer(tag, this.opts.version) ? tag : null;
      this.queueChrome();
    }
    const box = this.updateBox;
    if (box?.state === "offer" && stale(box.tag)) {
      this.updateBox = null;
      if (this.mode === "update") this.closeUpdate(false);
      else this.queueChrome();
    }
  }

  /** The update check found newer release `tag`; `offer` is false when the user skipped it. */
  updateAvailable(tag: string, offer: boolean): void {
    if (!offer) this.updateSkipped(tag);
    if (!isNewer(tag, this.opts.version)) return;
    if (this.updateInstalled && !isNewer(tag, this.updateInstalled)) return; // that one's installed already
    if (this.updateLatest !== tag) {
      this.updateLatest = tag;
      this.queueChrome();
    }
    const box = this.updateBox;
    if (box?.state === "offer") {
      if (box.tag === tag || !isNewer(tag, box.tag)) return;
      // A newer release makes the one offered out of date: it's offered
      // instead if it may be, else nothing is (it was skipped).
      if (this.mayOffer(tag)) {
        box.tag = tag;
        this.lastOffered = tag;
      } else {
        this.updateBox = null;
        if (this.mode === "update") this.closeUpdate(false);
      }
      this.queueChrome();
      return;
    }
    if (box) return; // an update under way (or done) isn't interrupted
    if (!this.mayOffer(tag)) return;
    this.lastOffered = tag;
    this.updateBox = { tag, state: "offer" };
    this.queueChrome();
  }

  /** The newer termium that was installed is gone (or another version now): no restart into it is offered. */
  clearInstalled(): void {
    this.updateInstalled = null;
    if (this.updateBox && (this.updateBox.state === "installed" || this.updateBox.state === "done")) {
      this.updateBox = null;
      if (this.mode === "update") this.closeUpdate(false);
    }
    this.queueChrome();
  }

  /** A terminal running a newer termium attached: that one is installed, and this session runs the old one. */
  newerInstalled(version: string): void {
    if (!isNewer(version, this.opts.version)) return;
    if (this.updateInstalled && !isNewer(version, this.updateInstalled)) return;
    this.updateInstalled = version;
    if (this.updateLatest && !isNewer(this.updateLatest, version)) this.updateLatest = null;
    this.queueChrome();
    const box = this.updateBox;
    if (box && box.state !== "offer") return;
    if (this.offered.has(`installed:${version}`)) return;
    this.offered.add(`installed:${version}`);
    this.updateBox = { tag: version, state: "installed" };
  }

  updateStep(step: Step): void {
    const box = this.updateBox;
    if (box?.state !== "working") return;
    box.step = step;
    this.queueChrome();
  }

  /** The self-update ended: `installed` is the version now on disk, or `error` why it failed. */
  /** When the last update's outcome came. */
  private updateResultAt = 0;

  updateDone(tag: string, installed: string | null, error: string | null, path?: string): void {
    this.updateResultAt = Date.now();
    if (installed) {
      this.updateInstalled = installed;
      this.updateLatest = null;
    }
    this.updateBox = { tag: installed ?? tag, state: error ? "failed" : "done", error: error ?? undefined, path };
    this.queueChrome();
  }

  /** Puts the box away; with `answered`, what it asked is settled (an update under way carries on). */
  private closeUpdate(answered: boolean): void {
    if (answered && this.updateBox?.state !== "working") this.updateBox = null;
    this.mode = "normal";
    this.fullRedraw();
  }

  /** Ctrl+B U, or a click on the notice or the badge: the box for what's known, else says there's nothing. */
  private openUpdate(): void {
    // A restart into a termium already installed isn't update news: it's offered whatever the opt-outs.
    if (!this.updatesShown && !(this.updateInstalled && (!this.updateBox || this.updateBox.state === "installed" || this.updateBox.state === "done"))) {
      this.showToast("Update news is off in this terminal (--no-update-check, TERMIUM_NO_UPDATE_CHECK or CI)", 5000);
      return;
    }
    if (!this.updateBox) {
      if (this.updateInstalled) this.updateBox = { tag: this.updateInstalled, state: "installed" };
      else if (this.updateLatest && this.updateLatest === this.skippedTag) {
        this.showToast(`termium ${displayVersion(this.updateLatest)} was skipped (termium update installs it)`, 5000);
        return;
      } else if (this.updateLatest) this.updateBox = { tag: this.updateLatest, state: "offer" };
      else {
        this.showToast(`termium ${this.opts.version}: no newer release known (termium check-update checks now)`, 5000);
        return;
      }
    }
    // Opened on purpose: its outcome is on screen, keys from now on are meant for it.
    this.updateResultAt = 0;
    this.updateBlocker = this.updateBox.state === "offer" ? (this.opts.update ? this.opts.update.blocker() : "updates aren't available here") : null;
    this.prompt = null;
    this.mode = "update";
    this.fullRedraw();
  }

  /**
   * Keys while the box is open (it was opened on purpose). Only its letters
   * act (u, l, s, r); Escape closes it; any other key (Enter and Space
   * included) closes it and goes on as usual.
   */
  private updateKey(ev: KeyEvent, combo: string): void {
    const box = this.updateBox;
    // A key that arrives just as an update ended was pressed before its outcome
    // was on screen: it never dismisses that outcome (the failure and its hint stay).
    const fresh = Date.now() - this.updateResultAt < 600;
    const pass = () => {
      this.closeUpdate(box?.state === "failed" && !fresh);
      this.onKey(ev);
    };
    if (!box) return pass();
    if (combo === "escape") return this.closeUpdate(box.state === "failed" && !fresh);
    if (fresh && (box.state === "done" || box.state === "failed")) return pass();
    const shown = displayVersion(box.tag);
    switch (box.state) {
      case "offer":
        if (combo === "u" && !this.updateBlocker && this.opts.update) {
          box.state = "working";
          box.step = "downloading";
          this.opts.update.start(box.tag);
          this.queueChrome();
        } else if (combo === "s") {
          this.skippedTag = box.tag;
          this.closeUpdate(true);
          const t = this.ticket({ sameUi: false });
          void this.opts.update?.skip(box.tag).then((saved) =>
            t.valid() && this.updatesShown && this.showToast(
              saved
                ? `termium ${shown} skipped: not offered again`
                : `termium ${shown} skipped in this session only: couldn't save it (the update cache is busy)`,
              saved ? 4000 : 8000,
            ),
          );
        } else if (combo === "l") {
          this.closeUpdate(true);
        } else pass();
        return;
      case "working":
        return pass();
      case "done":
      case "installed":
        if (combo === "r") {
          this.closeUpdate(false);
          void this.requestRestart();
        } else if (combo === "l") {
          this.closeUpdate(true);
          this.showToast(`This session runs termium ${this.opts.version} until it restarts (Ctrl+B U restarts it)`, 5000);
        } else pass();
        return;
      case "failed":
        return pass();
    }
  }

  /** Restarts into the installed termium; first asks if a page may have unsaved changes (as Ctrl+Q does). */
  private async requestRestart(): Promise<void> {
    const t = this.ticket();
    const asking = (await Promise.all([...this.pages.values()].map((page) => this.wouldAsk(page)))).filter(Boolean).length;
    // (A restart isn't update news: it goes ahead with update checks off too.)
    if (!t.valid()) return this.opts.log("restart: the terminal that asked left or opened something else meanwhile; dropped");
    if (asking === 0 && this.downloads.size === 0) return this.opts.update?.restart(false);
    this.askRestart(asking);
  }

  /** "Restart anyway?": yes restarts without asking again. */
  private askRestart(asking: number): void {
    const downloading = this.downloads.size;
    const reasons = [
      asking ? `${asking === 1 ? "a page" : `${asking} pages`} may have unsaved changes` : "",
      downloading ? `${downloading === 1 ? "a download is" : `${downloading} downloads are`} in progress` : "",
    ].filter(Boolean).join(" and ");
    this.prompt = {
      kind: "confirm",
      tag: "restart",
      message: `${reasons[0]!.toUpperCase()}${reasons.slice(1)}. Restart anyway?`,
      onYes: () => this.opts.update?.restart(true),
      edit: new LineEdit("", false),
    };
    this.queueChrome();
  }

  /**
   * Right before a restart (after the checks that take a while): still fine?
   * The person may have started typing into a page meanwhile: then they're
   * asked again, and it's false; false too if they left or opened something.
   */
  async restartStillSafe(t: { valid: () => boolean }): Promise<boolean> {
    const asking = (await Promise.all([...this.pages.values()].map((page) => this.wouldAsk(page)))).filter(Boolean).length;
    if (!t.valid()) {
      this.opts.log("restart: the terminal that asked left or opened something else meanwhile; dropped");
      return false;
    }
    if (asking === 0 && this.downloads.size === 0) return true;
    this.opts.log("restart: a page may have unsaved changes now; asking again");
    this.askRestart(asking);
    return false;
  }


  /** The notice in the address line: the longest wording that fits `room` columns ("" if none). */
  private notice(room: number): { text: string; style: string } {
    const box = this.updateBox;
    if (!box || !this.updatesShown || this.mode !== "normal" || this.prompt) return { text: "", style: "" };
    const nv = displayVersion(box.tag);
    const cur = this.opts.version;
    const [style, options] =
      box.state === "offer" ? [fg(C.green) + BOLD, [
        `↑ termium ${nv} is available (you have ${cur}) · Ctrl+B U`,
        `↑ termium ${nv} is available · Ctrl+B U`,
        `↑ ${nv} · ^B U`,
      ]] :
      box.state === "working" ? [fg(C.yellow), [`updating to termium ${nv}: ${stepLabel(box.step ?? "downloading")}`, `updating…`]] :
      box.state === "failed" ? [fg(C.red) + BOLD, [`✗ update to termium ${nv} failed · Ctrl+B U`, `✗ update failed · ^B U`, `✗ ^B U`]] :
      [fg(C.yellow) + BOLD, [
        `↻ termium ${nv} is installed; this session runs ${cur} · Ctrl+B U restarts`,
        `↻ termium ${nv} installed · Ctrl+B U restarts`,
        `↻ ${nv} · ^B U`,
      ]];
    const text = (options as string[]).map((t) => ` ${t} `).find((t) => width(t) <= room) ?? "";
    return { text, style: style as string };
  }

  /** The tab bar's badge: a newer release (↑), or a newer termium installed and waiting for a restart (↻). */
  private badge(full: number): { text: string; style: string } | null {
    const short = full < 50;
    if (!this.updatesShown) return null;
    if (this.updateInstalled) {
      return { text: short ? " ↻ " : ` ↻ v${displayVersion(this.updateInstalled)} `, style: bg(C.crust) + fg(C.yellow) + BOLD };
    }
    if (this.updateLatest) {
      return { text: short ? " ↑ " : ` ↑ v${displayVersion(this.updateLatest)} `, style: bg(C.crust) + fg(C.green) + BOLD };
    }
    return null;
  }

  /** The update box, over the (blanked) pane area. */
  private updateOverlay(): string {
    const box = this.updateBox;
    if (!box) return "";
    const area = this.paneArea();
    const cur = this.opts.version;
    const nv = displayVersion(box.tag);
    const boxW = Math.min(area.cols, 96);
    const inner = Math.max(1, boxW - 2);
    type Seg = [style: string, text: string];
    const lines: Seg[][] = [];
    const txt = fg(C.text);
    const key = fg(C.mauve) + BOLD;
    const ok = fg(C.green) + BOLD;
    const dim = fg(C.overlay);
    const add = (...segs: Seg[]) => lines.push(segs);
    const blank = () => lines.push([]);
    const wrapped = (style: string, text: string) => {
      for (const l of wrapWords(text, inner - 1)) add([style, ` ${l}`]);
    };
    // Each choice's line is clickable: a click does what its key does.
    const choiceAt = new Map<number, string>();
    const choice = (k: string, what: string) => {
      choiceAt.set(lines.length, k);
      add([key, ` ${k.padEnd(5)}`], [txt, what]);
    };
    const headline = () => add([ok, ` termium ${nv}`], [txt, ` is available (you have ${cur})`]);
    const byHand = () => {
      add([dim, " update by hand:"]);
      wrapped(fg(C.blue), UPGRADE_CMD);
    };
    let title = "";
    let footer = "";
    switch (box.state) {
      case "offer":
        title = "update available";
        headline();
        blank();
        if (this.updateBlocker) {
          wrapped(txt, `This termium can't update itself: ${this.updateBlocker}.`);
          blank();
          byHand();
          blank();
          choice("l", "later: ask again when this session restarts");
          choice("s", "skip this version");
          footer = "l later · s skip";
        } else {
          choice("u", "update now: download, verify and replace the termium binary");
          choice("l", "later: ask again when this session restarts");
          choice("s", "skip this version");
          footer = "u update · l later · s skip · Esc close";
        }
        break;
      case "working":
        title = "updating";
        headline();
        blank();
        add([fg(C.yellow), ` updating to ${nv}: ${stepLabel(box.step ?? "downloading")}`]);
        footer = "Esc puts this away (the update carries on)";
        break;
      case "done":
      case "installed":
        title = box.state === "done" ? "updated" : "restart to update";
        if (box.state === "done") {
          add([ok, ` ✓ updated to termium ${nv}`]);
          if (box.path) wrapped(dim, box.path);
        }
        else add([ok, ` termium ${nv}`], [txt, " is installed"]);
        blank();
        wrapped(txt, `This session keeps running termium ${cur} until it restarts.`);
        blank();
        choice("r", "restart now: reopens your spaces, tabs and splits");
        add([txt, "       (pages reload; text typed into them is lost)"]);
        choice("l", "later: Ctrl+B U restarts it any time");
        footer = "r restart · l later · Esc close";
        break;
      case "failed":
        title = "update failed";
        add([fg(C.red) + BOLD, ` ✗ update to ${nv} failed`]);
        wrapped(txt, box.error ?? "");
        blank();
        byHand();
        footer = "Esc close";
        break;
    }
    const boxH = Math.min(area.rows, lines.length + 4);
    const top = area.row + Math.max(0, Math.floor((area.rows - boxH) / 2));
    const left = area.col + Math.max(0, Math.floor((area.cols - boxW) / 2));
    const panel = bg(C.base) + fg(C.text);
    let s = this.placeholders ? "" : this.deleteOwnImages();
    for (let r = 0; r < area.rows; r++) s += at(area.row + r, area.col) + bg(C.crust) + " ".repeat(area.cols);
    s += at(top, left) + panel + BOLD + fg(C.mauve) + fit(` ${title}`, boxW) + RESET;
    s += at(top + 1, left) + panel + fit("", boxW);
    const shown = Math.max(0, boxH - 4);
    for (let i = 0; i < shown; i++) {
      const k = choiceAt.get(i);
      if (k) this.clicks.add(top + 2 + i, left, boxW, (b) => b === 0 && this.updateKey(letterKey(k), k));
      let line = "";
      let used = 0;
      for (const [style, text] of lines[i] ?? []) {
        const t = truncate(text, Math.max(0, boxW - used));
        if (!t) break;
        line += panel + style + t + RESET;
        used += width(t);
      }
      s += at(top + 2 + i, left) + line + panel + " ".repeat(Math.max(0, boxW - used)) + RESET;
    }
    s += at(top + boxH - 2, left) + panel + fit("", boxW);
    s += at(top + boxH - 1, left) + panel + fg(C.overlay) + fit(`  ${footer}`, boxW) + RESET;
    // Its keys ("u update · l later") click too: in a short terminal the choice lines may be cut.
    let x = left + 2;
    for (const seg of footer.split(" · ")) {
      const k = /^([a-z]) /.exec(seg)?.[1];
      if (k && x + width(seg) <= left + boxW) this.clicks.add(top + boxH - 1, x, width(seg), (b) => b === 0 && this.updateKey(letterKey(k), k));
      x += width(seg) + 3;
    }
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
      void this.requestQuit();
      return;
    }
    // The person's input (keys, pastes, clicks): for a moment after, agents and other clients wait (see humanBusy).
    if ((ev.type === "key" && ev.event !== "release") || ev.type === "paste" || (ev.type === "mouse" && ev.action === "press")) this.lastKeyAt = Date.now();
    if (!this.ready || this.holds.size > 0) {
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
        // The update box (or a menu) steps aside: a paste always reaches the page.
        if (this.mode === "update") this.closeUpdate(false);
        this.closeMenu();
        // Help, prefix, resize and space picking own the keyboard: a paste
        // then must not slip through to the page underneath.
        if (this.mode !== "normal") return;
        const p = this.prompt;
        if (p && p.kind !== "confirm" && (p.kind !== "dialog" || p.page.dialog?.type === "prompt")) {
          p.edit.insert(ev.text);
          this.queueChrome();
        } else if (p) {
          // A yes/no prompt or a page blocked on alert/confirm: nowhere for text to go.
        } else if (this.focused) {
          void this.pastePage(this.focused, ev.text);
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
      const k = ev.code || ev.key;
      const held = this.pageKeysDown.get(k);
      this.pageKeysDown.delete(k);
      if (held && this.pages.has(held.page.sessionId)) this.sendKey(held.page, ev);
      const synthetic = this.syntheticDown.get(k);
      this.syntheticDown.delete(k);
      if (synthetic && this.pages.has(synthetic.page.sessionId)) this.domKey(synthetic.page, ev, "keyup");
      return;
    }
    if (isModifier(ev)) {
      if (!this.prompt && this.mode === "normal" && this.focused) this.sendKey(this.focused, ev);
      return;
    }
    const combo = comboOf(ev);

    if (this.menu) return this.menuKey(ev, combo);
    if (this.mode === "update") return this.updateKey(ev, combo);
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
    if (BROWSER_RESERVED.has(combo)) return;
    if (BROWSER_SHORTCUTS.has(combo)) {
      this.domKey(page, ev, "keydown");
      this.syntheticDown.set(ev.code || ev.key, { page, ev });
      return;
    }
    if (combo === "ctrl+c" || combo === "ctrl+x") {
      // Read the selection once earlier keys have landed (key events travel
      // through the browser process, evaluation goes straight to the page),
      // and before the key itself (a cut removes the text). Later input waits.
      const hold = `copy-${++this.pasteSeq}`;
      this.holdInput(hold);
      void (async () => {
        await this.settledInput();
        await this.copySelection(page);
        this.sendKey(page, ev);
        this.releaseInput(hold);
      })();
      return;
    }
    this.sendKey(page, ev);
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
        void this.requestQuit();
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
          this.pageKeysDown.delete(ev.code || ev.key); // its release is sent right here
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
        if (space) void this.closeGroup(space.tabs.flatMap((t) => leaves(t.root)), "space");
        return;
      case "b":
        this.sidebar = !this.sidebar;
        return this.relayoutAndRedraw();
      case "q": void this.requestQuit(); return;
      case "d": this.opts.detach(); return;
      case "shift+u": this.openUpdate(); return;
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
    if (prompt.kind === "confirm") {
      if (ev.key === "Enter") {
        this.prompt = null;
        prompt.onYes();
      } else if (ev.key === "Escape") {
        this.prompt = null;
      }
      // Whatever the page was asking before (a dialog, a file) comes back.
      this.syncPrompt();
      this.queueChrome();
      return;
    }
    if (prompt.kind === "dialog" && prompt.page.dialog?.type !== "prompt") {
      if (ev.key === "Enter" || ev.key === "Escape") {
        this.answerDialog(prompt.page, ev.key === "Enter", "");
      }
      return;
    }
    const result = prompt.edit.key(ev);
    if (result && prompt.kind === "file") prompt.page.fileChooser = null;
    if (result === "cancel" && prompt.kind === "file") this.cancelFileInput(prompt.sessionId, prompt.backendNodeId);
    if (result === "cancel") {
      if (prompt.kind === "dialog") this.answerDialog(prompt.page, false, "");
      this.prompt = null;
    } else if (result === "submit") {
      this.prompt = null;
      const text = prompt.edit.text;
      if (prompt.kind === "url") {
        const url = toUrl(text, this.opts.search);
        if (url && this.pages.has(prompt.page.sessionId)) {
          this.go(prompt.page, url);
        }
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

  /** Escape in the file prompt is a cancelled file picker: the input gets its `cancel` event. */
  private cancelFileInput(sessionId: string, backendNodeId: number): void {
    this.cdp
      .send("DOM.resolveNode", { backendNodeId }, sessionId)
      .then(({ object }) =>
        this.cdp.send("Runtime.callFunctionOn", {
          objectId: object.objectId,
          functionDeclaration: "function () { this.dispatchEvent(new Event('cancel', { bubbles: true })); }",
        }, sessionId),
      )
      .catch(() => {});
  }

  private uploadFiles(prompt: Extract<Prompt, { kind: "file" }>, text: string): void {
    const home = homedir();
    // Relative paths are relative to the attached terminal's directory, not the session's.
    const expand = (f: string) => resolvePath(this.cwd, f === "~" || f.startsWith("~/") ? home + f.slice(1) : f);
    // A path that names a file as typed is that file, spaces and all; only
    // otherwise is the text split (quotes and backslashes keep spaces).
    const whole = expand(splitPaths(text).length === 1 ? splitPaths(text)[0]! : text.trim());
    let files: string[];
    if (existsSync(whole) && statSync(whole).isFile()) files = [whole];
    else if (!prompt.multiple) files = [whole];
    else files = splitPaths(text).map(expand);
    const missing = files.find((f) => !existsSync(f) || !statSync(f).isFile());
    if (!files.length || missing) {
      this.showToast(missing ? `No such file: ${missing}` : "No file given");
      this.prompt = { ...prompt, edit: new LineEdit(text, false) };
      return;
    }
    // Absolute paths only: the browser kills the renderer over a relative one.
    files = files.map((f) => resolvePath(this.cwd, f));
    this.lastUploadDir = `${dirname(files[0]!)}/`;
    this.cdp
      .send("DOM.setFileInputFiles", { files, backendNodeId: prompt.backendNodeId }, prompt.sessionId)
      .then(() => this.showToast(`Attached ${files.length === 1 ? files[0] : `${files.length} files`}`))
      .catch((e) => this.showToast(`Upload failed: ${e}`));
  }

  private answerDialog(page: Page, accept: boolean, promptText: string): void {
    if (page.dialog?.type === "beforeunload" && !accept) {
      page.navSeq++; // a cancelled navigation is not something to retry
      page.closing = false; // and a cancelled close stays open
    }
    page.navStarted = 0;
    this.cdp
      .send("Page.handleJavaScriptDialog", { accept, promptText }, page.dialog?.sessionId ?? page.sessionId, { secret: true })
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

  private syntheticDown = new Map<string, { page: Page; ev: KeyEvent }>();
  /** Where the mouse buttons now down were pressed (to release them if the terminal goes). */
  private mousePressedAt: { page: Page; x: number; y: number } | null = null;

  /**
   * The session of the frame that has focus: the page's own, or a focused
   * cross-site iframe's (a separate session).
   */
  private async focusedSession(page: Page): Promise<string> {
    const crossFrame = `(() => { let a = document.activeElement;
      while (a && (a.tagName === "IFRAME" || a.tagName === "FRAME")) {
        let inner = null; try { inner = a.contentDocument; } catch {}
        if (!inner) return true;
        a = inner.activeElement;
      }
      return false; })()`;
    const ask = (sid: string, expression: string) =>
      Promise.race([
        this.cdp.send("Runtime.evaluate", { expression, returnByValue: true }, sid).then((r) => r?.result?.value, () => null),
        Bun.sleep(1000).then(() => null),
      ]);
    if ((await ask(page.sessionId, crossFrame)) !== true) return page.sessionId;
    for (const [sid, owner] of this.frameOwner) {
      if (owner !== page) continue;
      if ((await ask(sid, `document.hasFocus() && !${crossFrame}`)) === true) return sid;
    }
    return page.sessionId;
  }

  /** Delivers a key to the focused element as a DOM event only (see BROWSER_SHORTCUTS). */
  private domKey(page: Page, ev: KeyEvent, type: "keydown" | "keyup"): void {
    const init = {
      key: ev.key, code: ev.code, keyCode: ev.vk, which: ev.vk, location: ev.location, repeat: ev.event === "repeat",
      ctrlKey: ev.mods.ctrl, shiftKey: ev.mods.shift, altKey: ev.mods.alt, metaKey: ev.mods.meta,
      bubbles: true, cancelable: true, composed: true,
    };
    const expression = `(() => {
      let d = document, a = d.activeElement;
      for (;;) {
        if (a && a.shadowRoot && a.shadowRoot.activeElement) { a = a.shadowRoot.activeElement; continue; }
        if (a && (a.tagName === "IFRAME" || a.tagName === "FRAME")) {
          let inner = null; try { inner = a.contentDocument; } catch {}
          if (inner) { d = inner; a = d.activeElement; continue; }
        }
        break;
      }
      (a || d.body || d.documentElement).dispatchEvent(new KeyboardEvent(${JSON.stringify(type)}, ${JSON.stringify(init)}));
    })()`;
    const hold = `domkey-${++this.pasteSeq}`;
    this.holdInput(hold);
    this.inputTail = (async () => {
      const sid = await this.focusedSession(page);
      await this.cdp.send("Runtime.evaluate", { expression }, sid).catch(() => {});
    })().finally(() => this.releaseInput(hold));
  }

  private sendKey(page: Page, ev: KeyEvent): void {
    const modifiers = modBits(ev.mods);
    const base = {
      modifiers,
      key: ev.key,
      code: ev.code,
      windowsVirtualKeyCode: ev.vk,
      // No nativeVirtualKeyCode: it's read as the platform's own key code,
      // and on macOS a Windows code there makes Helium treat keys without
      // text (Shift, arrows, Tab…) as a shortcut that opens its settings.
      location: ev.location,
    };
    const sid = page.sessionId;
    const send = (params: object) => (this.inputTail = this.cdp.send("Input.dispatchKeyEvent", params, sid).catch(() => {}));
    if (ev.event === "release") {
      void send({ type: "keyUp", ...base });
      return;
    }
    const text = ev.text;
    if (text.length > 4 || !ev.key || ev.key === "Unidentified") {
      // A key event carries at most 4 UTF-16 units of text; longer text (an
      // IME commit, a long emoji sequence) is inserted instead.
      if (text) this.inputTail = this.cdp.send("Input.insertText", { text }, sid).catch(() => {});
      return;
    }
    void send({
      type: text ? "keyDown" : "rawKeyDown",
      ...base,
      text,
      unmodifiedText: text,
      autoRepeat: ev.event === "repeat",
      commands: editCommands(ev),
    });
    if (ev.legacy) void send({ type: "keyUp", ...base });
    else this.pageKeysDown.set(ev.code || ev.key, { page, ev });
  }

  /**
   * Pastes like a real paste: the text goes on the page's clipboard, then
   * Ctrl+V runs the paste command, so `paste` events fire. Input waits until
   * it's done so later keys can't overtake it.
   */
  private async pastePage(page: Page, text: string): Promise<void> {
    const hold = `paste-${++this.pasteSeq}`;
    this.holdInput(hold);
    const sid = page.sessionId;
    // (Pasted text is never traced.)
    const evaluate = (expression: string) =>
      this.cdp.send("Runtime.evaluate", { expression, awaitPromise: true, userGesture: true, returnByValue: true }, sid, { secret: true });
    let origin = "";
    const setClipboardAccess = (setting: "granted" | "prompt") =>
      Promise.all(
        ["clipboard-read", "clipboard-write"].map((name) =>
          this.cdp.send("Browser.setPermission", { permission: { name }, setting, origin }),
        ),
      );
    try {
      await this.settledInput();
      // Clipboard access is granted to the page receiving the paste, for the
      // paste only, and the clipboard is emptied afterwards: no other site
      // can read what was pasted.
      origin = (await evaluate("location.origin"))?.result?.value ?? "";
      if (!/^https?:\/\//.test(origin)) throw new Error("no origin to grant");
      await setClipboardAccess("granted");
      // The browser clipboard is emptied afterwards rather than restored:
      // restoring would mean reading it while this site has access, and it
      // may hold something copied on another site.
      const r = await evaluate(`navigator.clipboard.writeText(${JSON.stringify(text)}).then(() => true, () => false)`);
      if (r?.result?.value !== true) throw new Error("clipboard write refused");
      const key = { key: "v", code: "KeyV", windowsVirtualKeyCode: 86, modifiers: 2 };
      await this.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...key, commands: ["paste"] }, sid);
      await this.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...key }, sid);
      await evaluate(`navigator.clipboard.writeText("").then(() => true, () => false)`);
    } catch {
      // No clipboard route (about:, file:, data:, or refused): fire a paste
      // event the page can handle, and insert the text unless it did.
      const handled = await this.cdp
        .send("Runtime.evaluate", {
          expression: `(() => {
            let d = document, a = d.activeElement;
            for (;;) {
              if (a && a.shadowRoot && a.shadowRoot.activeElement) { a = a.shadowRoot.activeElement; continue; }
              if (a && (a.tagName === "IFRAME" || a.tagName === "FRAME")) {
                let inner = null; try { inner = a.contentDocument; } catch {}
                if (inner) { d = inner; a = d.activeElement; continue; }
              }
              break;
            }
            const data = new DataTransfer();
            data.setData("text/plain", ${JSON.stringify(text)});
            const ev = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true, composed: true });
            (a || d.body || d.documentElement).dispatchEvent(ev);
            return ev.defaultPrevented; })()`,
          returnByValue: true,
        }, sid, { secret: true })
        .then((r) => r?.result?.value === true, () => false);
      if (!handled) await this.cdp.send("Input.insertText", { text }, sid).catch(() => {});
    } finally {
      if (origin) await setClipboardAccess("prompt").catch(() => {});
      this.releaseInput(hold);
    }
  }

  private pasteSeq = 0;
  /** The most recent input dispatch; resolves once the page has handled it. */
  private inputTail: Promise<unknown> = Promise.resolve();

  /** Earlier input has landed, or a second has passed (a hung page never answers). */
  private settledInput(): Promise<unknown> {
    return Promise.race([this.inputTail, Bun.sleep(1000)]);
  }

  private async copySelection(page: Page): Promise<void> {
    // Follows focus into same-origin iframes; a focused cross-site iframe is
    // a separate session, asked in turn below.
    const selection = (onlyIfFocused: boolean) => `(() => {
      if (${onlyIfFocused} && !document.hasFocus()) return null;
      let d = document, a = d.activeElement;
      while (a && (a.tagName === "IFRAME" || a.tagName === "FRAME")) {
        let inner = null;
        try { inner = a.contentDocument; } catch {}
        if (!inner) return { crossFrame: true };
        d = inner; a = d.activeElement;
      }
      // Like Chrome: nothing is copied out of a password field.
      if (a && a.tagName === "INPUT" && a.type === "password") return { text: "" };
      if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA") && typeof a.selectionStart === "number")
        return { text: a.value.slice(a.selectionStart, a.selectionEnd) };
      return { text: String(d.getSelection()) }; })()`;
    const ask = async (sid: string, onlyIfFocused: boolean) => {
      const { result } = await this.cdp.send("Runtime.evaluate", { expression: selection(onlyIfFocused), returnByValue: true }, sid);
      return (result?.value ?? null) as { text?: string; crossFrame?: boolean } | null;
    };
    try {
      let found = await ask(page.sessionId, false);
      if (found?.crossFrame) {
        found = null;
        for (const [sid, owner] of this.frameOwner) {
          if (owner !== page) continue;
          const r = await ask(sid, true).catch(() => null);
          if (r && !r.crossFrame) {
            found = r;
            break;
          }
        }
      }
      const text = typeof found?.text === "string" ? found.text : "";
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

  /** Opens what the user typed (an address, a bare host, or a search) in a new tab. */
  openTab(text: string): void {
    this.newTab(toUrl(text, this.opts.search) ?? undefined);
  }

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
    if (!tab || tab.focused === page || !leaves(tab.root).includes(page)) return;
    tab.focused = page;
    this.syncPrompt();
    this.activateFocused();
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
    if (this.mode === "update") {
      // A click on a choice answers it; anywhere else puts the box away (unanswered; the notice stays).
      const inBox = row > TOP_ROWS && col >= this.mainCol(); // (the chrome around it isn't clickable meanwhile)
      if (ev.action === "press" && !(inBox && this.clicks.click(col, row, ev.button))) this.closeUpdate(this.updateBox?.state === "failed");
      return;
    }

    if (this.menu) return this.menuMouse(ev, col, row);

    if (this.reorder) {
      if (ev.action === "move") return this.reorderTo(col, row);
      this.reorder = null;
      if (ev.action === "release") return this.queueChrome();
    }

    if (this.drag) {
      if (ev.action === "move") return this.dragTo(col, row);
      if (ev.action === "release") {
        this.drag = null;
        this.relayoutAndRedraw();
      }
      return;
    }

    if (ev.action === "move" && this.hoverPage && !this.mouseCapture &&
        ![...this.geom.values()].some((p) => p.item === this.hoverPage && inRect(p.content, col, row))) {
      this.leaveHover();
    }

    // Pointer captured by a page while a button is held.
    const captured = this.mouseCapture;
    if (captured && (ev.action === "move" || ev.action === "release")) {
      this.pageMouse(captured, ev, px, py);
      return;
    }

    if (ev.action === "move") {
      const hover = row === 1 ? (this.tabHits.find((h) => col >= h.start && col < h.end)?.index ?? -1) : -1;
      if (hover !== this.tabHover) {
        this.tabHover = hover;
        this.queueChrome();
      }
    }
    if (ev.action === "wheel" && row === 1 && col >= this.mainCol()) {
      return this.scrollTabs(ev.wheel === "up" || ev.wheel === "left" ? -1 : 1);
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
    if (this.clicks.click(col, row, ev.button)) return true;
    const mainCol = this.mainCol();
    if (col < mainCol) {
      const hit = this.spaceHits.find((h) => h.row === row);
      if (hit && ev.button === 2) this.spaceMenu(hit.index, col, row);
      if (ev.button !== 0) return true;
      if (hit) {
        if (this.mode === "spaces") this.mode = "normal";
        this.switchSpace(hit.index);
        const space = this.spaces[hit.index];
        if (space) this.reorder = { kind: "space", space };
      } else if (row === this.newSpaceRow) this.newSpace();
      return true;
    }
    if (row === 1) {
      if (this.badgeHit && col >= this.badgeHit[0] && col < this.badgeHit[1]) {
        if (ev.button === 0) this.openUpdate();
        return true;
      }
      const hit = this.tabHits.find((h) => col >= h.start && col < h.end);
      if (hit) {
        const tab = this.space?.tabs[hit.index];
        if (ev.button === 1 && tab) this.closeTab(tab);
        else if (ev.button === 2) this.tabMenu(hit.index, col);
        else if (ev.button === 0) {
          this.selectTab(hit.index);
          if (tab) this.reorder = { kind: "tab", tab };
        }
      } else if (this.newTabHit && col >= this.newTabHit.start && col < this.newTabHit.end && ev.button === 0) {
        this.newTab();
      }
      return true;
    }
    if (row === 2) {
      const page = this.focused;
      const n = this.navHits;
      if (!page || !n) return true;
      if (ev.button === 2) {
        if (col >= n.back[0] && col < n.back[1]) void this.historyMenu(page, -1, n.back[0]);
        else if (col >= n.fwd[0] && col < n.fwd[1]) void this.historyMenu(page, 1, n.fwd[0]);
        return true;
      }
      if (ev.button !== 0) return true;
      if (col >= n.back[0] && col < n.back[1]) void this.history(page, -1);
      else if (col >= n.fwd[0] && col < n.fwd[1]) void this.history(page, 1);
      else if (col >= n.reload[0] && col < n.reload[1]) {
        if (page.loading) this.cdp.send("Page.stopLoading", {}, page.sessionId).catch(() => {});
        else this.reload(page);
      } else if (col >= n.url[0] && col < n.url[1] && !this.prompt) this.openUrlPrompt(page);
      else if (this.noticeHit && col >= this.noticeHit[0] && col < this.noticeHit[1]) this.openUpdate();
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
      else if (ev.button === 2) this.paneMenu(header.item, col, row);
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

  /** Moves the tab or space being dragged to where the pointer is (it may have closed meanwhile). */
  private reorderTo(col: number, row: number): void {
    const r = this.reorder!;
    if (r.kind === "tab") {
      const space = this.space;
      const from = space ? space.tabs.indexOf(r.tab) : -1;
      const own = this.tabHits.find((h) => h.index === from);
      const hit = row === 1 ? this.tabHits.find((h) => col >= h.start && col < h.end) : undefined;
      if (!space || from < 0 || !own || !hit || hit.index === from) return;
      // Only once the pointer is over where the dragged tab would be after
      // the swap: a wider neighbour isn't swapped straight back.
      const w = own.end - own.start;
      if (hit.index > from ? col < hit.end - w : col >= hit.start + w) return;
      const active = space.tabs[space.active];
      space.tabs.splice(from, 1);
      space.tabs.splice(hit.index, 0, r.tab);
      // The active tab stays active wherever it is now (another may have been selected mid-drag).
      space.active = Math.max(0, space.tabs.indexOf(active!));
    } else {
      const from = this.spaces.indexOf(r.space);
      const hit = col < this.mainCol() ? this.spaceHits.find((h) => h.row === row) : undefined;
      if (from < 0 || !hit || hit.index === from) return;
      const active = this.spaces[this.activeSpace];
      this.spaces.splice(from, 1);
      this.spaces.splice(hit.index, 0, r.space);
      this.activeSpace = Math.max(0, this.spaces.indexOf(active!));
    }
    this.queueChrome();
  }

  // ---------------------------------------------------------- menus
  //
  // Right-click menus (tabs, spaces, pane headers, pages) and the ≡ menu:
  // every action has a click, and each shows its keys.

  /** Where each page's placeholder images are (tmux): see drawMenu. */
  private phTiles = new Map<Page, (Rect & { index: number })[]>();

  /**
   * The open menu. With placeholders, a placeholder cell carries on from the
   * one to its left: the cells right of the menu (on its rows) are written
   * again, each row starting from an explicit column.
   */
  private drawMenu(): string {
    const m = this.menu!;
    let s = m.draw(MENU_STYLE);
    if (!this.placeholders) return s;
    const right = m.rect.col + m.rect.cols;
    for (const page of this.geom.keys()) {
      for (const t of this.phTiles.get(page) ?? []) {
        if (right <= t.col || right >= t.col + t.cols) continue;
        const colour = this.phColour(t.index);
        for (let row = Math.max(t.row, m.rect.row); row < Math.min(t.row + t.rows, m.rect.row + m.rect.rows); row++) {
          s += placeholderSpan(this.phHigh, colour, this.phRgb, row, right, row - t.row, right - t.col, t.col + t.cols - right);
        }
      }
    }
    return s;
  }

  private openMenu(
    entries: MenuEntry[],
    point: { col: number; row: number },
    opts: { title?: string; align?: "left" | "right"; bounds?: Rect } = {},
  ): void {
    if (!this.attached || this.covered()) return;
    if (this.mode !== "normal") this.setMode("normal");
    this.menu = new Menu(entries, point, opts.bounds ?? { col: 1, row: 1, cols: this.cols, rows: this.rows }, opts);
    this.menuTab = this.tab;
    // Pages under it are drawn around it from now on.
    this.fullRedraw();
  }

  private closeMenu(): void {
    if (!this.menu) return;
    this.menu = null;
    this.fullRedraw();
  }

  private menuMouse(ev: MouseEvent, col: number, row: number): void {
    const m = this.menu!;
    if (ev.action === "move") {
      const i = m.hit(col, row);
      if (i !== m.active && m.contains(col, row)) {
        m.active = i;
        this.queueChrome();
      }
    } else if (ev.action === "wheel") {
      m.scroll(ev.wheel === "up" ? -1 : ev.wheel === "down" ? 1 : 0);
      this.queueChrome();
    } else if (ev.action === "press") {
      // A click outside only closes the menu.
      const item = m.item(m.hit(col, row));
      if (item) this.runMenuItem(item.run);
      else if (!m.contains(col, row)) this.closeMenu();
    }
  }

  /** Arrows, Enter and Escape work the menu; any other key closes it and does what it does. */
  private menuKey(ev: KeyEvent, combo: string): void {
    const r = this.menu!.key(combo);
    if (r === "handled") return this.queueChrome();
    if (r && r !== "close") return this.runMenuItem(r.run.run);
    this.closeMenu();
    if (r === null) this.onKey(ev);
  }

  private runMenuItem(run: () => void): void {
    this.closeMenu();
    run();
    this.queueChrome();
  }

  /** What Ctrl+B then `combo` does, from a button or menu. */
  private chromeAction(combo: string): void {
    if (this.mode !== "normal") this.setMode("normal");
    this.prefixAction(combo, CTRL_B);
    this.queueChrome();
  }

  /** What the shortcut `combo` does, from a button or menu. */
  private shortcutAction(combo: string): void {
    if (this.mode !== "normal") this.setMode("normal");
    this.globalShortcut(combo);
    this.queueChrome();
  }

  /** The ≡ menu: every action in the keys help, with its keys. */
  private openMainMenu(rightCol: number): void {
    const tab = this.tab;
    const multi = !!tab && leaves(tab.root).length > 1;
    const page = this.focused;
    const key = (label: string, keys: string, combo: string, disabled = false): MenuEntry =>
      ({ label, key: keys, disabled, run: () => this.shortcutAction(combo) });
    const prefix = (label: string, keys: string, combo: string, disabled = false): MenuEntry =>
      ({ label, key: keys, disabled, run: () => this.chromeAction(combo) });
    this.openMenu([
      key("Edit address", "Ctrl+L", "ctrl+l", !page),
      key("Back", "Alt+←", "alt+arrowleft", !page),
      key("Forward", "Alt+→", "alt+arrowright", !page),
      key("Reload", "Ctrl+R", "ctrl+r", !page),
      key("Hard reload", "Ctrl+Shift+R", "ctrl+shift+r", !page),
      { label: "Copy selection", key: "Ctrl+C", disabled: !page, run: () => page && void this.copySelection(page) },
      { label: "Copy page address", disabled: !page, run: () => page && this.copyText(page.url, "address") },
      "-",
      key("New tab", "Ctrl+T", "ctrl+t"),
      prefix("Next tab", "^B n", "n"),
      prefix("Previous tab", "^B p", "p"),
      prefix("Close tab", "^B X", "shift+x", !tab),
      "-",
      prefix("Split right", "^B v", "v", !page),
      prefix("Split down", "^B -", "-", !page),
      prefix(tab?.zoomed ? "Unzoom pane" : "Zoom pane", "^B z", "z", !multi),
      prefix("Resize panes", "^B r", "r", !multi),
      key("Close pane", "Ctrl+W", "ctrl+w", !page),
      "-",
      key("Zoom in", "Alt+=", "alt+="),
      key("Zoom out", "Alt+-", "alt+-"),
      key("Actual size", "Alt+0", "alt+0"),
      "-",
      prefix("Spaces…", "^B w", "w"),
      prefix("New space", "^B N", "shift+n"),
      prefix("Rename space", "^B W", "shift+w"),
      prefix("Close space", "^B D", "shift+d"),
      prefix(this.sidebar ? "Hide sidebar" : "Show sidebar", "^B b", "b"),
      "-",
      prefix("Send Ctrl+B to the page", "^B ^B", "ctrl+b", !page),
      prefix("Update termium", "^B U", "shift+u"),
      prefix("Keyboard shortcuts", "^B ?", "?"),
      prefix("Detach", "^B d", "d"),
      key("Quit", "Ctrl+Q", "ctrl+q"),
    ], { col: rightCol, row: 3 }, { align: "right", title: "termium" });
  }

  /** Right-click on a tab (it's selected first, as what its actions act on). */
  private tabMenu(i: number, col: number): void {
    const space = this.space;
    const tab = space?.tabs[i];
    if (!space || !tab) return;
    this.selectTab(i);
    // The tab may be gone by the time an item is chosen (closed by an agent, its page crashed...).
    const live = (run: () => void) => () => {
      if (this.locateTab(tab)) run();
    };
    const url = tab.focused.url.includes(MARKER) ? undefined : tab.focused.url;
    this.openMenu([
      { label: "Reload", key: "Ctrl+R", run: live(() => this.reload(tab.focused)) },
      { label: "Duplicate", run: live(() => this.newTab(url)) },
      { label: "New tab", key: "Ctrl+T", run: () => this.newTab() },
      "-",
      { label: "Split right", key: "^B v", run: live(() => this.chromeAction("v")) },
      { label: "Split down", key: "^B -", run: live(() => this.chromeAction("-")) },
      "-",
      ...this.spaces.filter((s) => s !== space).map((s): MenuEntry => ({ label: `Move to ${s.name}`, run: live(() => this.moveTab(tab, s)) })),
      { label: "Move to a new space", disabled: space.tabs.length < 2, run: live(() => this.moveTab(tab, null)) },
      "-",
      { label: "Close tab", key: "^B X", run: live(() => this.closeTab(tab)) },
      {
        label: "Close other tabs",
        disabled: space.tabs.length < 2,
        run: live(() => void this.closeGroup(space.tabs.filter((t) => t !== tab).flatMap((t) => leaves(t.root)), "space")),
      },
    ], { col, row: 2 }, { title: truncate(pageTitle(tab.focused), 30) });
  }

  /** Right-click on a space in the sidebar (it's switched to first). */
  private spaceMenu(i: number, col: number, row: number): void {
    if (this.mode === "spaces") this.setMode("normal");
    this.switchSpace(i);
    this.openMenu([
      { label: "New tab", key: "Ctrl+T", run: () => this.newTab() },
      { label: "Rename space", key: "^B W", run: () => this.chromeAction("shift+w") },
      { label: "Close space", key: "^B D", run: () => this.chromeAction("shift+d") },
      "-",
      { label: "New space", key: "^B N", run: () => this.chromeAction("shift+n") },
    ], { col, row: row + 1 }, { title: this.spaces[i]?.name });
  }

  /** Right-click on a pane's header. */
  private paneMenu(page: Page, col: number, row: number): void {
    this.focusPage(page);
    const tab = this.tab;
    // On its pane, whichever pane has focus by then (an agent may have moved it).
    const live = (run: () => void) => () => {
      if (!this.pages.has(page.sessionId) || !this.tab || !leaves(this.tab.root).includes(page)) return;
      this.focusPage(page);
      run();
    };
    this.openMenu([
      { label: "Split right", key: "^B v", run: live(() => this.chromeAction("v")) },
      { label: "Split down", key: "^B -", run: live(() => this.chromeAction("-")) },
      { label: tab?.zoomed ? "Unzoom pane" : "Zoom pane", key: "^B z", run: live(() => this.chromeAction("z")) },
      "-",
      { label: "Close pane", key: "Ctrl+W", run: live(() => this.closePage(page)) },
    ], { col, row: row + 1 }, { title: truncate(pageTitle(page), 30) });
  }

  private menuSeq = 0;

  /**
   * After a right-click reached a page: unless the page showed its own menu
   * (it cancelled `contextmenu`), termium shows one: back, forward, reload,
   * copy (the link, the selection, the address). Every frame is asked
   * (iframes, cross-site ones included); each answer is taken once.
   */
  private async pageMenu(page: Page, released: Promise<unknown>, col: number, row: number): Promise<void> {
    const seq = ++this.menuSeq;
    // (Linux fires contextmenu as the button goes down: from the press on.)
    const pressed = this.lastClick.time - 20;
    const t = this.ticket();
    await released;
    // The probe notes the click once every listener has run (a timer after it).
    await Bun.sleep(40);
    type Info = { at: number; prevented: boolean; link: string; selection: boolean };
    const sessions = [page.sessionId, ...[...this.frameOwner].filter(([, p]) => p === page).map(([sid]) => sid)];
    const ask = async (sid: string): Promise<Info[]> => {
      const frames: string[] = [];
      const walk = (n: any) => {
        frames.push(n.frame.id);
        for (const c of n.childFrames ?? []) walk(c);
      };
      walk((await this.cdp.send("Page.getFrameTree", {}, sid)).frameTree);
      return Promise.all(frames.map(async (frameId) => {
        // The world the probe runs in (same name: the same world, not a new one).
        const { executionContextId } = await this.cdp.send("Page.createIsolatedWorld", { frameId, worldName: "termium" }, sid);
        const r = await this.cdp.send("Runtime.evaluate", {
          expression: "window.__termiumContext ? window.__termiumContext() : null",
          contextId: executionContextId,
          returnByValue: true,
        }, sid);
        return r?.result?.value as Info;
      }).map((p) => p.catch(() => null))).then((all) => all.filter((i): i is Info => !!i));
    };
    const found = (await Promise.all(sessions.map((sid) => ask(sid).catch(() => [])))).flat();
    // Older answers (a right-click termium didn't send, an agent's) aren't about this one.
    const info = found.filter((i) => i.at >= pressed).sort((a, b) => b.at - a.at)[0];
    if (!info || info.prevented || seq !== this.menuSeq || !t.valid() || this.menu || this.focused !== page || this.mouseButtons) return;
    const live = (run: () => void) => () => {
      if (this.pages.has(page.sessionId)) run();
    };
    const link = info.link;
    this.openMenu([
      { label: "Back", key: "Alt+←", run: live(() => void this.history(page, -1)) },
      { label: "Forward", key: "Alt+→", run: live(() => void this.history(page, 1)) },
      { label: "Reload", key: "Ctrl+R", run: live(() => this.reload(page)) },
      "-",
      ...(link
        ? [
            { label: "Open link in new tab", run: live(() => this.newTab(link)) },
            { label: "Copy link address", run: live(() => this.copyText(link, "link")) },
          ]
        : []),
      ...(info.selection ? [{ label: "Copy", key: "Ctrl+C", run: live(() => void this.copySelection(page)) }] : []),
      { label: "Copy page address", run: live(() => this.copyText(page.url, "address")) },
    ], { col, row });
  }

  /** Right-click on ← or →: the tab's earlier (or later) pages, nearest first; a row goes straight there. */
  private async historyMenu(page: Page, dir: -1 | 1, col: number): Promise<void> {
    const seq = ++this.menuSeq;
    const t = this.ticket();
    let h: { currentIndex: number; entries: HistoryEntry[] };
    try {
      h = await this.cdp.send("Page.getNavigationHistory", {}, page.sessionId);
    } catch (e) {
      return this.opts.log(`history: ${e}`);
    }
    if (seq !== this.menuSeq || !t.valid() || this.menu || this.focused !== page || !this.pages.has(page.sessionId)) return;
    // (A menu needs a title, a row and a bottom line: a shorter terminal has no room for one.)
    if (this.rows < 3) return;
    // The history may have changed since it was read (a pushState drops the forward entries): looked up again.
    // (An entry keeps its id through replaceState: its address must match too.)
    const go = (entryId: number, url: string) => async () => {
      if (!this.pages.has(page.sessionId)) return;
      try {
        const now = await this.cdp.send("Page.getNavigationHistory", {}, page.sessionId);
        const i = now.entries.findIndex((e: HistoryEntry) => e.id === entryId && e.url === url);
        if (i < 0) return this.showToast("That page is no longer in this tab's history");
        if (i !== now.currentIndex) await this.cdp.send("Page.navigateToHistoryEntry", { entryId }, page.sessionId);
      } catch (e) {
        this.opts.log(`history: ${e}`);
      }
    };
    const rows = historyRows(h.entries, h.currentIndex, dir);
    this.openMenu(
      rows.length
        ? rows.map((r): MenuEntry => ({ label: truncate(r.title, 40), key: r.host ? truncate(r.host, 30) : undefined, run: go(r.id, r.url) }))
        : [{ label: dir < 0 ? "No earlier pages" : "No later pages", disabled: true, run: () => {} }],
      { col, row: TOP_ROWS + 1 },
      // Under the address bar: a long history scrolls rather than covering the bars (and their buttons).
      // (A terminal too short for a menu there: the whole screen, as other menus.)
      {
        title: dir < 0 ? "Back" : "Forward",
        bounds: this.rows - TOP_ROWS >= 3 ? { col: 1, row: TOP_ROWS + 1, cols: this.cols, rows: this.rows - TOP_ROWS } : undefined,
      },
    );
  }

  private copyText(text: string, what: string): void {
    out(setClipboard(text));
    this.showToast(`Copied ${what}`, 1500);
  }

  /** Moves a tab to another space (null: a new one), and goes there. */
  private moveTab(tab: Tab, to: Space | null): void {
    const from = this.locateTab(tab);
    if (!from || from === to) return;
    if (!to) {
      to = this.newSpaceModel();
      this.spaces.push(to);
    }
    const i = from.tabs.indexOf(tab);
    from.tabs.splice(i, 1);
    from.recent = from.recent.filter((t) => t !== tab);
    if (from.active > i) from.active--;
    from.active = Math.max(0, Math.min(from.active, from.tabs.length - 1));
    to.tabs.push(tab);
    to.active = to.tabs.length - 1;
    if (from.tabs.length === 0) this.spaces.splice(this.spaces.indexOf(from), 1);
    this.activeSpace = this.spaces.indexOf(to);
    this.prompt = null;
    this.relayoutAndRedraw();
  }

  /** Scrolls the tab bar by one tab (wheel, ‹ ›), leaving the active tab as it is. */
  private scrollTabs(delta: number): void {
    const n = this.space?.tabs.length ?? 0;
    const { first, last } = this.tabRange;
    if ((delta > 0 && last >= n - 1) || (delta < 0 && first <= 0)) return;
    this.tabScroll = Math.max(0, Math.min(n - 1, first + delta));
    this.tabScrollFor = this.tab ?? null;
    this.queueChrome();
  }

  private tabScrollFor: Tab | null = null;

  private closeTabAt(i: number): void {
    const tab = this.space?.tabs[i];
    if (tab) this.closeTab(tab);
  }

  /** A click on a prompt's button: what Enter (yes) or Escape does. */
  private answerPrompt(yes: boolean): void {
    const p = this.prompt;
    if (p?.kind === "confirm") {
      this.prompt = null;
      if (yes) p.onYes();
      this.syncPrompt();
      this.queueChrome();
    } else if (p?.kind === "dialog") {
      this.answerDialog(p.page, yes, yes && p.page.dialog?.type === "prompt" ? p.edit.text : "");
    }
  }

  private pageMouse(page: Page, ev: MouseEvent, px: number, py: number): void {
    const g = this.geom.get(page);
    if (!g || !page.css) return;
    const devW = g.content.cols * this.cellW;
    const devH = g.content.rows * this.cellH;
    // The page's real size: another DevTools client may hold it at its own (see onFrame).
    const size = page.actual ?? page.css;
    const x = Math.max(0, Math.min(size.w - 1, ((px - (g.content.col - 1) * this.cellW) * size.w) / devW));
    const y = Math.max(0, Math.min(size.h - 1, ((py - (g.content.row - 1) * this.cellH) * size.h) / devH));
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
      this.queueMove(page, () => send({ type: "mouseMoved", x, y, button, buttons: this.mouseButtons, modifiers }));
      // Moving from one page onto another (or onto termium's own UI, below)
      // ends hover on the first, as a mouse leaving a window does.
      if (this.hoverPage && this.hoverPage !== page) this.leaveHover();
      this.hoverPage = page;
      return;
    }
    const name = names[ev.button] ?? "none";
    if (name === "none" || !name) return;
    // A press or release supersedes motion still waiting to be sent.
    this.pendingMoves.delete(page);
    if (ev.action === "press") {
      const now = Date.now();
      if (ev.button === 1 || (ev.button === 0 && ev.mods.ctrl)) {
        // Only a middle (or Ctrl+) click on a link opens its tab in the background.
        const at = { x, y };
        this.cdp
          .send("Runtime.evaluate", {
            expression: `(() => { const e = document.elementFromPoint(${at.x}, ${at.y}); return !!(e && e.closest && e.closest("a[href], area[href]")); })()`,
            returnByValue: true,
          }, sid)
          .then((r) => {
            if (r?.result?.value === true) this.lastMiddlePress = now;
          })
          .catch(() => {});
      }
      const lc = this.lastClick;
      const near = Math.abs(lc.x - px) < this.cellW && Math.abs(lc.y - py) < this.cellH;
      lc.count = now - lc.time < 450 && near && lc.button === ev.button ? Math.min(3, lc.count + 1) : 1;
      Object.assign(lc, { time: now, x: px, y: py, button: ev.button });
      this.mouseButtons |= bits[ev.button] ?? 0;
      this.mouseCapture = page;
      this.mousePressedAt = { page, x, y };
      void send({ type: "mousePressed", x, y, button: name, buttons: this.mouseButtons, clickCount: lc.count, modifiers });
    } else {
      this.mouseButtons &= ~(bits[ev.button] ?? 0);
      if (this.mouseButtons === 0) this.mouseCapture = null;
      const sent = send({ type: "mouseReleased", x, y, button: name, buttons: this.mouseButtons, clickCount: this.lastClick.count, modifiers });
      if (ev.button === 2) void this.pageMenu(page, sent, Math.floor(px / this.cellW) + 1, Math.floor(py / this.cellH) + 1);
    }
  }

  private leaveHover(): void {
    const page = this.hoverPage;
    this.hoverPage = null;
    if (!page || !this.pages.has(page.sessionId)) return;
    this.cdp
      .send("Input.dispatchMouseEvent", { type: "mouseMoved", x: -1, y: -1, button: "none", buttons: 0 }, page.sessionId)
      .catch(() => {});
  }

  /**
   * Coalesces pointer motion per page: at most one move in flight, latest
   * wins. A move that never answers (page closed or hung) stops blocking
   * after a second.
   */
  private queueMove(page: Page, fn: () => Promise<unknown>): void {
    if (this.movesInFlight.has(page)) {
      this.pendingMoves.set(page, fn);
      return;
    }
    this.movesInFlight.add(page);
    Promise.race([fn(), Bun.sleep(1000)]).finally(() => {
      this.movesInFlight.delete(page);
      const next = this.pendingMoves.get(page);
      this.pendingMoves.delete(page);
      if (next && this.pages.has(page.sessionId)) this.queueMove(page, next);
    });
  }

  private movesInFlight = new Set<Page>();
  private pendingMoves = new Map<Page, () => Promise<unknown>>();

  // ---------------------------------------------------------- agents
  //
  // What `termium ctl` uses (src/agent.ts): pages by number, and the same
  // actions the keyboard and mouse have, without a terminal of its own.

  /** The UI is up (the first page exists). */
  get isReady(): boolean {
    return this.ready;
  }

  /** Every page, in the order of spaces, tabs and panes. */
  agentTabs(): AgentTab[] {
    const out: AgentTab[] = [];
    const focused = this.focused;
    this.spaces.forEach((space, si) => {
      space.tabs.forEach((tab, ti) => {
        leaves(tab.root).forEach((page, pi) => {
          out.push({
            id: page.num,
            targetId: page.targetId,
            url: page.url.includes(MARKER) ? "about:blank" : page.url,
            title: page.title.includes(MARKER) ? "" : page.title,
            active: page === focused,
            visible: this.geom.has(page),
            space: si + 1,
            spaceName: space.name,
            tab: ti + 1,
            pane: pi + 1,
            loading: page.loading,
            dialog: page.dialog ? { type: page.dialog.type, message: page.dialog.message } : null,
          });
        });
      });
    });
    return out;
  }

  pageByNum(num: number): Page | undefined {
    for (const page of this.pages.values()) if (page.num === num) return page;
    return undefined;
  }

  /** The page input goes to: the focused pane of the current tab. */
  activePage(): Page | undefined {
    return this.focused;
  }

  /** What the address bar makes of `text`: an address, or a search with the session's engine. */
  resolveUrl(text: string): string | null {
    return toUrl(text, this.opts.search);
  }

  /** Opens `url` in a new tab of the current space (after the current tab), resolving to its page. */
  agentNewTab(url: string, background: boolean): Promise<Page | null> {
    const space = this.space ?? this.spaces[0];
    if (!space) return Promise.resolve(null);
    // A new tab must never take the person's address-bar draft or keystrokes:
    // while they're busy it opens in the background (the caller says so).
    return this.placePage({ kind: "tab", space, index: space.active + 1, editUrl: false, url, background, agent: true });
  }

  /** Navigates a page (a crashed or hung one is replaced, as from the address bar). */
  agentNavigate(page: Page, url: string): void {
    this.go(page, url);
  }

  /** Shows a page: its space, its tab, and focuses its pane. */
  agentSelect(page: Page): boolean {
    const loc = this.locate(page);
    if (!loc) return false;
    this.activeSpace = this.spaces.indexOf(loc.space);
    loc.space.active = loc.space.tabs.indexOf(loc.tab);
    loc.tab.focused = page;
    if (loc.tab.zoomed && !leaves(loc.tab.root).includes(page)) loc.tab.zoomed = false;
    if (this.prompt?.kind === "url" || this.prompt?.kind === "rename") this.prompt = null;
    this.relayoutAndRedraw();
    return true;
  }

  /** Closes a page as Ctrl+W does (its "Leave this page?" may ask), or outright with `force`. */
  /**
   * Closes a page for an agent, never switching the person's tab nor asking
   * them anything: "unsaved" (not closed) if the page may have unsaved
   * changes or shows a dialog, unless `force`, which discards them.
   */
  async agentClose(page: Page, force: boolean, stillOk: () => boolean = () => true): Promise<"closing" | "unsaved" | "stopped"> {
    if (!force && (page.dialog || (await this.wouldAsk(page)))) return "unsaved";
    // The probe takes a moment: the agent's time and the person are checked again right before closing.
    if (!stillOk()) return "stopped";
    page.closing = true;
    page.agentClosing = force ? "force" : "yes";
    if (force && page.dialog) await this.cdp.send("Page.handleJavaScriptDialog", { accept: page.dialog.type === "beforeunload" }, page.dialog.sessionId).catch(() => {});
    this.cdp.send("Target.closeTarget", { targetId: page.targetId }).catch(() => this.onGone(page));
    return "closing";
  }

  isOpen(page: Page): boolean {
    return this.pages.get(page.sessionId) === page;
  }

  /** Answers a page's JavaScript dialog (alert, confirm, prompt, "Leave this page?"). */
  agentDialog(page: Page, accept: boolean, text: string): boolean {
    if (!page.dialog) return false;
    this.answerDialog(page, accept, text);
    return true;
  }

  /**
   * Runs `job` between the page's viewport changes and screenshots (see
   * serial): a screenshot taken while the viewport changes can undo the
   * change. The queue waits for it 15 s at most.
   */
  withPage<T>(page: Page, job: () => Promise<T>): Promise<T> {
    const run = page.ops.then(job);
    page.ops = Promise.race([run.then(() => {}, () => {}), Bun.sleep(15_000)]);
    return run;
  }
}

// ---------------------------------------------------------------- helpers

function isModifier(ev: KeyEvent): boolean {
  return ev.key === "Shift" || ev.key === "Control" || ev.key === "Alt" || ev.key === "Meta";
}

/** "ctrl+shift+r", "alt+arrowleft", "?" (shift dropped for symbols). */
export function comboOf(ev: KeyEvent): string {
  const k = ev.key.toLowerCase();
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

/** A download's suggested name, made safe to use as a file name. */
export function safeFileName(name: string): string {
  const clean = basename(name.replace(/\\/g, "/"))
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/^\.+/, "")
    .trim();
  return clean || "download";
}

/**
 * Claims `name` in `dir`, or "name (1).ext", "name (2).ext", … if taken, by
 * creating it exclusively (O_EXCL), so two downloads (even from two
 * termiums) can never pick the same file. Returns the claimed path.
 */
export function freeName(dir: string, name: string): string {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 0; ; i++) {
    const candidate = join(dir, i === 0 ? name : `${stem} (${i})${ext}`);
    try {
      closeSync(openSync(candidate, "wx"));
      return candidate;
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
    }
  }
}

/**
 * Whether a screencast frame (base64 PNG) has the shape of a viewport of
 * `css` size (frames are that viewport scaled to fit the screencast, each
 * side rounded). Not a PNG: no opinion.
 */
export function frameFits(base64Png: string, css: { w: number; h: number }): boolean {
  const head = Buffer.from(base64Png.slice(0, 44), "base64");
  if (head.length < 24 || head.readUInt32BE(12) !== 0x49484452) return true; // "IHDR"
  const w = head.readUInt32BE(16);
  const h = head.readUInt32BE(20);
  if (!w || !h || !css.w || !css.h) return true;
  // Each side is rounded once scaled, so the other, derived from it, can be
  // off by its ratio to that side, plus a couple of pixels.
  return Math.abs(h - (w * css.h) / css.w) <= 2 + css.h / css.w && Math.abs(w - (h * css.w) / css.h) <= 2 + css.w / css.h;
}

/** A PNG's size in pixels, from its header (null if it isn't one). */
function pngSize(base64Png: string): { w: number; h: number } | null {
  const head = Buffer.from(base64Png.slice(0, 44), "base64");
  if (head.length < 24 || head.readUInt32BE(12) !== 0x49484452) return null; // "IHDR"
  return { w: head.readUInt32BE(16), h: head.readUInt32BE(20) };
}

function sameSize<T extends { w: number; h: number; dsf?: number }>(a: T | null, b: T | null): boolean {
  return !!a && !!b && a.w === b.w && a.h === b.h && a.dsf === b.dsf;
}

function pageTitle(page: Page): string {
  const blank = (s: string) => !s || s.includes(MARKER) || s === "about:blank";
  if (!blank(page.title)) return page.title;
  return blank(page.url) ? "New Tab" : page.url.replace(/^https?:\/\//, "");
}

export interface HistoryEntry {
  id: number;
  url: string;
  title: string;
}

/**
 * The ← / → history dropdown's rows: the entries before (dir -1) or after
 * (dir 1) the current one, nearest first, each with a title and host.
 */
export function historyRows(entries: HistoryEntry[], current: number, dir: -1 | 1): { id: number; url: string; title: string; host: string }[] {
  const blank = (s: string) => !s || s.includes(MARKER) || s === "about:blank";
  const rows: { id: number; url: string; title: string; host: string }[] = [];
  for (let i = current + dir; i >= 0 && i < entries.length; i += dir) {
    const e = entries[i]!;
    const title = !blank(e.title) ? e.title : blank(e.url) ? "New Tab" : e.url.replace(/^https?:\/\//, "");
    rows.push({ id: e.id, url: e.url, title, host: blank(e.url) ? "" : hostOf(e.url) });
  }
  return rows;
}

function displayUrl(page: Page): string {
  if (page.url.includes(MARKER) || page.url === "about:blank") return "";
  return page.url;
}

export { DEFAULT_SEARCH };

/** Words of `text` in lines of at most `w` columns (a longer word is cut). */
export function wrapWords(text: string, w: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let rest = word;
    while (width(rest) > w) {
      if (line) {
        out.push(line);
        line = "";
      }
      out.push(rest.slice(0, w));
      rest = rest.slice(w);
    }
    if (!rest) continue;
    if (!line) line = rest;
    else if (width(line) + 1 + width(rest) <= w) line += " " + rest;
    else {
      out.push(line);
      line = rest;
    }
  }
  if (line) out.push(line);
  return out;
}
