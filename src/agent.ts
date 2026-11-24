// `termium ctl` on the server side: what an agent (Claude Code, Codex, a
// script) asks a session to do, over the session's own DevTools connection.
// It never attaches: the terminal attached to the session (if any) keeps
// its screen and keyboard and shows what the agent does, as it happens.
//
// Pages are named by their number (a "tab" to the agent: one pane of a
// termium tab), elements by "TAB:NODE", where NODE is the element's DOM
// backend node id: stable for as long as the element exists, with no
// state kept in the page.

import type { AgentTab, App, Page } from "./app";
import type { DevToolsEndpoint } from "./browser";
import type { CDP } from "./cdp";
import { decodePng, encodeRegion, type Raster } from "./png";

/** A failure to report to the agent as is; `code` becomes the exit status. */
export class CtlError extends Error {
  constructor(
    message: string,
    readonly code = 1,
  ) {
    super(message);
  }
}

/** Exit statuses of `termium ctl` (also in the skill). */
export const EXIT = { ok: 0, failed: 1, usage: 2, noSession: 3, timeout: 4, partial: 5 } as const;

/** Commands that act on pages or tabs: a session runs these one at a time (see onCtl in server.ts). */
// (Not `dialog`: answering one must work while an `open` waits on the page it blocks.)
export const ACTING = new Set(["open", "select", "close", "click", "type", "key", "scroll"]);

export interface CtlRequest {
  cmd: string;
  /** Page number to act on; the focused page if absent. */
  tab?: number;
  /** Element id "TAB:NODE" (from snapshot). */
  ref?: string;
  url?: string;
  newTab?: boolean;
  background?: boolean;
  wait?: boolean;
  force?: boolean;
  text?: string;
  append?: boolean;
  submit?: boolean;
  keys?: string[];
  xy?: [number, number];
  button?: "left" | "right" | "middle";
  double?: boolean;
  direction?: "up" | "down" | "left" | "right";
  amount?: number;
  full?: boolean;
  expr?: string;
  what?: "load" | "selector" | "text" | "url";
  value?: string;
  gone?: boolean;
  accept?: boolean;
  timeoutMs?: number;
}

interface Ctx {
  devtools: DevToolsEndpoint | null;
  log: (msg: string) => void;
}

const DEFAULT_TIMEOUT = 30_000;

/**
 * Runs one command. An acting one (see ACTING) is never cut off from
 * outside once it has started: it checks its deadline itself before each
 * step that changes anything, and stops there, saying exactly how far it
 * got. A reading one is simply timed out.
 */
