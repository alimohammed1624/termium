// Link hints (Vimium-style): the clickable elements in view get short
// labels; typing one clicks its element. The person gets them with a key
// (see App.startHints), agents with `termium ctl hints`; both get the same
// labels for the same view.
//
// Labels are drawn by the page itself, in a closed shadow root over it, so
// they sit on their elements at any zoom, pixel ratio or pane size, and
// through tmux too (a terminal cell drawn over a kitty picture would be
// hidden under it). The script runs in an isolated world: the page's own
// scripts can't see it or change what it reads.

import type { CDP } from "./cdp";

/** What labels are made of: the home row first, as in Vimium. */
export const HINT_CHARS = "sadfjklewcmpgh";

/** Elements labelled at most (more would need longer labels). */
export const MAX_HINTS = 1000;

/**
 * `n` labels, as short as they can be, none the start of another (so the
 * keys typed so far always narrow them down), the home row first.
 * Vimium's scheme.
 */
export function hintLabels(n: number, chars = HINT_CHARS): string[] {
  if (n <= 0 || chars.length < 2) return [];
  const hints = [""];
  let offset = 0;
  while (hints.length - offset < n || hints.length === 1) {
    const h = hints[offset++]!;
    for (const c of chars) hints.push(c + h);
  }
  // (Built last letter first, then turned around: longer labels share their first letter, so it narrows to them.)
  return hints.slice(offset, offset + n).map((h) => [...h].reverse().join(""));
}

/** One labelled element, in CSS pixels of the page's viewport. */
export interface HintInfo {
  /** Where a click lands on it (a point where it's on top). */
  x: number;
  y: number;
  /** The part of its box in view. */
  left: number;
  top: number;
  width: number;
  height: number;
  tag: string;
  role: string;
  /** Its name (aria-label, title, its text); never what's typed into a field. */
  text: string;
  href: string;
  /** A link (opens in a new tab with a modifier). */
  link: boolean;
}

/**
 * Installed once in each isolated world: globalThis.__termiumHints, the
 * collector and the overlay. Sets are kept by slot ("person", "agent")
 * so an agent's listing never replaces what the person is choosing from.
 */
