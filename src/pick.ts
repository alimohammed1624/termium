// The element picker (Ctrl+B g, or `termium ctl pick`): the person points
// at an element on the page, termium outlines it, and a click hands it to
// an agent: its element id (as `termium ctl snapshot` gives them, good for
// `ctl click` / `ctl type`), a CSS selector, its text and HTML (trimmed)
// and the page's address. The click itself never reaches the page.

import type { CDP } from "./cdp";

/** An element the person picked, as `termium ctl picked --json` gives it. */
export interface Picked {
  /** The page's number (a "tab" to `termium ctl`). */
  tab: number;
  /** Element id, like those of `termium ctl snapshot`: valid until the page changes document. */
  ref: string;
  url: string;
  title: string;
  /** Its accessibility role and name (as in the snapshot), when it has them. */
  role: string;
  name: string;
  tag: string;
  /** A CSS selector for it, within its own document (`frame` says which, when not the page's). */
  selector: string;
  /** The address of the frame it's in, when that's not the page itself. */
  frame?: string;
  /** In a shadow root: the selector is within it. */
  shadow?: boolean;
  text: string;
  html: string;
  /** When it was picked (ms since the epoch). */
  at: number;
}

const HIGHLIGHT = {
  showInfo: true,
  contentColor: { r: 111, g: 168, b: 220, a: 0.45 },
  paddingColor: { r: 147, g: 196, b: 125, a: 0.4 },
  borderColor: { r: 255, g: 229, b: 153, a: 0.6 },
  marginColor: { r: 246, g: 178, b: 107, a: 0.4 },
};

/** Run on the element (a text node gives its parent): what describes it, never a field's typed value. */
const DESCRIBE = `function () {
  const el = this.nodeType === 1 ? this : this.parentElement;
  if (!el) return null;
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const root = el.getRootNode();
  const unique = (sel) => { try { return root.querySelectorAll(sel).length === 1; } catch { return false; } };
  const esc = (s) => CSS.escape(s);
  const part = (e) => {
    const tag = e.localName;
    if (e.id && unique("#" + esc(e.id))) return { sel: "#" + esc(e.id), done: true };
    for (const a of ["data-testid", "data-test", "data-qa", "name", "aria-label"]) {
      const v = e.getAttribute(a);
      if (v && v.length < 80) {
        const s = tag + "[" + a + "=" + JSON.stringify(v) + "]";
        if (unique(s)) return { sel: s, done: true };
      }
    }
    let s = tag;
    const p = e.parentNode;
    if (p && p.children) {
      const same = [...p.children].filter((c) => c.localName === tag);
      if (same.length > 1) s += ":nth-of-type(" + (same.indexOf(e) + 1) + ")";
    }
    return { sel: s, done: false };
  };
  const parts = [];
  for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
    const p = part(e);
    parts.unshift(p.sel);
    if (p.done || unique(parts.join(" > "))) break;
  }
  const doc = el.ownerDocument;
  const password = el.localName === "input" && el.type === "password";
  let html = el.outerHTML;
  if (password || el.localName === "input" || el.localName === "textarea") {
    // Only the tag: a field's value (even as typed into the HTML) stays out.
    const c = el.cloneNode(false);
    c.removeAttribute("value");
    html = c.outerHTML;
  }
  const editable = el.isContentEditable || ["input", "textarea", "select"].includes(el.localName);
  const text = editable ? "" : String(el.innerText ?? el.textContent ?? "").replace(/\\s+/g, " ").trim();
  return {
    tag: el.localName,
    selector: parts.join(" > "),
    frame: doc.defaultView && doc.defaultView !== doc.defaultView.top ? String(doc.location.href) : undefined,
    shadow: root !== doc || undefined,
    text: clip(text, 300),
    html: clip(html.replace(/\\s+/g, " ").trim(), 500),
  };
}`;

/**
 * Outlines what's under the pointer, and reads the element under a click.
 * DOM and Overlay are on for a page only while it's being picked from.
 */
export class Picker {
  private enabled = new Map<string, Promise<boolean>>();
  private busy = false;
  private next: { sid: string; x: number; y: number } | null = null;

  constructor(private cdp: CDP) {}

  private enable(sid: string): Promise<boolean> {
    let p = this.enabled.get(sid);
    if (!p) {
      p = this.cdp
        .send("DOM.enable", {}, sid)
        .then(() => this.cdp.send("Overlay.enable", {}, sid))
        .then(() => true, () => false);
      this.enabled.set(sid, p);
    }
    return p;
  }

