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
const MAX_CACHED = 200;

/** Icons of a page tried in turn, at most. */
const MAX_TRIES = 4;

/**
 * Run in an isolated world of the page (its scripts can't interfere): the
 * page's <link rel=icon>s, best first, then /favicon.ico for http(s)
 * pages. An SVG (sizes="any") comes first; then the smallest bitmap of
 * 32px or more, then bigger-is-better smaller ones; on a tie the later
 * link, as browsers do. The later ones stand in when one can't be shown
 * (an SVG on a page whose CSP keeps images to its own origin, say).
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
  if (/^https?:$/.test(location.protocol)) hrefs.push(location.origin + "/favicon.ico");
  return [...new Set(hrefs)];
})()`;

/**
 * Also in the isolated world: decodes the icon's bytes and draws it centred
 * in a w x h canvas, `side` px across at most; returns the PNG as base64.
 * Small bitmaps are scaled by whole steps without smoothing, so they stay
 * crisp; bigger ones (and SVG) are scaled down smoothly.
 */
const RENDER = `async function (b64, type, w, h, side) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type });
  let src, iw, ih;
  try {
    src = await createImageBitmap(blob);
    iw = src.width; ih = src.height;
  } catch {
    // SVG: createImageBitmap won't take it from a blob.
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      src = img; iw = img.naturalWidth || side; ih = img.naturalHeight || side;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  if (!iw || !ih) return null;
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

function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_CACHED) map.delete(map.keys().next().value!);
}

/** The bytes of a data: URL, or null. */
export function parseDataUrl(url: string): { data: string; type: string } | null {
  const m = url.match(/^data:([^,]*?)(;base64)?,(.*)$/is);
  if (!m) return null;
  const type = m[1]!.split(";")[0]!.trim() || "image/png";
  try {
    const buf = m[2] ? Buffer.from(m[3]!, "base64") : Buffer.from(decodeURIComponent(m[3]!), "utf8");
    return buf.length && buf.length <= MAX_BYTES ? { data: buf.toString("base64"), type } : null;
  } catch {
    return null;
  }
}

/** Finds, fetches and renders pages' icons, and caches them by icon URL. */
export class Favicons {
  /** Each page's icon URL, once it rendered (null: it has none). */
  private iconOf = new WeakMap<IconPage, string | null>();
  /** Lookups started per page: only the latest one's answer counts. */
  private gen = new WeakMap<IconPage, number>();
  /** Rendered PNGs (base64) per "URL WxH". */
  private rendered = new Map<string, string>();
  private pending = new Set<string>();

  constructor(
    private cdp: CDP,
    private changed: () => void,
  ) {}

  /** Looks up the page's icon again (its document finished loading). */
  async refresh(page: IconPage, w: number, h: number): Promise<void> {
    const g = (this.gen.get(page) ?? 0) + 1;
    this.gen.set(page, g);
    let url: string | null = null;
    try {
      const ctx = await this.world(page);
      const { result } = await this.cdp.send("Runtime.evaluate", { expression: FIND, contextId: ctx, returnByValue: true }, page.sessionId);
      const found: unknown[] = Array.isArray(result?.value) ? result.value : [];
      for (const href of found.slice(0, MAX_TRIES)) {
        if (typeof href !== "string" || this.gen.get(page) !== g) break;
        // One that can't be fetched or decoded: the next.
        if (await this.render(page, href, w, h).catch(() => null)) {
          url = href;
          break;
        }
      }
    } catch {
      // Gone, navigating away, or the page refused: no icon.
    }
    if (this.gen.get(page) !== g) return;
    const before = this.iconOf.get(page);
    this.iconOf.set(page, url);
    if (before !== url) this.changed();
  }

  /**
   * The page's icon as a w x h PNG (base64), and a key that names it; null
   * when it has none, or while it's being rendered at this size.
   */
  icon(page: IconPage, w: number, h: number): { key: string; png: string } | null {
    const url = this.iconOf.get(page);
    if (!url) return null;
    const key = `${url} ${w}x${h}`;
    const png = this.rendered.get(key);
    if (png) return { key, png };
    // A new cell size: render again, and redraw once that's done.
    if (!this.pending.has(key)) {
      this.pending.add(key);
      void this.render(page, url, w, h)
        .then((p) => p && this.changed(), () => {})
        .finally(() => this.pending.delete(key));
    }
    return null;
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
    const key = `${url} ${w}x${h}`;
    const hit = this.rendered.get(key);
    if (hit) return hit;
    const src = await this.source(page, url);
    if (!src) return null;
    const side = Math.max(8, Math.round(Math.min(w, h) * 0.85));
    const { result } = await this.cdp.send(
      "Runtime.callFunctionOn",
      {
        functionDeclaration: RENDER,
        executionContextId: await this.world(page),
        arguments: [{ value: src.data }, { value: src.type }, { value: w }, { value: h }, { value: side }],
        returnByValue: true,
        awaitPromise: true,
      },
      page.sessionId,
    );
    const png = typeof result?.value === "string" && result.value ? result.value : null;
    if (png) remember(this.rendered, key, png);
    return png;
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