const INSTALL = String.raw`(() => {
  if (globalThis.__termiumHints) return;
  const SEL = 'a[href],area[href],button,input:not([type=hidden]),select,textarea,summary,' +
    '[contenteditable]:not([contenteditable=false]),[onclick],[onmousedown],[tabindex]:not([tabindex^="-"]),' +
    'video[controls],audio[controls],' +
    ['button','link','checkbox','radio','tab','menuitem','menuitemcheckbox','menuitemradio','option','switch',
     'treeitem','combobox','textbox','searchbox','slider','spinbutton'].map((r) => '[role=' + r + ']').join(',');
  const NATIVE = new Set(['A','AREA','BUTTON','INPUT','SELECT','TEXTAREA','SUMMARY','VIDEO','AUDIO']);
  const owns = (el, n) => { for (; n; n = n.parentNode || n.host) if (n === el) return true; return false; };
  const hitAt = (x, y) => {
    let e = document.elementFromPoint(x, y);
    for (let i = 0; e && e.shadowRoot && i < 32; i++) {
      const inner = e.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === e) break;
      e = inner;
    }
    return e;
  };
  // The part of the element in view, and a point there where it's on top.
  const place = (el) => {
    if (!el.isConnected) return null;
    const W = innerWidth, H = innerHeight;
    for (const r of el.getClientRects()) {
      const left = Math.max(0, r.left), top = Math.max(0, r.top);
      const right = Math.min(W, r.right), bottom = Math.min(H, r.bottom);
      if (right - left < 3 || bottom - top < 3) continue;
      const cx = (left + right) / 2, cy = (top + bottom) / 2;
      const pts = [[cx, cy], [left + 2, top + 2], [right - 2, top + 2], [left + 2, bottom - 2], [right - 2, bottom - 2], [cx, top + 2], [left + 2, cy]];
      for (const [x, y] of pts) if (owns(el, hitAt(x, y))) return { x, y, left, top, width: right - left, height: bottom - top };
    }
    return null;
  };
  const clip = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const nameOf = (el) => {
    const field = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
    const attr = (a) => el.getAttribute(a) || '';
    if (attr('aria-label') || attr('title')) return clip(attr('aria-label') || attr('title'));
    if (el.tagName === 'INPUT' && /^(button|submit|reset)$/i.test(el.type)) return clip(el.value);
    if (field) return clip(attr('placeholder') || attr('name'));
    const img = el.querySelector && el.querySelector('img[alt]');
    return clip(el.innerText || (img && img.alt) || '');
  };
  const sets = {};
  let host = null, spans = [];
  const clear = () => { if (host) host.remove(); host = null; spans = []; };
  const api = {
    collect(slot, max) {
      if (slot === 'person') clear();
      const found = [];
      const walk = (root) => {
        const tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        for (let n = tw.nextNode(); n; n = tw.nextNode()) {
          if (n.matches(SEL)) found.push(n);
          if (n.shadowRoot) walk(n.shadowRoot);
        }
      };
      if (document.documentElement) walk(document.documentElement);
      const cand = new Set(found);
      const items = [];
      for (const el of found) {
        if (items.length >= max) break;
        if (el === document.body || el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true') continue;
        // Something clickable inside another (a span with a tabindex in a link): the outer one is enough.
        if (!NATIVE.has(el.tagName)) {
          let inner = false;
          for (let n = el.parentNode || el.host; n && !inner; n = n.parentNode || n.host) inner = cand.has(n);
          if (inner) continue;
        }
        const p = place(el);
        if (p) items.push({ el, p });
      }
      sets[slot] = items.map((i) => i.el);
      return items.map(({ el, p }) => {
        const link = (el.tagName === 'A' || el.tagName === 'AREA') && !!el.href;
        return { x: Math.round(p.x), y: Math.round(p.y), left: Math.round(p.left), top: Math.round(p.top),
          width: Math.round(p.width), height: Math.round(p.height), tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || '', text: nameOf(el), href: link ? String(el.href) : '', link };
      });
    },
    elements(slot) { return sets[slot] || []; },
    draw(labels, fontPx) {
      clear();
      const els = sets.person || [];
      host = document.createElement('termium-hints');
      const css = (el, props) => { for (const k in props) el.style.setProperty(k, props[k], 'important'); };
      css(host, { all: 'initial', display: 'block', position: 'fixed', left: '0', top: '0', width: '0', height: '0',
        margin: '0', padding: '0', border: '0', overflow: 'visible', 'z-index': '2147483647', 'pointer-events': 'none' });
      const root = host.attachShadow({ mode: 'closed' });
      labels.forEach((label, i) => {
        const p = els[i] && place(els[i]);
        if (!p) return;
        const s = document.createElement('span');
        css(s, { position: 'absolute', left: p.left + 'px', top: p.top + 'px', 'box-sizing': 'border-box',
          font: 'bold ' + fontPx + 'px/1 ui-monospace, "JetBrains Mono", "DejaVu Sans Mono", monospace',
          padding: '1px 3px', background: '#f9e2af', color: '#11111b', border: '1px solid #11111b',
          'border-radius': '3px', 'box-shadow': '0 1px 3px rgba(0,0,0,.45)', 'white-space': 'nowrap',
          'text-transform': 'uppercase', 'letter-spacing': '0', 'pointer-events': 'none' });
        s.textContent = label;
        root.appendChild(s);
        spans.push({ s, label });
      });
      (document.body || document.documentElement).appendChild(host);
      // Above modal dialogs and popovers too (the top layer), where that's supported.
      try { host.setAttribute('popover', 'manual'); host.showPopover(); } catch {}
      return spans.length;
    },
    narrow(typed) {
      let n = 0;
      for (const { s, label } of spans) {
        const on = label.startsWith(typed);
        s.style.setProperty('display', on ? 'block' : 'none', 'important');
        if (!on) continue;
        n++;
        s.textContent = '';
        if (typed) {
          const done = document.createElement('span');
          done.style.setProperty('opacity', '0.4', 'important');
          done.textContent = typed;
          s.appendChild(done);
        }
        s.appendChild(document.createTextNode(label.slice(typed.length)));
      }
      return n;
    },
    // Where to click element i of the person's set now (null: it's gone or covered).
    target(i) {
      clear();
      const el = (sets.person || [])[i];
      const p = el && place(el);
      if (!p) return null;
      return { x: p.x, y: p.y, link: (el.tagName === 'A' || el.tagName === 'AREA') && !!el.href };
    },
    clear() { clear(); delete sets.person; },
  };
  Object.defineProperty(globalThis, '__termiumHints', { value: api });
})()`;