export async function runCtl(app: App, cdp: CDP, req: CtlRequest, ctx: Ctx): Promise<unknown> {
  if (!req || typeof req.cmd !== "string") throw new CtlError("bad request", EXIT.usage);
  const timeoutMs = clampTimeout(req.timeoutMs);
  const agent = new Agent(app, cdp, ctx, Date.now() + timeoutMs);
  if (ACTING.has(req.cmd)) return agent.run(req, timeoutMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CtlError(`${req.cmd}: timed out after ${timeoutMs / 1000}s`, EXIT.timeout)), timeoutMs);
  });
  try {
    return await Promise.race([agent.run(req, timeoutMs), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function clampTimeout(ms: unknown): number {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 10 * 60_000) : DEFAULT_TIMEOUT;
}

class Agent {
  constructor(
    private app: App,
    private cdp: CDP,
    private ctx: Ctx,
    /** When the command's time is up (checked before each step that changes anything). */
    private deadline: number,
  ) {}

  /**
   * Waits for an input action, unless the page opens a dialog meanwhile (an
   * alert from a click, say): the browser then holds the action until the
   * dialog is answered, so this returns at once with the dialog (the action
   * completes in the browser once it's answered).
   */
  private async untilDialog(page: Page, action: Promise<unknown>): Promise<{ type: string; message: string } | null> {
    let stop = false;
    const dialog = (async () => {
      while (!stop) {
        if (page.dialog) return { type: page.dialog.type, message: page.dialog.message };
        await Bun.sleep(30);
      }
      return null;
    })();
    try {
      const done = action.then(() => null);
      done.catch(() => {}); // (settled after a dialog: nobody waits on it then)
      return await Promise.race([done, dialog]);
    } finally {
      stop = true;
    }
  }

  /** Element ids the snapshot being made hands out. */
  private issued = new Set<number>();

  /** Before a step that changes something: past the deadline, stop here, saying what was (not) done. */
  private step(soFar = "nothing was done"): void {
    if (Date.now() >= this.deadline) throw new CtlError(`timed out; ${soFar}`, EXIT.timeout);
  }

  async run(req: CtlRequest, timeoutMs: number): Promise<unknown> {
    switch (req.cmd) {
      case "tabs":
        return this.app.agentTabs();
      case "devtools":
        if (!this.ctx.devtools) throw new CtlError("this session's browser has no DevTools port (see browser.log)");
        return {
          port: this.ctx.devtools.port,
          browserURL: `http://127.0.0.1:${this.ctx.devtools.port}`,
          webSocketDebuggerUrl: `ws://127.0.0.1:${this.ctx.devtools.port}${this.ctx.devtools.path}`,
        };
      case "ready":
        return { tabs: this.app.agentTabs().length };
      case "open":
        return this.open(req, timeoutMs);
      case "select": {
        const page = this.page(req.tab, true);
        const waited = await this.personFree(null, timeoutMs, "tab not switched");
        if (!this.app.isOpen(page)) throw new CtlError(`tab ${page.num} closed`);
        this.step("tab not switched");
        this.app.agentSelect(page);
        this.note(`showing tab ${page.num}`);
        return waited > 150 ? { ...this.describe(page), waitedForPerson: waited } : this.describe(page);
      }
      case "close":
        return this.close(req);
      case "snapshot":
        return this.snapshot(this.page(req.tab));
      case "text":
        return this.text(this.page(req.tab));
      case "click":
        return this.click(req);
      case "type":
        return this.type(req);
      case "key":
        return this.key(req);
      case "scroll":
        return this.scroll(req);
      case "shot":
        return this.shot(this.page(req.tab), !!req.full);
      case "eval":
        return this.evaluate(this.page(req.tab), String(req.expr ?? ""));
      case "wait":
        return this.wait(req, timeoutMs);
      case "dialog":
        return this.dialog(req);
      default:
        throw new CtlError(`unknown command "${req.cmd}"`, EXIT.usage);
    }
  }

  // ------------------------------------------------------------ the person

  /**
   * The one guard for anything an agent does that changes what the person
   * sees or where their keys go: while they're busy (editing the address,
   * a prompt, a dialog, help or the update box, or typing: busy for a
   * moment after each key), it waits, up to the command's timeout (then
   * exit 4, nothing done). With `page`, only if that's the page they're on.
   * Returns how long it waited.
   */
  private async personFree(page: Page | null, timeoutMs: number, what: string, dialogOf?: Page): Promise<number> {
    const t0 = Date.now();
    const deadline = Math.min(this.deadline, t0 + timeoutMs);
    while (this.app.humanBusy(dialogOf) && (!page || page === this.app.activePage())) {
      if (Date.now() > deadline) {
        throw new CtlError(
          `the person at the terminal is busy (typing, or editing the address, a prompt or help); ${what}. ` +
            "Try again, or act on another tab with --tab N",
          EXIT.timeout,
        );
      }
      await Bun.sleep(100);
    }
    return Date.now() - t0;
  }

  // ------------------------------------------------------------ pages

  private page(tab: number | undefined, dialogOk = false): Page {
    let page: Page | undefined;
    if (tab === undefined) {
      page = this.app.activePage();
      if (!page) throw new CtlError("no page is open");
    } else {
      page = this.app.pageByNum(tab);
      if (!page) throw new CtlError(`no tab ${tab} (\`termium ctl tabs\` lists them)`);
    }
    if (!dialogOk && page.dialog) {
      throw new CtlError(
        `tab ${page.num} is showing a ${page.dialog.type} dialog ("${clip(page.dialog.message, 80)}"); ` +
          "answer it first: termium ctl dialog accept|dismiss",
      );
    }
    return page;
  }

  private describe(page: Page): AgentTab {
    const t = this.app.agentTabs().find((t) => t.id === page.num);
    if (!t) throw new CtlError(`tab ${page.num} closed`);
    return t;
  }

  /** Shows what the agent did in termium's status line, for whoever is watching. */
  private note(what: string): void {
    this.app.showToast(`agent: ${clip(what, 70)}`, 2500);
  }

  /** The element an id names: its page and backend node id. */
  private element(ref: string | undefined): { page: Page; node: number } {
    const m = /^(\d+):(\d+)$/.exec(ref ?? "");
    if (!m) throw new CtlError(`bad element id "${ref ?? ""}": ids look like 3:142 (take them from \`termium ctl snapshot\`)`, EXIT.usage);
    const page = this.page(Number(m[1]));
    const node = Number(m[2]);
    // Only ids a snapshot of the page's current document gave: node numbers are
    // reused by a new document, where the same id would mean another element.
    const ids = page.agentIds;
    if (!ids || ids.gen !== (page.docGen ?? 0) || !ids.nodes.has(node)) {
      throw new CtlError(`stale id ${ref}: the page changed since that snapshot; take a new snapshot`);
    }
    return { page, node };
  }

  private async open(req: CtlRequest, timeoutMs: number): Promise<unknown> {
    const url = this.app.resolveUrl(String(req.url ?? ""));
    if (!url) throw new CtlError("open needs a URL", EXIT.usage);
    let page: Page;
    // A new tab asked for in front opens behind while the person is busy (it never takes their keys).
    let held = false;
    if (req.newTab) {
      this.step("no tab opened");
      const created = await this.app.agentNewTab(url, !!req.background);
      if (!created) throw new CtlError("couldn't open a tab");
      page = created;
      held = !req.background && this.app.activePage() !== page;
      // (The address is what's cut short, never what follows it.)
      this.note(`opened ${clip(url, held ? 25 : 50)} in tab ${page.num}${held ? " (behind: you're busy)" : ""}`);
    } else {
      page = this.page(req.tab);
      await this.personFree(page, timeoutMs, "not navigated");
      this.step("not navigated");
      this.app.agentNavigate(page, url);
      this.note(`going to ${url}`);
    }
    if (req.wait !== false) await this.waitLoad(page, Date.now() + timeoutMs - 500, true);
    const t: Record<string, unknown> = { ...this.describe(page) };
    if (held) t.background = "the person at the terminal was busy: opened in the background, not shown";
    // The page stopped on a dialog (alert in its load): said at once; the page can't be asked anything until it's answered.
    if (page.dialog) {
      this.note(`tab ${page.num} shows a ${page.dialog.type} dialog`);
      return { ...t, dialog: { type: page.dialog.type, message: page.dialog.message } };
    }
    if (/^chrome-error:/.test(await this.evalValue(page, "location.href").catch(() => ""))) {
      throw new CtlError(`tab ${page.num}: couldn't load ${url} (${t.title || "error page"})`);
    }
    return t;
  }

  private async close(req: CtlRequest): Promise<unknown> {
    const page = this.page(req.tab, true);
    await this.personFree(page, Number(req.timeoutMs) || DEFAULT_TIMEOUT, "not closed");
    const t = this.describe(page);
    const unsaved = () =>
      new CtlError(
        `tab ${page.num} may have unsaved changes (it would ask "Leave this page?"); not closed. ` +
          "close --force discards them",
      );
    this.step("not closed");
    const how = await this.app.agentClose(
      page,
      !!req.force,
      () => Date.now() < this.deadline && !(this.app.humanBusy() && page === this.app.activePage()),
    );
    if (how === "unsaved") throw unsaved();
    if (how === "stopped") {
      throw new CtlError(
        Date.now() >= this.deadline ? "timed out; not closed" : "the person at the terminal got busy on that tab; not closed",
        EXIT.timeout,
      );
    }
    this.note(`closing tab ${page.num}`);
    const end = Date.now() + 5000;
    while (this.app.isOpen(page) && Date.now() < end) {
      if (page.agentClosing === "refused") {
        page.closing = false;
        page.agentClosing = undefined;
        throw unsaved();
      }
      await Bun.sleep(50);
    }
    if (this.app.isOpen(page)) throw new CtlError(`tab ${page.num} didn't close`);
    return t;
  }


  private async dialog(req: CtlRequest): Promise<unknown> {
    let page: Page | undefined;
    if (req.tab !== undefined) page = this.page(req.tab, true);
    else page = this.app.activePage()?.dialog ? this.app.activePage() : [...this.app.pages.values()].find((p) => p.dialog);
    if (!page?.dialog) throw new CtlError(req.tab !== undefined ? `tab ${req.tab} has no dialog open` : "no page has a dialog open");
    // The person may be answering it themselves (typing into a prompt()): wait for them.
    await this.personFree(page, Number(req.timeoutMs) || DEFAULT_TIMEOUT, "not answered", page);
    const d = page.dialog;
    if (!d) return { tab: page.num, answered: "already (by the person)" };
    this.app.agentDialog(page, !!req.accept, req.text ?? d.defaultPrompt);
    this.note(`${req.accept ? "accepted" : "dismissed"} a ${d.type} dialog`);
    return { tab: page.num, type: d.type, message: d.message, accepted: !!req.accept };
  }

  // ------------------------------------------------------------ reading

  private async evalValue(page: Page, expression: string, sid = page.sessionId): Promise<any> {
    const r = await this.cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sid);
    if (r?.exceptionDetails) throw new CtlError(exceptionText(r.exceptionDetails));
    return r?.result?.value;
  }

  private async evaluate(page: Page, expression: string): Promise<unknown> {
    if (!expression) throw new CtlError("eval needs an expression", EXIT.usage);
    const sid = page.sessionId;
    const objectGroup = "termium-ctl";
    const failed = (r: any) => {
      if (r?.exceptionDetails) throw new CtlError(`tab ${page.num}: ${exceptionText(r.exceptionDetails)}`);
    };
    try {
      // As typed into the console (top-level await works); a promise it gives is awaited too.
      let r = await this.cdp.send("Runtime.evaluate", { expression, objectGroup, awaitPromise: true, userGesture: true, replMode: true }, sid);
      failed(r);
      let res = r?.result ?? {};
      if (res.subtype === "promise" && res.objectId) {
        r = await this.cdp.send("Runtime.awaitPromise", { promiseObjectId: res.objectId, returnByValue: false }, sid);
        failed(r);
        res = r?.result ?? {};
      }
      if (res.objectId && !["function", "symbol"].includes(res.type) && res.subtype !== "node") {
        const v = await this.cdp
          .send("Runtime.callFunctionOn", { objectId: res.objectId, functionDeclaration: "function () { return this; }", returnByValue: true }, sid)
          .catch(() => null);
        if (v?.result && "value" in v.result) res = { ...res, value: v.result.value };
      }
      // Values that aren't JSON (functions, DOM nodes, symbols...) come as their description.
      const value = "value" in res ? res.value : res.type === "undefined" ? null : (res.unserializableValue ?? res.description ?? null);
      return { tab: page.num, type: res.subtype ?? res.type, value };
    } finally {
      this.cdp.send("Runtime.releaseObjectGroup", { objectGroup }, sid).catch(() => {});
    }
  }

  private async text(page: Page): Promise<unknown> {
    const text = await this.evalValue(
      page,
      `(() => { const b = document.body || document.documentElement; return b ? b.innerText : ""; })()`,
    );
    const t = this.describe(page);
    return { tab: page.num, url: t.url, title: t.title, text: String(text ?? "") };
  }

  /**
   * The page's accessibility tree, as text: one line per element worth
   * acting on or reading, indented by nesting, each with its id.
   */
  private async snapshot(page: Page): Promise<unknown> {
    const sid = page.sessionId;
    const lines: string[] = [];
    const gen = page.docGen ?? 0;
    const tree = await this.cdp.send("Accessibility.getFullAXTree", {}, sid);
    this.issued = new Set();
    await this.render(page, tree.nodes ?? [], lines, 0, 0);
    // The ids handed out, for this document (a snapshot of it again adds to them).
    if (page.agentIds?.gen === gen) for (const n of this.issued) page.agentIds.nodes.add(n);
    else page.agentIds = { gen, nodes: this.issued };
    const t = this.describe(page);
    return { tab: page.num, url: t.url, title: t.title, snapshot: lines.join("\n") };
  }

  private async render(page: Page, nodes: any[], lines: string[], depth: number, frameDepth: number): Promise<void> {
    const byId = new Map<string, any>(nodes.map((n) => [n.nodeId, n]));
    const root = nodes.find((n) => !n.parentId) ?? nodes[0];
    if (!root) return;
    const walk = async (n: any, depth: number, parentName: string): Promise<void> => {
      if (lines.length >= MAX_LINES) return;
      const role: string = n.role?.value ?? "";
      const name = String(n.name?.value ?? "").replace(/\s+/g, " ").trim();
      const kids = (n.childIds ?? []).map((id: string) => byId.get(id)).filter(Boolean);
      const props = new Map<string, any>((n.properties ?? []).map((p: any) => [p.name, p.value?.value]));
      const descend = async (d: number, pn: string) => {
        for (const k of kids) await walk(k, d, pn);
      };
      if (role === "InlineTextBox") return;
      if (n.ignored || role === "RootWebArea" || ((SKIP_ROLES.has(role) || !role) && !name)) {
        if (role === "RootWebArea" && depth > 0) lines.push(`${"  ".repeat(depth)}- document "${clip(name, 100)}"`);
        return descend(role === "RootWebArea" && depth > 0 ? depth + 1 : depth, parentName);
      }
      const pad = "  ".repeat(depth);
      if (role === "StaticText") {
        // Text already given as its parent's name adds nothing.
        if (name && name !== parentName) lines.push(`${pad}- text: ${clip(name, 300)}`);
        return;
      }
      let line = `${pad}- ${role}`;
      if (name) line += ` "${clip(name, 200)}"`;
      if (n.backendDOMNodeId) {
        line += ` [${page.num}:${n.backendDOMNodeId}]`;
        this.issued.add(n.backendDOMNodeId);
      }
      const value = n.value?.value;
      if (value !== undefined && value !== "" && VALUE_ROLES.has(role)) line += ` value="${clip(String(value), 200)}"`;
      for (const [p, v] of props) {
        if (FLAG_PROPS.has(p) && v === true) line += ` ${p}`;
        else if (p === "checked" || p === "pressed") line += v === "true" || v === true ? ` ${p}` : v === "mixed" ? ` ${p}=mixed` : "";
        else if (p === "expanded") line += ` expanded=${v}`;
        else if (p === "level") line += ` level=${v}`;
        else if (p === "url" && role === "link" && v) line += ` -> ${clip(String(v), 120)}`;
      }
      lines.push(line);
      if (role === "Iframe" && n.backendDOMNodeId && frameDepth < 3) {
        // Same-process frames are read here; a cross-site frame (its own process) can't be.
        const inner = await this.frameTree(page, n.backendDOMNodeId);
        if (inner) await this.render(page, inner, lines, depth + 1, frameDepth + 1);
        else lines.push(`${pad}  - (cross-site frame: not included; use the DevTools endpoint)`);
        return;
      }
      // Leaf text inside a named element is its name already.
      await descend(depth + 1, name);
    };
    await walk(root, depth, "");
    if (lines.length >= MAX_LINES && depth === 0) lines.push(`- … (cut at ${MAX_LINES} lines)`);
  }

  private async frameTree(page: Page, backendNodeId: number): Promise<any[] | null> {
    try {
      const { node } = await this.cdp.send("DOM.describeNode", { backendNodeId }, page.sessionId);
      if (!node?.frameId) return null;
      const r = await this.cdp.send("Accessibility.getFullAXTree", { frameId: node.frameId }, page.sessionId);
      return r?.nodes?.length ? r.nodes : null;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------ acting

  /** The middle of an element's box (scrolled into view first), in CSS pixels of the page's viewport. */
  private async centre(page: Page, node: number): Promise<{ x: number; y: number }> {
    const sid = page.sessionId;
    const gone = (e: unknown) => {
      if (/No node|Could not find node|not found/i.test(String(e))) {
        throw new CtlError(`element ${page.num}:${node} is gone (the page changed); take a new snapshot`);
      }
      throw e;
    };
    await this.cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: node }, sid).catch(gone);
    const { quads } = await this.cdp.send("DOM.getContentQuads", { backendNodeId: node }, sid).catch(gone);
    const q = (quads as number[][] | undefined)?.find((q) => area(q) > 1);
    if (!q) throw new CtlError(`element ${page.num}:${node} has no box on the page (hidden?)`);
    return { x: (q[0]! + q[2]! + q[4]! + q[6]!) / 4, y: (q[1]! + q[3]! + q[5]! + q[7]!) / 4 };
  }

  private async objectOf(page: Page, node: number): Promise<string> {
    try {
      const { object } = await this.cdp.send("DOM.resolveNode", { backendNodeId: node }, page.sessionId);
      return object.objectId;
    } catch {
      throw new CtlError(`element ${page.num}:${node} is gone (the page changed); take a new snapshot`);
    }
  }

  /** Calls `fn` on an element; its arguments (text to type, say) are never traced. */
  private async callOn(page: Page, objectId: string, fn: string, args: unknown[] = []): Promise<any> {
    const r = await this.cdp.send(
      "Runtime.callFunctionOn",
      { objectId, functionDeclaration: fn, arguments: args.map((value) => ({ value })), returnByValue: true, awaitPromise: true },
      page.sessionId,
      { secret: args.length > 0 },
    );
    if (r?.exceptionDetails) throw new CtlError(exceptionText(r.exceptionDetails));
    return r?.result?.value;
  }

  /**
   * Clicks (count times). The deadline is checked before each press: a page
   * slow to take the pointer (a heavy mousemove handler) stops it there; a
   * press is always followed by its release, so no button is left held.
   */
  private async mouseClick(page: Page, x: number, y: number, button: "left" | "right" | "middle", count: number): Promise<void> {
    const sid = page.sessionId;
    const bit = button === "left" ? 1 : button === "right" ? 2 : 4;
    const send = (p: object) => this.cdp.send("Input.dispatchMouseEvent", p, sid);
    await send({ type: "mouseMoved", x, y, button: "none", buttons: 0 });
    for (let i = 1; i <= count; i++) {
      this.step(i === 1 ? "not clicked (the page was slow to take the pointer)" : `clicked ${i - 1} of ${count} times`);
      await send({ type: "mousePressed", x, y, button, buttons: bit, clickCount: i });
      await send({ type: "mouseReleased", x, y, button, buttons: 0, clickCount: i });
    }
  }


  private async click(req: CtlRequest): Promise<unknown> {
    const button = req.button ?? "left";
    const count = req.double ? 2 : 1;
    if (req.xy) {
      const page = this.page(req.tab);
      await this.personFree(page, Number(req.timeoutMs) || DEFAULT_TIMEOUT, "not clicked");
      const [x, y] = req.xy;
      this.step("not clicked");
      const dialog = await this.untilDialog(page, this.mouseClick(page, x, y, button, count));
      this.note(`clicked at ${Math.round(x)},${Math.round(y)}`);
      return { tab: page.num, x, y, ...(dialog ? { dialog } : {}) };
    }
    const { page, node } = this.element(req.ref);
    await this.personFree(page, Number(req.timeoutMs) || DEFAULT_TIMEOUT, "not clicked");
    this.step("not clicked");
    const { x, y } = await this.centre(page, node);
    // Something else on top (a cookie banner, an overlay, also one over the
    // frame the element is in) would take the click: then nothing is clicked,
    // and the agent is told what covers it.
    const objectId = await this.objectOf(page, node);
    const cover = await this.coverAt(page, node, objectId, x, y);
    if (cover) throw new CtlError(`element ${req.ref} is covered by ${cover} at its centre; not clicked (click that, or --xy)`);
    this.step("not clicked");
    const dialog = await this.untilDialog(page, this.mouseClick(page, x, y, button, count));
    // (The page is held by its dialog: it can't be asked for the element's name.)
    const label = dialog ? "an element" : await this.label(page, objectId);
    this.note(`clicked ${label}`);
    return { tab: page.num, ref: req.ref, x: Math.round(x), y: Math.round(y), ...(dialog ? { dialog } : {}) };
  }

  /**
   * What the mouse would hit at (x, y) (the page's viewport, CSS px) if not
   * the element or something inside it: looked up from the top document
   * down through (same-origin) frames, as the browser routes a click. Null
   * if it's the element; a description of the cover otherwise.
   */
  private async coverAt(page: Page, node: number, objectId: string, x: number, y: number): Promise<string | null> {
    const sid = page.sessionId;
    const r = await this.cdp
      .send(
        "Runtime.evaluate",
        {
          expression: `(() => {
            let x = ${x}, y = ${y};
            let e = document.elementFromPoint(x, y);
            for (let i = 0; e && i < 32; i++) {
              if (e.shadowRoot) {
                const inner = e.shadowRoot.elementFromPoint(x, y);
                if (inner && inner !== e) { e = inner; continue; }
              }
              if (e.tagName === "IFRAME" || e.tagName === "FRAME") {
                let d = null;
                try { d = e.contentDocument; } catch {}
                if (!d) break;
                const b = e.getBoundingClientRect();
                x -= b.left + e.clientLeft;
                y -= b.top + e.clientTop;
                const inner = d.elementFromPoint(x, y);
                if (!inner) break;
                e = inner;
                continue;
              }
              break;
            }
            return e;
          })()`,
        },
        sid,
      )
      .catch(() => null);
    const hitObject = r?.result?.objectId;
    if (!hitObject) return null; // nothing there to say: the click goes ahead as aimed
    try {
      const { node: hit } = await this.cdp.send("DOM.describeNode", { objectId: hitObject }, sid);
      if (hit.backendNodeId === node) return null;
      // A frame that couldn't be looked into (another origin): taken as the element's own.
      if ((hit.nodeName === "IFRAME" || hit.nodeName === "FRAME") && (await this.inFrame(page, objectId, hit.backendNodeId))) return null;
      // Inside the element (or the element inside it, as a label's text is): it's the element.
      const { object } = await this.cdp.send("DOM.resolveNode", { backendNodeId: hit.backendNodeId }, sid);
      const related = await this.cdp
        .send(
          "Runtime.callFunctionOn",
          {
            objectId,
            functionDeclaration: "function (o) { return this === o || this.contains(o) || o.contains(this); }",
            arguments: [{ objectId: object.objectId }],
            returnByValue: true,
          },
          sid,
        )
        .then((v) => v?.result?.value === true, () => false);
      if (related) return null;
      const name = await this.cdp
        .send(
          "Runtime.callFunctionOn",
          {
            objectId: hitObject,
            functionDeclaration: `function () {
              const n = (this.getAttribute && (this.getAttribute("aria-label") || this.getAttribute("title"))) || (this.innerText || "").trim().replace(/\s+/g, " ");
              return this.tagName.toLowerCase() + (this.id ? "#" + this.id : "") + (n ? ' "' + n.slice(0, 40) + '"' : "");
            }`,
            returnByValue: true,
          },
          sid,
        )
        .then((v) => String(v?.result?.value ?? "another element"), () => "another element");
      return name;
    } finally {
      this.cdp.send("Runtime.releaseObject", { objectId: hitObject }, sid).catch(() => {});
    }
  }

  /** Whether the element is in the document frame element `frameNode` shows (one we couldn't look into). */
  private async inFrame(page: Page, objectId: string, frameNode: number): Promise<boolean> {
    const sid = page.sessionId;
    try {
      const { node: f } = await this.cdp.send("DOM.describeNode", { backendNodeId: frameNode, depth: 1, pierce: true }, sid);
      const inner = f?.contentDocument?.backendNodeId;
      if (!inner) return false;
      const doc = await this.cdp.send("Runtime.callFunctionOn", { objectId, functionDeclaration: "function () { return this.ownerDocument; }" }, sid);
      const { node: d } = await this.cdp.send("DOM.describeNode", { objectId: doc.result.objectId }, sid);
      return d?.backendNodeId === inner;
    } catch {
      return false;
    }
  }

  private async label(page: Page, objectId: string): Promise<string> {
    const s = await this.callOn(
      page,
      objectId,
      `function () {
        // Never anything typed into it (a field's value, an editable's text):
        // its names only; an editable element is never named by its content.
        const editable = this.tagName === "INPUT" || this.tagName === "TEXTAREA" || this.tagName === "SELECT" || this.isContentEditable ||
          (this.closest && this.closest("[contenteditable]:not([contenteditable=false])"));
        const t = (this.getAttribute && (this.getAttribute("aria-label") || this.getAttribute("placeholder") || this.getAttribute("name") ||
          (editable ? this.getAttribute("role") : ""))) || (editable ? "" : (this.innerText || "").trim());
        return this.tagName ? this.tagName.toLowerCase() + (t ? ' "' + String(t).replace(/\\s+/g, " ").slice(0, 40) + '"' : "") : "element";
      }`,
    ).catch(() => "element");
    return String(s);
  }

  private async type(req: CtlRequest): Promise<unknown> {
    const { page, node } = this.element(req.ref);
    const text = String(req.text ?? "");
    const sid = page.sessionId;
    const objectId = await this.objectOf(page, node);
    await this.personFree(page, Number(req.timeoutMs) || DEFAULT_TIMEOUT, "nothing was typed");
    // Named before anything is typed, from its names only.
    const label = await this.label(page, objectId);
    this.step("nothing was typed");
    await this.centre(page, node).catch(() => {}); // scrolled into view, where the watcher sees it
    let kind: any = null;
    // An input handler may open a dialog as the text goes in: back at once, saying so.
    const typingDialog = await this.untilDialog(page, this.callOn(
      page,
      objectId,
      `function (append, text) {
        // Disabled or read-only, nothing is changed, whatever the element.
        if (this.disabled || (this.closest && this.closest("fieldset:disabled"))) return { field: true, refused: "it's disabled" };
        if (this.tagName === "SELECT") {
          const opt = [...this.options].find((o) => o.value === text || o.label.trim() === text || o.text.trim() === text);
          if (!opt) return { select: false, options: [...this.options].map((o) => o.label.trim() || o.value).slice(0, 50) };
          // A disabled option (or one in a disabled group) can't be chosen: the choice stays as it was.
          if (opt.disabled || (opt.parentElement && opt.parentElement.tagName === "OPTGROUP" && opt.parentElement.disabled)) {
            return { field: true, refused: "that option is disabled" };
          }
          this.focus();
          this.value = opt.value;
          this.dispatchEvent(new Event("input", { bubbles: true }));
          this.dispatchEvent(new Event("change", { bubbles: true }));
          // Held to the same rule as text: the choice must stick.
          if (this.value !== opt.value) return { field: true, mismatch: "changed the choice back (a handler)" };
          return { select: true };
        }
        const doc = this.ownerDocument, win = doc.defaultView;
        const field = this.tagName === "INPUT" || this.tagName === "TEXTAREA";
        if (!field && !this.isContentEditable) return { field: false };
        const ac = String(this.getAttribute("autocomplete") || "").toLowerCase();
        const secret = this.type === "password" || /(^|\\s)(cc-|one-time-code|current-password|new-password)/.test(ac);
        if (field && this.readOnly) return { field: true, refused: "it's read-only", secret };
        if (field && this.tagName === "INPUT" && !/^(|text|search|url|tel|email|password|number)$/i.test(this.type)) {
          return { field: true, refused: \`it's an input of type \${this.type}\`, secret };
        }
        this.focus();
        // Typing goes wherever focus is: it must be this field (or inside it),
        // looking through shadow roots (a field in one focuses its host).
        let active = doc.activeElement;
        while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
        if (!(active === this || this.contains(active))) return { field: true, refused: "it won't take focus", secret };
        if (field) {
          const end = this.value.length;
          try { append ? this.setSelectionRange(end, end) : this.select(); } catch { if (!append) this.select && this.select(); }
        } else {
          const r = doc.createRange();
          r.selectNodeContents(this);
          if (append) r.collapse(false);
          const s = win.getSelection();
          s.removeAllRanges();
          s.addRange(r);
        }
        // Inserted here and now, in the same task as the focus check: the page
        // can't move focus in between. execCommand fires the input events a
        // person's typing would.
        const read = () => (field ? this.value : this.innerText);
        const before = read();
        const ok = text ? doc.execCommand("insertText", false, text) : append || doc.execCommand("delete", false);
        let now = doc.activeElement;
        while (now && now.shadowRoot && now.shadowRoot.activeElement) now = now.shadowRoot.activeElement;
        const describe = (e) => !e ? "nowhere" : e.tagName.toLowerCase() +
          (e.id ? "#" + e.id : "") + (e.getAttribute && (e.getAttribute("aria-label") || e.getAttribute("name")) ? ' "' + (e.getAttribute("aria-label") || e.getAttribute("name")).slice(0, 40) + '"' : "");
        const after = read();
        if (!ok && text && after === before) return { field: true, secret, fallback: true };
        if (!(now === this || this.contains(now)) && after === before) return { field: true, secret, missed: describe(now), landed: false };
        // What it holds now must be what was asked for (a maxlength, a mask or a
        // handler may have cut or changed it): said exactly (never echoing a secret).
        const want = append ? before + text : text;
        const norm = (v) => (field ? v : v.replace(/\s+$/, ""));
        if (norm(after) !== norm(want)) {
          const how = after === before ? "rejected it (unchanged)"
            : want.startsWith(after) ? \`cut it to \${after.length} of \${want.length} characters\${field && this.maxLength > 0 ? " (maxlength " + this.maxLength + ")" : ""}\`
            : \`changed it (\${after.length} characters\${secret ? "" : ': "' + after.slice(0, 60) + '"'})\`;
          return { field: true, secret, mismatch: how };
        }
        return { field: true, secret, done: true };
      }`,
      [!!req.append, text],
    ).then((v) => (kind = v)));
    if (typingDialog) {
      this.note(`tab ${page.num} shows a ${typingDialog.type} dialog`);
      return { tab: page.num, ref: req.ref, dialog: typingDialog, note: "the page showed a dialog as the text went in: check the element once it's answered" };
    }
    if (kind?.select === false) throw new CtlError(`no option "${text}" in that list; it has: ${kind.options.join(", ")}`);
    if (kind?.select === true) {
      const d = req.submit ? await this.submit(page, objectId, req.ref!, `chose "${clip(text, 40)}" in ${req.ref}`) : null;
      this.note(`chose "${clip(text, 40)}"`);
      return { tab: page.num, ref: req.ref, selected: text, ...(req.submit ? { submitted: true } : {}), ...(d ? { dialog: d } : {}) };
    }
    if (kind?.field === false) throw new CtlError(`element ${req.ref} isn't a text field (click it, then use key)`);
    if (kind?.refused) throw new CtlError(`element ${req.ref} can't be typed into: ${kind.refused}; nothing was typed`);
    if (!kind?.field) throw new CtlError(`element ${req.ref} can't be typed into; nothing was typed`);
    if (kind.mismatch) throw new CtlError(`element ${req.ref}: the page ${kind.mismatch}; not submitted`);
    if (kind.missed !== undefined) {
      throw new CtlError(
        kind.landed
          ? `element ${req.ref} got the text, but the page then moved focus to ${kind.missed}; not submitted`
          : `the text didn't go into element ${req.ref} (focus is on ${kind.missed}); check the page`,
      );
    }
    if (kind.fallback) {
      // The page's editor doesn't take execCommand: typed as keyboard input, then checked.
      this.step("nothing was typed");
      await this.cdp.send("Input.insertText", { text }, sid);
      const check = await this.callOn(
        page,
        objectId,
        `function (text) {
          const doc = this.ownerDocument;
          let now = doc.activeElement;
          while (now && now.shadowRoot && now.shadowRoot.activeElement) now = now.shadowRoot.activeElement;
          const got = this.tagName === "INPUT" || this.tagName === "TEXTAREA" ? this.value : this.innerText;
          return (now === this || this.contains(now)) && got.includes(text);
        }`,
        [text],
      ).catch(() => false);
      if (!check) throw new CtlError(`typed, but element ${req.ref} didn't get the text (the page moved focus?); check the page`);
    }
    const submitDialog = req.submit ? await this.submit(page, objectId, req.ref!, `typed ${text.length} characters into ${req.ref}`) : null;
    // What was typed is never shown (nor is a password field's name worth the risk).
    this.note(kind.secret ? "typed into a password field" : `typed into ${label}`);
    return { tab: page.num, ref: req.ref, typed: text.length, ...(req.submit ? { submitted: true } : {}), ...(submitDialog ? { dialog: submitDialog } : {}) };
  }

  /**
   * Submits only the element's own form, and only while it still has focus
   * (the page may have moved it after the text went in): checked and done in
   * one go; with no form, Enter (focus was just checked).
   */
  private async submit(page: Page, objectId: string, ref: string, done: string): Promise<{ type: string; message: string } | null> {
    this.step(`${done}, not submitted`);
    let how: any = null;
    // A submit handler may open a dialog (form validation): back at once, saying so.
    const dialog = await this.untilDialog(page, this.callOn(
      page,
      objectId,
      `function () {
        const doc = this.ownerDocument;
        let now = doc.activeElement;
        while (now && now.shadowRoot && now.shadowRoot.activeElement) now = now.shadowRoot.activeElement;
        if (!(now === this || this.contains(now))) {
          return { moved: !now ? "nowhere" : now.tagName.toLowerCase() + (now.id ? "#" + now.id : "") };
        }
        const form = this.form || (this.closest && this.closest("form"));
        if (form) {
          form.requestSubmit();
          return { form: true };
        }
        return { enter: true };
      }`,
    ).then((v) => (how = v)));
    if (dialog) return dialog;
    if (how?.moved) throw new CtlError(`${done}, but the page moved focus to ${how.moved}; not submitted`);
    if (how?.enter) return this.untilDialog(page, this.pressKey(page, "Enter"));
    return null;
  }

  private async pressKey(page: Page, spec: string): Promise<void> {
    const k = parseKey(spec);
    const sid = page.sessionId;
    const base = { modifiers: k.modifiers, key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, location: 0 };
    await this.cdp.send(
      "Input.dispatchKeyEvent",
      { type: k.text ? "keyDown" : "rawKeyDown", ...base, text: k.text, unmodifiedText: k.text, commands: k.commands },
      sid,
    );
    await this.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base }, sid);
  }

  private async key(req: CtlRequest): Promise<unknown> {
    const keys = req.keys ?? [];
    if (!keys.length) throw new CtlError("key needs a key, such as Enter, Tab, ctrl+a or ArrowDown", EXIT.usage);
    for (const k of keys) parseKey(k); // all valid before any is pressed
    const page = this.page(req.tab);
    await this.personFree(page, Number(req.timeoutMs) || DEFAULT_TIMEOUT, "no keys pressed");
    // Key by key, stopping (and saying so) when the time is up: never typing on after the reply.
    for (const [i, k] of keys.entries()) {
      this.step(i ? `pressed ${i} of ${keys.length} keys${i <= 10 ? ` (${keys.slice(0, i).join(" ")})` : ""}` : "no keys pressed");
      const dialog = await this.untilDialog(page, this.pressKey(page, k));
      if (dialog) {
        // A dialog came up: the rest of the keys aren't pressed (they'd wait on it).
        this.note(`tab ${page.num} shows a ${dialog.type} dialog`);
        return { tab: page.num, keys: keys.slice(0, i + 1), pressed: i + 1, of: keys.length, dialog };
      }
    }
    this.note(`pressed ${keys.join(" ")}`);
    return { tab: page.num, keys };
  }

  private async scroll(req: CtlRequest): Promise<unknown> {
    const dir = req.direction ?? "down";
    let page: Page;
    let at: { x: number; y: number };
    if (req.ref) {
      const el = this.element(req.ref);
      page = el.page;
      // (Finding the element scrolls it into view: only once the person and the time allow.)
      await this.personFree(page, Number(req.timeoutMs) || DEFAULT_TIMEOUT, "not scrolled");
      this.step("not scrolled");
      at = await this.centre(page, el.node);
    } else {
      page = this.page(req.tab);
      const [w, h] = ((await this.evalValue(page, "[innerWidth, innerHeight]")) ?? [800, 600]) as number[];
      at = { x: w! / 2, y: h! / 2 };
    }
    const viewport = ((await this.evalValue(page, dir === "left" || dir === "right" ? "innerWidth" : "innerHeight")) as number) || 600;
    const amount = req.amount && req.amount > 0 ? req.amount : Math.round(viewport * 0.8);
    const dx = dir === "left" ? -amount : dir === "right" ? amount : 0;
    const dy = dir === "up" ? -amount : dir === "down" ? amount : 0;
    await this.personFree(page, Number(req.timeoutMs) || DEFAULT_TIMEOUT, "not scrolled");
    this.step("not scrolled");
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: at.x, y: at.y, deltaX: dx, deltaY: dy }, page.sessionId);
    await Bun.sleep(250); // smooth scrolling
    const pos = (await this.evalValue(page, "[scrollX, scrollY]").catch(() => null)) as number[] | null;
    this.note(`scrolled ${dir}`);
    return { tab: page.num, scrollX: pos?.[0] ?? null, scrollY: pos?.[1] ?? null };
  }

  private async shot(page: Page, full: boolean): Promise<unknown> {
    const sid = page.sessionId;
    let truncated: { height: number; captured: number } | undefined;
    const data = await this.app.withPage(page, async () => {
      if (!full) return (await this.cdp.send("Page.captureScreenshot", { format: "png" }, sid)).data as string;
      const m = await this.cdp.send("Page.getLayoutMetrics", {}, sid);
      const size = m.cssContentSize ?? m.contentSize;
      const width = Math.ceil(size.width);
      const height = Math.ceil(size.height);
      // Up to FULL_PIXELS device pixels in all (the picture is put together in memory).
      const dpr = Number((await this.cdp.send("Runtime.evaluate", { expression: "devicePixelRatio", returnByValue: true }, sid))?.result?.value) || 1;
      const captured = Math.min(height, Math.max(1, Math.floor(FULL_PIXELS / (width * dpr * dpr))));
      if (captured < height) truncated = { height, captured };
      const capture = async (y: number, h: number) =>
        (await this.cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y, width, height: h, scale: 1 } }, sid))
          .data as string;
      if (captured <= TILE) return capture(0, captured);
      // Taller than a browser can capture in one picture: in tiles, put together.
      const tiles: Raster[] = [];
      for (let y = 0; y < captured; y += TILE) {
        const r = decodePng(Buffer.from(await capture(y, Math.min(TILE, captured - y)), "base64"));
        if (!r) throw new CtlError("couldn't read a screenshot tile");
        tiles.push(r);
      }
      const w = tiles[0]!.width;
      const ch = tiles[0]!.channels;
      if (tiles.some((t) => t.width !== w || t.channels !== ch)) throw new CtlError("screenshot tiles differ in size; try again");
      const all = new Uint8Array(tiles.reduce((n, t) => n + t.data.length, 0));
      let off = 0;
      for (const t of tiles) {
        all.set(t.data, off);
        off += t.data.length;
      }
      const h = tiles.reduce((n, t) => n + t.height, 0);
      return encodeRegion({ width: w, height: h, channels: ch, data: all }, 0, 0, w, h).toString("base64");
    });
    return { tab: page.num, png: data, ...(truncated ? { truncated } : {}) };
  }


  // ------------------------------------------------------------ waiting

  private async waitLoad(page: Page, deadline: number, navigation: boolean): Promise<void> {
    const started = Date.now();
    let settledAt = 0;
    // At least one look, however short the timeout.
    for (let first = true; first || Date.now() < deadline; first = false) {
      if (!this.app.isOpen(page)) throw new CtlError(`tab ${page.num} closed`);
      if (page.dialog) return; // the page waits on its dialog: nothing more will load
      const fresh = !navigation || page.navStarted === 0;
      const state = fresh ? await this.evalValue(page, "[document.readyState, location.href]").catch(() => null) : null;
      // (termium's own blank page isn't loaded yet; a page's real #termium-... fragment is.)
      // (A page opened blank, as a session started without a URL has, is loaded when not navigating.)
      const complete = state?.[0] === "complete" && (!navigation || !this.app.isPlaceholder(String(state?.[1] ?? "")));
      if (complete && !page.loading) return;
      // A same-document navigation (only the #fragment changed) never says it stopped loading.
      if (complete) {
        settledAt ||= Date.now();
        if (Date.now() - settledAt > 1500 && Date.now() - started > 1500) return;
      } else settledAt = 0;
      await Bun.sleep(100);
    }
    throw new CtlError(`tab ${page.num}: still loading`, EXIT.timeout);
  }

  private async wait(req: CtlRequest, timeoutMs: number): Promise<unknown> {
    const page = this.page(req.tab);
    const what = req.what ?? "load";
    const deadline = Date.now() + timeoutMs - 300;
    const t0 = Date.now();
    if (what === "load") {
      await this.waitLoad(page, deadline, false);
      return { tab: page.num, waited: "load", ms: Date.now() - t0 };
    }
    const value = String(req.value ?? "");
    if (!value) throw new CtlError(`wait ${what} needs a value`, EXIT.usage);
    const v = JSON.stringify(value);
    const probe =
      what === "selector"
        ? `(() => { const e = document.querySelector(${v}); if (!e) return false;
            const r = e.getBoundingClientRect(), s = getComputedStyle(e);
            return (r.width > 0 || r.height > 0) && s.visibility !== "hidden"; })()`
        : what === "text"
          ? `(() => { const b = document.body; return !!b && b.innerText.includes(${v}); })()`
          : `location.href.includes(${v})`;
    if (what === "selector") {
      // A bad selector is an error now, not a timeout later.
      await this.evalValue(page, `document.querySelector(${v}), true`).catch((e) => {
        throw new CtlError(`bad selector ${v}: ${e?.message ?? e}`, EXIT.usage);
      });
    }
    const want = !req.gone;
    for (let first = true; first || Date.now() < deadline; first = false) {
      if (!this.app.isOpen(page)) throw new CtlError(`tab ${page.num} closed`);
      if (page.dialog) throw new CtlError(`tab ${page.num} is showing a ${page.dialog.type} dialog; answer it with termium ctl dialog`);
      const got = await this.evalValue(page, probe).catch(() => null);
      if (got === want) return { tab: page.num, waited: what, value, gone: !want, ms: Date.now() - t0 };
      await Bun.sleep(100);
    }
    throw new CtlError(`tab ${page.num}: ${what} ${v} ${want ? "didn't appear" : "didn't go away"} within ${Math.round(timeoutMs / 1000)}s`, EXIT.timeout);
  }
}

