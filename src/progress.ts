// The loading bar under the address line: eased toward 95% while a page
// loads, filled when it finishes, held a moment, then faded out. Everything
// here is a pure function of the time, so a page in the background needs no
// timer: its bar is worked out again whenever it's shown.

/** While loading, the bar never passes this. */
export const LOADING_CAP = 0.95;
/** Time constant of the ease toward the cap before the document has been parsed (ms). */
export const TRICKLE_MS = 3000;
/** The same once DOMContentLoaded has fired: the rest is subresources, so it hurries. */
export const TRICKLE_PARSED_MS = 900;
/** A finished load fills the rest of the bar over this long. */
export const FILL_MS = 150;
/** Then stays full this long… */
export const HOLD_MS = 200;
/** …and fades out over this long. */
export const FADE_MS = 250;
/** The stop button stays up at least this long after a load starts, so a fast load doesn't flicker it. */
export const MIN_STOP_MS = 250;

export interface Load {
  /** When the load started. */
  start: number;
  /** The ease toward the cap restarts from `base` at `since` with time constant `tau`. */
  since: number;
  base: number;
  tau: number;
  /** When it finished (0 while loading), and how far the bar had got then. */
  end: number;
  from: number;
}

/** What the bar shows: how much of the width is filled (0-1), and how opaque it is (0-1). */
export interface Bar {
  fill: number;
  alpha: number;
}

function eased(l: Load, now: number): number {
  const cap = Math.max(LOADING_CAP, l.base);
  return cap - (cap - l.base) * Math.exp(-Math.max(0, now - l.since) / l.tau);
}

/** The bar of `l` at `now`; null once it has faded out (or there is no load). */
export function bar(l: Load | undefined, now: number): Bar | null {
  if (!l) return null;
  if (!l.end) return { fill: eased(l, now), alpha: 1 };
  const t = now - l.end;
  if (t < FILL_MS) {
    const k = 1 - (1 - t / FILL_MS) ** 2; // ease out
    return { fill: l.from + (1 - l.from) * k, alpha: 1 };
  }
  if (t < FILL_MS + HOLD_MS) return { fill: 1, alpha: 1 };
  if (t < FILL_MS + HOLD_MS + FADE_MS) return { fill: 1, alpha: 1 - (t - FILL_MS - HOLD_MS) / FADE_MS };
  return null;
}

/**
 * A load starts at `now`. One already running carries on. One that ended
 * so recently its bar is still filling (a redirect, or a stop and start of
 * the same navigation) picks up from where the bar is, rather than jumping
 * back to empty; otherwise the bar starts again from nothing.
 */
export function started(l: Load | undefined, now: number): Load {
  if (l && !l.end) return l;
  if (l && now - l.end < FILL_MS) {
    const fill = bar(l, now)!.fill;
    return { start: l.start, since: now, base: fill, tau: TRICKLE_MS, end: 0, from: 0 };
  }
  return { start: now, since: now, base: 0, tau: TRICKLE_MS, end: 0, from: 0 };
}

/** The document has been parsed: the bar hurries on from where it is (no jump). */
export function parsed(l: Load | undefined, now: number): Load | undefined {
  if (!l || l.end || l.tau === TRICKLE_PARSED_MS) return l;
  return { ...l, since: now, base: eased(l, now), tau: TRICKLE_PARSED_MS };
}

/** The load finished at `now`: the bar fills from where it is. */
export function finished(l: Load | undefined, now: number): Load | undefined {
  if (!l || l.end) return l;
  return { ...l, end: now, from: eased(l, now) };
}

/** Whether the stop button still shows for a load that has finished (see MIN_STOP_MS). */
export function holdsStop(l: Load | undefined, now: number): boolean {
  return !!l && now - l.start < MIN_STOP_MS;
}

/** Mixes two "rrggbb" colours: `t` = 0 gives `a`, 1 gives `b`. */
export function mix(a: string, b: string, t: number): string {
  const c = (hex: string, i: number) => parseInt(hex.slice(i, i + 2), 16);
  return [0, 2, 4].map((i) => Math.round(c(a, i) + (c(b, i) - c(a, i)) * t).toString(16).padStart(2, "0")).join("");
}

const segmenter = new Intl.Segmenter();
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/y;

/**
 * Underlines the first `cells` columns of `line` (text and CSI sequences,
 * as the chrome draws a row) in colour `hex`. SGR resets in that span
 * would end the underline, so it's put back after each one. A wide
 * character the edge cuts through is underlined whole.
 */
export function underline(line: string, cells: number, hex: string): string {
  if (cells <= 0) return line;
  const rgb = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(":");
  const on = `\x1b[4m\x1b[58:2::${rgb}m`;
  const off = "\x1b[24m\x1b[59m";
  let out = "";
  let col = 0;
  let underlined = false;
  let text = "";
  const flush = () => {
    for (const { segment } of segmenter.segment(text)) {
      if (col < cells && !underlined) {
        out += on;
        underlined = true;
      } else if (col >= cells && underlined) {
        out += off;
        underlined = false;
      }
      out += segment;
      col += Bun.stringWidth(segment);
    }
    text = "";
  };
  for (let i = 0; i < line.length; ) {
    CSI.lastIndex = i;
    const m = line[i] === "\x1b" ? CSI.exec(line) : null;
    if (!m) {
      text += line[i++];
      continue;
    }
    flush();
    out += m[0];
    i += m[0].length;
    // A style change (a reset most of all) may have ended it.
    if (m[0].endsWith("m") && col < cells) {
      out += on;
      underlined = true;
    }
  }
  flush();
  return underlined ? out + off : out;
}