type Send = Pick<CDP, "send">["send"];

/** A page as hints need it: its main frame, and the isolated world made there (kept on the page). */
export interface HintTarget {
  sessionId: string;
  targetId: string;
  hintWorld?: number | null;
}

/**
 * The hints of one page, in an isolated world of its main frame, made
 * once and kept on the page (made again after it loads a new document).
 */
export class PageHints {
  constructor(
    private send: Send,
    private page: HintTarget,
  ) {}

  private get sid(): string {
    return this.page.sessionId;
  }

  /** Evaluates `expr` in the world; with `install`, makes the world (and its script) first if needed. */
  private async eval(expr: string, install: boolean, byValue = true): Promise<any> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.page.hintWorld == null) {
        if (!install) return null;
        const w = await this.send("Page.createIsolatedWorld", { frameId: this.page.targetId, worldName: "termium-hints" }, this.sid);
        this.page.hintWorld = w.executionContextId as number;
      }
      const r = await this.send(
        "Runtime.evaluate",
        { expression: install ? `${INSTALL}, ${expr}` : expr, contextId: this.page.hintWorld, returnByValue: byValue, objectGroup: "termium-hints" },
        this.sid,
      ).catch((e: unknown) => {
        // The world went with its document: made again (once).
        if (/Cannot find context|context was destroyed|Execution context/i.test(String(e))) return null;
        throw e;
      });
      if (r === null) {
        this.page.hintWorld = null;
        continue;
      }
      if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
      return byValue ? r.result?.value : r.result;
    }
    return null;
  }

  /** The clickable elements in view, in document order (labels go to them in this order). */
  async collect(slot: "person" | "agent"): Promise<HintInfo[]> {
    return ((await this.eval(`__termiumHints.collect(${JSON.stringify(slot)}, ${MAX_HINTS})`, true)) ?? []) as HintInfo[];
  }

  /** Draws the person's labels; how many could be drawn. */
  async draw(labels: string[], fontPx: number): Promise<number> {
    return Number(await this.eval(`__termiumHints.draw(${JSON.stringify(labels)}, ${fontPx})`, false)) || 0;
  }

  /** Shows only the labels starting with `typed`, its letters dimmed. */
  async narrow(typed: string): Promise<void> {
    await this.eval(`__termiumHints.narrow(${JSON.stringify(typed)})`, false).catch(() => {});
  }

  /** Takes the labels down; where to click the person's element `i` now (null: gone, covered or scrolled away). */
  async target(i: number): Promise<{ x: number; y: number; link: boolean } | null> {
    return ((await this.eval(`__termiumHints.target(${i})`, false).catch(() => null)) ?? null) as { x: number; y: number; link: boolean } | null;
  }

  async clear(): Promise<void> {
    await this.eval(`__termiumHints.clear()`, false).catch(() => {});
  }

  /** The backend node ids of the agent's set, in order (0 where one can't be had). */
  async agentNodes(): Promise<number[]> {
    const arr = await this.eval(`__termiumHints.elements("agent")`, false, false);
    if (!arr?.objectId) return [];
    try {
      const { result } = await this.send("Runtime.getProperties", { objectId: arr.objectId, ownProperties: true }, this.sid);
      const els = (result as any[]).filter((p) => /^\d+$/.test(p.name) && p.value?.objectId).sort((a, b) => Number(a.name) - Number(b.name));
      return await Promise.all(
        els.map((p) =>
          this.send("DOM.describeNode", { objectId: p.value.objectId }, this.sid).then(
            (d: any) => Number(d?.node?.backendNodeId) || 0,
            () => 0,
          ),
        ),
      );
    } finally {
      this.send("Runtime.releaseObjectGroup", { objectGroup: "termium-hints" }, this.sid).catch(() => {});
    }
  }
}

/** The label size in CSS px for a pane: about a terminal row tall on screen, whatever the zoom. */
export function hintFontPx(cellH: number, dsf: number): number {
  return Math.max(8, Math.round((cellH / Math.max(0.25, dsf)) * 0.7));
}