const MAX_LINES = 3000;
/** A full-page shot is taken in tiles this tall (CSS px), up to FULL_PIXELS device pixels in all. */
const TILE = 8192;
const FULL_PIXELS = 40_000_000;
const SKIP_ROLES = new Set(["generic", "none", "presentation", "LineBreak", "group", "Section", "paragraph", "LayoutTable", "LayoutTableRow", "LayoutTableCell", "div", "LabelText"]);
const VALUE_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton", "slider", "textField", "TextField", "ComboBoxMenuButton", "progressbar", "meter"]);
const FLAG_PROPS = new Set(["focused", "disabled", "required", "selected", "readonly", "multiselectable", "modal"]);

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function area(q: number[]): number {
  let a = 0;
  for (let i = 0; i < 8; i += 2) {
    const j = (i + 2) % 8;
    a += q[i]! * q[j + 1]! - q[j]! * q[i + 1]!;
  }
  return Math.abs(a) / 2;
}

function exceptionText(d: any): string {
  const e = d?.exception;
  return String(e?.description ?? e?.value ?? d?.text ?? "exception").split("\n")[0]!;
}

// ------------------------------------------------------------ keys

interface Key {
  key: string;
  code: string;
  vk: number;
  text: string;
  modifiers: number;
  commands?: string[];
}

