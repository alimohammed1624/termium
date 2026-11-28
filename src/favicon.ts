// Site icons for the tab bar and the sidebar. The page's own browser finds,
// fetches and decodes the icon (so png, ico and svg all work, with the
// page's cookies), scaled to the exact pixel size of two cells; termium
// places it as a small kitty graphics picture. Where pictures can't go
// (through tmux), a dot in a colour taken from the site's host stands in.

import type { CDP } from "./cdp";
import { drawImage } from "./terminal";

/** What Favicons needs of a page. */
export interface IconPage {
  targetId: string;
  sessionId: string;
}

/** Icons bigger than this aren't icons. */
const MAX_BYTES = 512 * 1024;

/** Icons of a page tried in turn, at most (/favicon.ico always among them). */
const MAX_TRIES = 4;
/** How long one icon may take: one that never comes mustn't hold up the next. */
const TRY_MS = 4000;
/**
 * An icon that took too long isn't asked for again for this long: its
 * request can't be cancelled, and each would hold a connection to its host.
 */
const STALLED_MS = 60_000;

/**
 * Run in an isolated world of the page (its scripts can't interfere): the
 * page's site, and its <link rel=icon>s, best first, then /favicon.ico for
 * http(s) pages. An SVG (sizes="any") comes first; then the smallest
 * bitmap of 32px or more, then bigger-is-better smaller ones; on a tie the
 * later link, as browsers do. The later ones stand in when one can't be
 * shown (an SVG on a page whose CSP keeps images to its own origin, say).
 */
const FIND = `(() => {
  const found = [];
  let i = 0;
  for (const l of document.querySelectorAll('link[rel~="icon" i]')) {
    const href = l.href;
    if (!href || !/^(https?|data|file):/i.test(href)) continue;
    const sizes = (l.getAttribute("sizes") || "").toLowerCase();
    const svg = /svg/i.test(l.type) || /\\.svg([?#]|$)/i.test(href) || /(^|\\s)any(\\s|$)/.test(sizes);
    const px = Math.max(0, ...sizes.split(/\\s+/).map((s) => parseInt(s, 10) || 0));
    found.push({ href, score: svg ? 2000 : px >= 32 ? 1900 - px : px > 0 ? 1000 + px : 500, i: i++ });
  }
  const hrefs = found.sort((a, b) => b.score - a.score || b.i - a.i).map((f) => f.href);
  const fallback = /^https?:$/.test(location.protocol) ? location.origin + "/favicon.ico" : null;
  return { href: location.href, hrefs: [...new Set(hrefs)], fallback };
})()`;

/**
 * Also in the isolated world: decodes the icon's bytes and draws it centred
 * in a w x h canvas, `side` px across at most; returns the PNG as base64.
 * Small bitmaps are scaled by whole steps without smoothing, so they stay
 * crisp; bigger ones (and SVG) are scaled down smoothly.
 */
const RENDER = `async function (b64, type, w, h, side, url) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type });
  let src, iw, ih;
  try {
    src = await createImageBitmap(blob);
    iw = src.width; ih = src.height;
  } catch {
    // SVG: createImageBitmap won't take it from a blob. An <img> will, as a
    // blob: or data: URL, or from its own address: whichever the page's
    // CSP allows (one of another origin taints the canvas: no icon).
    const blobUrl = URL.createObjectURL(blob);
    try {
      for (const s of [blobUrl, "data:" + type + ";base64," + b64, /^(https?|file):/i.test(url) ? url : ""]) {
        if (!s) continue;
        const img = new Image();
        img.src = s;
        try { await img.decode(); } catch { continue; }
        src = img; iw = img.naturalWidth || side; ih = img.naturalHeight || side;
        break;
      }
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }
  if (!src || !iw || !ih) return null;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d");
  const big = Math.max(iw, ih);
  const vector = /svg/i.test(type);
  let k = side / big;
  if (!vector && big <= side) { k = Math.floor(side / big); g.imageSmoothingEnabled = false; }
  else g.imageSmoothingQuality = "high";
  const dw = Math.round(iw * k), dh = Math.round(ih * k);
  g.drawImage(src, Math.floor((w - dw) / 2), Math.floor((h - dh) / 2), dw, dh);
  return c.toDataURL("image/png").replace(/^data:image\\/png;base64,/, "");
}`;