  /** The node at (x, y), CSS px of the page's viewport (looking into same-process frames). */
  private async nodeAt(sid: string, x: number, y: number): Promise<number | null> {
    const r = await this.cdp
      .send("DOM.getNodeForLocation", { x: Math.round(x), y: Math.round(y), includeUserAgentShadowDOM: false, ignorePointerEventsNone: true }, sid)
      .catch(() => null);
    return r?.backendNodeId ?? null;
  }

  /** Outlines the element at (x, y); pointer motion is coalesced (latest wins). */
  hover(sid: string, x: number, y: number): void {
    this.next = { sid, x, y };
    if (this.busy) return;
    this.busy = true;
    void (async () => {
      try {
        while (this.next) {
          const { sid, x, y } = this.next;
          this.next = null;
          if (!(await this.enable(sid))) continue;
          for (const other of this.enabled.keys()) {
            if (other !== sid) this.cdp.send("Overlay.hideHighlight", {}, other).catch(() => {});
          }
          const node = await this.nodeAt(sid, x, y);
          if (node) await this.cdp.send("Overlay.highlightNode", { highlightConfig: HIGHLIGHT, backendNodeId: node }, sid).catch(() => {});
          else await this.cdp.send("Overlay.hideHighlight", {}, sid).catch(() => {});
        }
      } finally {
        this.busy = false;
      }
    })();
  }

  /** Reads the element at (x, y): its backend node id and what describes it. */
  async pick(sid: string, x: number, y: number): Promise<{ node: number; role: string; name: string; info: any } | null> {
    await this.enable(sid);
    const hit = await this.nodeAt(sid, x, y);
    if (!hit) return null;
    const group = "termium-pick";
    try {
      const { object } = await this.cdp.send("DOM.resolveNode", { backendNodeId: hit, objectGroup: group }, sid);
      // (A text node stands for its element.)
      const el = await this.cdp.send(
        "Runtime.callFunctionOn",
        { objectId: object.objectId, functionDeclaration: "function () { return this.nodeType === 1 ? this : this.parentElement; }", objectGroup: group },
        sid,
      );
      const elId = el?.result?.objectId;
      if (!elId) return null;
      const { node } = await this.cdp.send("DOM.describeNode", { objectId: elId }, sid);
      const r = await this.cdp.send("Runtime.callFunctionOn", { objectId: elId, functionDeclaration: DESCRIBE, returnByValue: true, objectGroup: group }, sid);
      const info = r?.result?.value;
      if (!info || !node?.backendNodeId) return null;
      const ax = await this.cdp
        .send("Accessibility.getPartialAXTree", { backendNodeId: node.backendNodeId, fetchRelatives: false }, sid)
        .catch(() => null);
      const a = ax?.nodes?.find((n: any) => n.backendDOMNodeId === node.backendNodeId) ?? ax?.nodes?.[0];
      const role = a && !a.ignored ? String(a.role?.value ?? "") : "";
      const name = a && !a.ignored ? String(a.name?.value ?? "").replace(/\s+/g, " ").trim() : "";
      return { node: node.backendNodeId, role: role === "generic" || role === "none" ? "" : role, name, info };
    } finally {
      this.cdp.send("Runtime.releaseObjectGroup", { objectGroup: group }, sid).catch(() => {});
    }
  }

  /** Takes the outline down and turns DOM and Overlay off again, on every page picked from. */
  stop(): void {
    this.next = null;
    for (const [sid, on] of this.enabled) {
      void on.then((ok) => {
        if (!ok) return;
        this.cdp.send("Overlay.hideHighlight", {}, sid).catch(() => {});
        this.cdp.send("Overlay.disable", {}, sid).catch(() => {});
        this.cdp.send("DOM.disable", {}, sid).catch(() => {});
      });
    }
    this.enabled.clear();
  }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The element in a line, as the snapshot shows it: `button "Sign in" [3:142@2]`. */
export function pickedLine(p: Picked): string {
  return `${p.role || p.tag}${p.name ? ` "${clip(p.name, 80)}"` : ""} [${p.ref}]`;
}

/** What goes on the clipboard (and `termium ctl picked` prints): short, for pasting to an agent. */
export function pickedText(p: Picked, session?: string): string {
  const ctl = `termium ctl${session && session !== "default" ? ` -s ${session}` : ""}`;
  return [
    `Picked in termium: ${pickedLine(p)}`,
    `page: ${p.url}`,
    p.frame ? `frame: ${p.frame}` : "",
    `selector: ${p.selector}${p.shadow ? " (in a shadow root)" : ""}`,
    p.text ? `text: ${clip(p.text, 200)}` : "",
    `html: ${clip(p.html, 200)}`,
    `act on it: ${ctl} click ${p.ref} (or type ${p.ref} TEXT)`,
  ]
    .filter(Boolean)
    .join("\n");
}