const NAMED: Record<string, [key: string, code: string, vk: number, text?: string]> = {
  enter: ["Enter", "Enter", 13, "\r"],
  return: ["Enter", "Enter", 13, "\r"],
  tab: ["Tab", "Tab", 9],
  escape: ["Escape", "Escape", 27],
  esc: ["Escape", "Escape", 27],
  backspace: ["Backspace", "Backspace", 8],
  delete: ["Delete", "Delete", 46],
  insert: ["Insert", "Insert", 45],
  space: [" ", "Space", 32, " "],
  arrowup: ["ArrowUp", "ArrowUp", 38],
  arrowdown: ["ArrowDown", "ArrowDown", 40],
  arrowleft: ["ArrowLeft", "ArrowLeft", 37],
  arrowright: ["ArrowRight", "ArrowRight", 39],
  up: ["ArrowUp", "ArrowUp", 38],
  down: ["ArrowDown", "ArrowDown", 40],
  left: ["ArrowLeft", "ArrowLeft", 37],
  right: ["ArrowRight", "ArrowRight", 39],
  home: ["Home", "Home", 36],
  end: ["End", "End", 35],
  pageup: ["PageUp", "PageUp", 33],
  pagedown: ["PageDown", "PageDown", 34],
};
for (let i = 1; i <= 12; i++) NAMED[`f${i}`] = [`F${i}`, `F${i}`, 111 + i];