/** The bytes of a data: URL, or null. */
export function parseDataUrl(url: string): { data: string; type: string } | null {
  const m = url.match(/^data:([^,]*?)(;base64)?,(.*)$/is);
  if (!m) return null;
  const type = m[1]!.split(";")[0]!.trim() || "image/png";
  try {
    let buf: Buffer;
    if (m[2]) {
      buf = Buffer.from(decodeURIComponent(m[3]!), "base64");
    } else {
      // %XX are bytes (binary data may be percent-encoded); other text is UTF-8.
      const parts: Buffer[] = [];
      for (const [, hex, text] of m[3]!.matchAll(/%([0-9a-f]{2})|([^%]+|%)/gi)) {
        parts.push(hex ? Buffer.from([parseInt(hex, 16)]) : Buffer.from(text!, "utf8"));
      }
      buf = Buffer.concat(parts);
    }
    return buf.length && buf.length <= MAX_BYTES ? { data: buf.toString("base64"), type } : null;
  } catch {
    return null;
  }
}

/** The site of an address (its scheme and host): an icon belongs to one. */
function siteOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "";
  }
}

/** A page's icon, rendered: for the pages of `site` only. */
interface Icon {
  site: string;
  url: string;
  png: string;
  w: number;
  h: number;
  /** Names these very pixels (IconLayer replaces a picture when it changes). */
  serial: number;
}

interface PageIcons {
  /** Lookups started: only the latest one's answer counts. */
  gen: number;
  /** A lookup is under way. */
  busy: boolean;
  /** The page may have changed its icon links during that lookup: look again after it. */
  again?: boolean;
  /** The candidates the last lookup found (a change means the page swapped its icon). */
  candidates?: string;
  icon: Icon | null;
  /** A render at another cell size, under way. */
  resizing?: string;
}

/**
 * Finds, fetches and renders each page's icon. Each page keeps its own (an
 * icon at the same address can change, as a site's unread count does), and
 * shows it only while it's still on the site it came from.
 */
export class Favicons {
  private pages = new WeakMap<IconPage, PageIcons>();
  private serial = 0;
  /** Icons that took too long, and until when they're skipped. */
  private stalled = new Map<string, number>();

  constructor(
    private cdp: CDP,
    private changed: () => void,
  ) {}

  private state(page: IconPage): PageIcons {
    let st = this.pages.get(page);
    if (!st) this.pages.set(page, (st = { gen: 0, busy: false, icon: null }));
    return st;
  }

  /** Looks up the page's icon again (its document finished loading). */
  async refresh(page: IconPage, w: number, h: number): Promise<void> {
    const st = this.state(page);
    const g = ++st.gen;
    st.busy = true;
    let icon: Icon | null = null;
    try {
      const found = await this.find(page);
      if (found && st.gen === g) {
        st.candidates = found.key;
        // The page no longer links the icon shown: a dot until its own is ready.
        if (st.icon && !found.hrefs.includes(st.icon.url) && found.fallback !== st.icon.url) {
          st.icon = null;
          this.changed();
        }
        // The best links, and /favicon.ico in any case.
        const tries = found.hrefs.slice(0, MAX_TRIES);
        if (found.fallback && !tries.includes(found.fallback)) {
          if (tries.length === MAX_TRIES) tries.pop();
          tries.push(found.fallback);
        }
        const now = Date.now();
        for (const [url, until] of this.stalled) if (until <= now) this.stalled.delete(url);
        for (const url of tries) {
          if (st.gen !== g) break;
          if (this.stalled.has(url)) continue;
          // One that can't be fetched or decoded (or takes too long): the next.
          let timer: ReturnType<typeof setTimeout> | undefined;
          let late = false;
          const png = await Promise.race([
            this.render(page, url, w, h).catch(() => null),
            new Promise<null>((r) => (timer = setTimeout(() => ((late = true), r(null)), TRY_MS))),
          ]);
          clearTimeout(timer);
          if (late) this.stalled.set(url, Date.now() + STALLED_MS);
          if (png) {
            icon = { site: siteOf(found.href), url, png, w, h, serial: ++this.serial };
            break;
          }
        }
      }
    } catch {
      // Gone, navigating away, or the page refused: no icon.
    }
    if (st.gen !== g) return;
    st.busy = false;
    const before = st.icon;
    st.icon = icon;
    if (before || icon) this.changed();
    if (st.again) {
      st.again = false;
      void this.recheck(page, w, h);
    }
  }

