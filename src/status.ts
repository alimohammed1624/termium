// The address row as a status line (#15): where a hovered link goes, and,
// after a pause over a chrome control, what it does and its keybind.

import { truncate, width } from "./text";

/** How long the pointer rests on a control before its hint shows. */
export const HINT_DELAY_MS = 400;
/** Right after a hint goes, the next control's shows at once (moving along the tabs, say). */
export const HINT_WARM_MS = 500;
/**
 * JS that finds the link at (x, y) (CSS pixels) of the document it runs in,
 * through shadow roots and same-process frames: its URL ("" for none). Over
 * a frame it can't reach into (another origin), the point inside that
 * frame as [x, y], or, with `element`, the frame's element itself.
 */
export function linkAt(x: number, y: number, element = false): string {
  return `(() => {
  let d = document, x = ${+x || 0}, y = ${+y || 0};
  for (let hops = 0; hops < 16; hops++) {
    let e = d.elementFromPoint(x, y);
    while (e && e.shadowRoot) {
      const inner = e.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === e) break;
      e = inner;
    }
    if (!e) return "";
    if (e.localName === "iframe" || e.localName === "frame") {
      // Into the frame's own coordinates: past its border and padding, undoing a scale.
      const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
      const sx = e.offsetWidth ? r.width / e.offsetWidth : 1, sy = e.offsetHeight ? r.height / e.offsetHeight : 1;
      x = (x - r.left) / (sx || 1) - e.clientLeft - (parseFloat(cs.paddingLeft) || 0);
      y = (y - r.top) / (sy || 1) - e.clientTop - (parseFloat(cs.paddingTop) || 0);
      let inner = null;
      try { inner = e.contentDocument; } catch {}
      if (inner) { d = inner; continue; }
      return ${element ? "e" : "[x, y]"};
    }
    for (let n = e; n; n = n.parentElement || (n.parentNode && n.parentNode.host) || null) {
      if ((n.localName === "a" || n.localName === "area") && n.hasAttribute("href")) {
        const h = n.href;
        try { return typeof h === "string" ? h : new URL(h.baseVal, n.baseURI).href; } catch { return ""; }
      }
    }
    return "";
  }
  return "";
})()`;
}

/** A link's URL in parts: what comes before the host, the host, the rest. */
export function splitLink(url: string): { lead: string; host: string; rest: string } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { lead: "", host: "", rest: url };
  }
  if (!u.host) {
    // mailto:, javascript:, data:…: the scheme dim, the rest as the "host".
    const rest = url.slice(u.protocol.length);
    return { lead: u.protocol, host: rest, rest: "" };
  }
  // https:// is left out, as in the address itself.
  const lead = u.protocol === "https:" ? "" : `${u.protocol}//`;
  const at = url.indexOf(u.host, u.protocol.length);
  const rest = at >= 0 ? url.slice(at + u.host.length) : u.pathname + u.search + u.hash;
  return { lead, host: u.host, rest };
}

/**
 * A link's URL in `w` columns: host bright, the rest dim. A long path is
 * cut at its end, so the host stays in view.
 */
export function linkText(url: string, w: number, bright: string, dim: string): string {
  const { lead, host, rest } = splitLink(url.replace(/[\x00-\x1f\x7f]/g, ""));
  const leadT = truncate(lead, w);
  const hostT = truncate(host, w - width(leadT));
  const restT = truncate(rest, w - width(leadT) - width(hostT));
  const used = width(leadT) + width(hostT) + width(restT);
  return dim + leadT + bright + hostT + dim + restT + " ".repeat(Math.max(0, w - used));
}

/** A hint in `w` columns: the action bright, its keybind in the key color. */
export function hintText(hint: string, w: number, bright: string, key: string): string {
  const cut = hint.lastIndexOf("  ");
  const label = cut >= 0 ? hint.slice(0, cut) : hint;
  const keys = cut >= 0 ? hint.slice(cut) : "";
  // Short of room, the keybind stays and the action is cut (a keybind that doesn't fit whole is left out).
  const keysT = width(keys) <= w ? keys : width(keys.trimStart()) <= w ? keys.trimStart() : "";
  const room = w - width(keysT);
  const labelT = room >= 3 || !keysT ? truncate(label, room) : "";
  return bright + labelT + key + keysT + " ".repeat(Math.max(0, w - width(labelT) - width(keysT)));
}

/**
 * The key for `desc` in a help table (rows of [keys, description]; a row
 * like ["Ctrl+B then…", ""] prefixes the rows after it), as hints show it:
 * alternative `alt` of "A / B", Ctrl+ written ^. "" when it isn't there.
 */
export function helpKey(help: readonly (readonly [string, string])[], desc: string, alt = 0): string {
  let lead = "";
  for (const [keys, d] of help) {
    if (!keys && !d) lead = "";
    else if (!d && keys.endsWith(" then…")) lead = keys.slice(0, -" then…".length);
    else if (d === desc) {
      const k = keys.split(" / ")[alt] ?? "";
      if (!k) return "";
      return (lead ? `${lead} ${k}` : k).replace(/Ctrl\+/g, "^");
    }
  }
  return "";
}