const MODS: Record<string, number> = { alt: 1, option: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, super: 4, shift: 8 };

/** Editing commands headless Chromium only runs when asked (as termium's own keys do). */
const EDIT_COMMANDS: Record<string, string> = {
  "ctrl+a": "selectAll",
  "ctrl+c": "copy",
  "ctrl+x": "cut",
  "ctrl+v": "paste",
  "ctrl+z": "undo",
  "ctrl+shift+z": "redo",
  "ctrl+y": "redo",
};

/** "Enter", "ctrl+a", "Shift+Tab", "a", "ArrowDown". */
export function parseKey(spec: string): Key {
  const parts = spec.split("+");
  // "ctrl++" is Ctrl and "+".
  if (spec.endsWith("++")) parts.splice(parts.length - 2, 2, "+");
  const name = parts.pop() ?? "";
  let modifiers = 0;
  const mods: string[] = [];
  for (const m of parts) {
    const bit = MODS[m.toLowerCase()];
    if (!bit) throw new CtlError(`unknown modifier "${m}" in "${spec}" (ctrl, alt, shift, meta)`, EXIT.usage);
    modifiers |= bit;
    mods.push(m.toLowerCase().replace("control", "ctrl"));
  }
  const named = NAMED[name.toLowerCase()];
  let k: Key;
  if (named) {
    const [key, code, vk, text] = named;
    k = { key, code, vk, text: text ?? "", modifiers };
  } else if ([...name].length === 1) {
    const shifted = !!(modifiers & 8);
    let ch = name;
    if (/^[a-z]$/i.test(ch)) ch = shifted ? ch.toUpperCase() : ch;
    const upper = ch.toUpperCase();
    const code = /^[A-Z]$/.test(upper) ? `Key${upper}` : /^[0-9]$/.test(ch) ? `Digit${ch}` : "";
    const vk = /^[A-Z0-9]$/.test(upper) ? upper.charCodeAt(0) : 0;
    k = { key: ch, code, vk, text: ch, modifiers };
  } else {
    throw new CtlError(`unknown key "${name}" (Enter, Tab, Escape, Backspace, Delete, Space, arrows, Home, End, PageUp, PageDown, F1-F12, or one character)`, EXIT.usage);
  }
  // Ctrl/Alt/Meta chords type nothing.
  if (modifiers & 7) k.text = "";
  const combo = [...new Set(mods)].sort((a, b) => ["ctrl", "alt", "shift", "meta"].indexOf(a) - ["ctrl", "alt", "shift", "meta"].indexOf(b));
  const cmd = EDIT_COMMANDS[[...combo, k.key.toLowerCase()].join("+")];
  if (cmd) k.commands = [cmd];
  return k;
}