  /** Looks up the page's icon again if it links other ones now (a script changed them). */
  async recheck(page: IconPage, w: number, h: number): Promise<void> {
    const st = this.state(page);
    if (st.busy) {
      st.again = true;
      return;
    }
    if (st.candidates === undefined) return;
    const found = await this.find(page).catch(() => null);
    if (!found) return;
    if (st.busy) st.again = true;
    else if (found.key !== st.candidates) await this.refresh(page, w, h);
  }

  /**
   * The icon of the page, now at `pageUrl`, as a w x h PNG (base64) and a
   * key naming it; null when it has none (or not yet for this site), or
   * while it's being rendered at this size.
   */
  icon(page: IconPage, pageUrl: string, w: number, h: number): { key: string; png: string } | null {
    const st = this.pages.get(page);
    const icon = st?.icon;
    if (!st || !icon || icon.site !== siteOf(pageUrl)) return null;
    if (icon.w === w && icon.h === h) return { key: String(icon.serial), png: icon.png };
    // A new cell size: render again, and redraw once that's done.
    const size = `${w}x${h}`;
    if (st.resizing !== size) {
      st.resizing = size;
      const g = st.gen;
      void this.render(page, icon.url, w, h)
        .then((png) => {
          if (!png || st.gen !== g || st.icon !== icon) return;
          st.icon = { ...icon, png, w, h, serial: ++this.serial };
          this.changed();
        }, () => {})
        .finally(() => {
          if (st.resizing === size) st.resizing = undefined;
        });
    }
    return null;
  }

  private async find(page: IconPage): Promise<{ href: string; hrefs: string[]; fallback: string | null; key: string } | null> {
    const { result } = await this.cdp.send(
      "Runtime.evaluate",
      { expression: FIND, contextId: await this.world(page), returnByValue: true },
      page.sessionId,
    );
    const v = result?.value;
    if (!v || typeof v.href !== "string" || !Array.isArray(v.hrefs)) return null;
    const hrefs = v.hrefs.filter((h: unknown): h is string => typeof h === "string");
    const fallback = typeof v.fallback === "string" ? v.fallback : null;
    return { href: v.href, hrefs, fallback, key: [...hrefs, fallback].join("\n") };
  }

  private async world(page: IconPage): Promise<number> {
    const { executionContextId } = await this.cdp.send(
      "Page.createIsolatedWorld",
      { frameId: page.targetId, worldName: "termium-icon" },
      page.sessionId,
    );
    return executionContextId;
  }

  private async render(page: IconPage, url: string, w: number, h: number): Promise<string | null> {
    const src = await this.source(page, url);
    if (!src) return null;
    const side = Math.max(8, Math.round(Math.min(w, h) * 0.85));
    const { result } = await this.cdp.send(
      "Runtime.callFunctionOn",
      {
        functionDeclaration: RENDER,
        executionContextId: await this.world(page),
        arguments: [{ value: src.data }, { value: src.type }, { value: w }, { value: h }, { value: side }, { value: url }],
        returnByValue: true,
        awaitPromise: true,
      },
      page.sessionId,
    );
    return typeof result?.value === "string" && result.value ? result.value : null;
  }

