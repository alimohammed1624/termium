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
 * collector and the overlay. Each listing has its own slot (a name given
 * by PageHints), so overlapping ones (the person's and an agent's, or
 * two agents') never mix or take down each other's.
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
  // A same-origin frame's document (null for another origin's).
  const inner = (f) => { try { return f.contentDocument; } catch { return null; } };
  // Where a frame's content starts in its parent's viewport, and its scale there (a CSS transform).
  const frameBox = (f) => {
    const b = f.getBoundingClientRect();
    const s = f.offsetWidth > 0 ? b.width / f.offsetWidth : 1;
    return { dx: b.left + f.clientLeft * s, dy: b.top + f.clientTop * s, s: s > 0 ? s : 1 };
  };
  // What a click at (x, y) of the top viewport lands on: through shadow roots and same-origin frames.
  const hitAt = (x, y) => {
    let e = document.elementFromPoint(x, y);
    for (let i = 0; e && i < 32; i++) {
      if (e.shadowRoot) {
        const s = e.shadowRoot.elementFromPoint(x, y);
        if (s && s !== e) { e = s; continue; }
      }
      const d = (e.tagName === 'IFRAME' || e.tagName === 'FRAME') && inner(e);
      if (!d) break;
      const f = frameBox(e);
      x = (x - f.dx) / f.s;
      y = (y - f.dy) / f.s;
      const s = d.elementFromPoint(x, y);
      if (!s) break;
      e = s;
    }
    return e;
  };
  // A box of the element's own frame, in the top viewport, cut to every frame's view on the way up.
  const toTop = (el, r) => {
    let { left, top, right, bottom } = r;
    for (let w = el.ownerDocument.defaultView, i = 0; w && i < 8; i++) {
      left = Math.max(0, left); top = Math.max(0, top);
      right = Math.min(w.innerWidth, right); bottom = Math.min(w.innerHeight, bottom);
      const f = w.frameElement;
      if (!f) return { left, top, right, bottom };
      const { dx, dy, s } = frameBox(f);
      left = dx + left * s; right = dx + right * s; top = dy + top * s; bottom = dy + bottom * s;
      w = f.ownerDocument.defaultView;
    }
    return null;
  };
  // The part of the element in view, and a point there where it's on top (top viewport CSS px).
  const place = (el) => {
    if (!el.isConnected) return null;
    for (const r of el.getClientRects()) {
      const b = toTop(el, r);
      if (!b) continue;
      const { left, top, right, bottom } = b;
      if (right - left < 3 || bottom - top < 3) continue;
      const cx = (left + right) / 2, cy = (top + bottom) / 2;
      const pts = [[cx, cy], [left + 2, top + 2], [right - 2, top + 2], [left + 2, bottom - 2], [right - 2, bottom - 2], [cx, top + 2], [left + 2, cy]];
      for (const [x, y] of pts) if (owns(el, hitAt(x, y))) return { x, y, left, top, width: right - left, height: bottom - top };
    }
    return null;
  };
  const isLink = (el) => (el.tagName === 'A' || el.tagName === 'AREA') && !!el.href;
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
  // The labels on screen, and whose (the slot that drew them).
  let host = null, owner = null, spans = [];
  const takeDown = () => { if (host) host.remove(); host = null; owner = null; spans = []; };
  const api = {
    collect(slot, max) {
      const found = [];
      const walk = (root, depth) => {
        const tw = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        for (let n = tw.nextNode(); n; n = tw.nextNode()) {
          if (n.matches(SEL)) found.push(n);
          if (n.shadowRoot) walk(n.shadowRoot, depth);
          if ((n.tagName === 'IFRAME' || n.tagName === 'FRAME') && depth < 3) {
            const d = inner(n);
            if (d && d.documentElement) walk(d.documentElement, depth + 1);
          }
        }
      };
      if (document.documentElement) walk(document.documentElement, 0);
      const cand = new Set(found);
      const items = [];
      for (const el of found) {
        if (items.length >= max) break;
        if (el === el.ownerDocument.body || el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true') continue;
        // Something clickable inside another (a span with a tabindex in a link): the outer one is enough.
        if (!NATIVE.has(el.tagName)) {
          let nested = false;
          for (let n = el.parentNode || el.host; n && !nested; n = n.parentNode || n.host) nested = cand.has(n);
          if (nested) continue;
        }
        const p = place(el);
        if (p) items.push({ el, p });
      }
      sets[slot] = items.map((i) => i.el);
      return items.map(({ el, p }) => ({ x: Math.round(p.x), y: Math.round(p.y), left: Math.round(p.left), top: Math.round(p.top),
        width: Math.round(p.width), height: Math.round(p.height), tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || '', text: nameOf(el), href: isLink(el) ? String(el.href) : '', link: isLink(el) }));
    },
    elements(slot) { return sets[slot] || []; },
    draw(slot, labels, fontPx) {
      takeDown();
      const els = sets[slot] || [];
      owner = slot;
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
    narrow(slot, typed) {
      if (owner !== slot) return;
      for (const { s, label } of spans) {
        const on = label.startsWith(typed);
        s.style.setProperty('display', on ? 'block' : 'none', 'important');
        if (!on) continue;
        s.textContent = '';
        if (typed) {
          const done = document.createElement('span');
          done.style.setProperty('opacity', '0.4', 'important');
          done.textContent = typed;
          s.appendChild(done);
        }
        s.appendChild(document.createTextNode(label.slice(typed.length)));
      }
    },
    // Takes the slot's labels down; where to click its element i now (null: it's gone or covered).
    target(slot, i) {
      if (owner === slot) takeDown();
      const el = (sets[slot] || [])[i];
      delete sets[slot];
      const p = el && place(el);
      return p ? { x: p.x, y: p.y, link: isLink(el) } : null;
    },
    clear(slot) { if (owner === slot) takeDown(); delete sets[slot]; },
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

let slots = 0;

/**
 * One listing of a page's hints (the person's, or an agent's), in an
 * isolated world of its main frame, made once and kept on the page (made
 * again after it loads a new document).
 */
export class PageHints {
  /** This listing's own slot in the world (see INSTALL). */
  private slot = `s${++slots}`;

  constructor(
    private send: Send,
    private page: HintTarget,
  ) {}

  private get sid(): string {
    return this.page.sessionId;
  }

  /** Calls `__termiumHints[fn](slot, ...args)` in the world; with `install`, makes the world (and its script) first if needed. */
  private async call(fn: string, args: unknown[], install: boolean, byValue = true): Promise<any> {
    const expr = `__termiumHints.${fn}(${[this.slot, ...args].map((a) => JSON.stringify(a)).join(", ")})`;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.page.hintWorld == null) {
        if (!install) return null;
        const w = await this.send("Page.createIsolatedWorld", { frameId: this.page.targetId, worldName: "termium-hints" }, this.sid);
        this.page.hintWorld = w.executionContextId as number;
      }
      const r = await this.send(
        "Runtime.evaluate",
        { expression: install ? `${INSTALL}, ${expr}` : expr, contextId: this.page.hintWorld, returnByValue: byValue, objectGroup: this.slot },
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
  async collect(): Promise<HintInfo[]> {
    return ((await this.call("collect", [MAX_HINTS], true)) ?? []) as HintInfo[];
  }

  /** Draws labels for the elements collected (replacing any others'); how many could be drawn. */
  async draw(labels: string[], fontPx: number): Promise<number> {
    return Number(await this.call("draw", [labels, fontPx], false)) || 0;
  }

  /** Shows only the labels starting with `typed`, its letters dimmed. */
  async narrow(typed: string): Promise<void> {
    await this.call("narrow", [typed], false).catch(() => {});
  }

  /** Takes the labels down; where to click element `i` now (null: gone, covered or scrolled away). */
  async target(i: number): Promise<{ x: number; y: number; link: boolean } | null> {
    return ((await this.call("target", [i], false).catch(() => null)) ?? null) as { x: number; y: number; link: boolean } | null;
  }

  /** Forgets this listing (and takes its labels down, if they're the ones up). */
  async clear(): Promise<void> {
    await this.call("clear", [], false).catch(() => {});
  }

  /** The backend node ids of the elements collected, in order (0 where one can't be had). */
  async nodes(): Promise<number[]> {
    const arr = await this.call("elements", [], false, false);
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
      this.send("Runtime.releaseObjectGroup", { objectGroup: this.slot }, this.sid).catch(() => {});
    }
  }
}

/** The label size in CSS px for a pane: about a terminal row tall on screen, whatever the zoom. */
export function hintFontPx(cellH: number, dsf: number): number {
  return Math.max(8, Math.round((cellH / Math.max(0.25, dsf)) * 0.7));
}