  /** The icon file, fetched by the browser for the page (its cookies, its proxy). */
  private async source(page: IconPage, url: string): Promise<{ data: string; type: string } | null> {
    if (url.startsWith("data:")) return parseDataUrl(url);
    const { resource } = await this.cdp.send(
      "Network.loadNetworkResource",
      { frameId: page.targetId, url, options: { disableCache: false, includeCredentials: true } },
      page.sessionId,
    );
    const handle: string | undefined = resource?.stream;
    try {
      const status = Number(resource?.httpStatusCode ?? 200);
      if (!resource?.success || !handle || status < 200 || status > 299) return null;
      const parts: Buffer[] = [];
      let size = 0;
      for (;;) {
        const r = await this.cdp.send("IO.read", { handle, size: 65536 }, page.sessionId);
        const chunk = Buffer.from(r.data ?? "", r.base64Encoded ? "base64" : "utf8");
        parts.push(chunk);
        size += chunk.length;
        if (size > MAX_BYTES) return null;
        if (r.eof) break;
      }
      if (!size) return null;
      const bytes = Buffer.concat(parts);
      const header = Object.entries(resource.headers ?? {}).find(([k]) => k.toLowerCase() === "content-type")?.[1];
      let type = String(header ?? "").split(";")[0]!.trim().toLowerCase();
      // Servers often get an SVG's type wrong; the decoder needs it right.
      if (/^\s*(<\?xml|<svg)/i.test(bytes.subarray(0, 256).toString("latin1"))) type = "image/svg+xml";
      return { data: bytes.toString("base64"), type: type.startsWith("image/") ? type : "" };
    } finally {
      if (handle) this.cdp.send("IO.close", { handle }, page.sessionId).catch(() => {});
    }
  }
}

/**
 * Where icons sit on screen. A picture already showing the same icon in a
 * cell is left alone: its cells aren't even rewritten (that would erase
 * it in terminals that keep pictures in their cells, such as WezTerm).
 * New pictures are placed after the text and the replaced ones deleted
 * after that, in the same synchronized update, so nothing blinks.
 */
export class IconLayer {
  private shown = new Map<string, { id: number; key: string }>();
  private next = new Map<string, { id: number; key: string }>();
  private queued = "";

  constructor(private newId: () => number) {}

  /** Starts drawing the chrome. */
  begin(): void {
    this.next = new Map();
    this.queued = "";
  }

  /**
   * Text for the `cols` cells at (row, col) that show `png` (named by
   * `key`): spaces under a new picture, or a cursor move past one that
   * already shows it.
   */
  cell(row: number, col: number, cols: number, key: string, png: string): string {
    const where = `${row},${col}`;
    const old = this.shown.get(where);
    if (old && old.key === key) {
      this.next.set(where, old);
      return `\x1b[${cols}C`;
    }
    const id = this.newId();
    this.next.set(where, { id, key });
    this.queued += drawImage(png, id, null, row, col, cols, 1);
    return " ".repeat(cols);
  }

  /** Done drawing the chrome: escapes placing the new pictures, and ids of the old ones to delete after. */
  end(): { draw: string; stale: number[] } {
    const stale: number[] = [];
    for (const [where, s] of this.shown) if (this.next.get(where)?.id !== s.id) stale.push(s.id);
    this.shown = this.next;
    this.next = new Map();
    const draw = this.queued;
    this.queued = "";
    return { draw, stale };
  }

  /** The screen was cleared (or another terminal attached): nothing is placed any more. Ids that were. */
  reset(): number[] {
    const ids = [...this.shown.values()].map((s) => s.id);
    this.shown.clear();
    return ids;
  }
}

/** The colour of a site's dot: a hue of its own (from its host), light enough for a dark bar. */
export function siteColour(url: string): string {
  let host = "";
  try {
    host = new URL(url).host || new URL(url).protocol;
  } catch {}
  let hash = 0x811c9dc5;
  for (let i = 0; i < host.length; i++) hash = Math.imul(hash ^ host.charCodeAt(i), 0x01000193);
  // Mixed once more, so hosts that differ only a little get hues far apart.
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  hash = (hash ^ (hash >>> 16)) >>> 0;
  // One of 12 hues, 30° apart: two sites either share a colour or clearly differ.
  return hsl((hash % 12) * 30, 0.65, 0.72);
}

function hsl(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(v * 255).toString(16).padStart(2, "0");
  };
  return f(0) + f(8) + f(4);
}
