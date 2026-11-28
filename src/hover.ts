// Hover and press feedback for termium's own clickable chrome: tabs, the
// "+" buttons, sidebar rows, the address bar's buttons, pane titles.
//
// Each chrome redraw records the clickable spans it draws (zones). The
// terminal reports pointer motion (mode 1003); on each move only the spans
// whose look changes are redrawn, so a move within one span or over nothing
// clickable writes nothing at all. A status line (#15) can follow the zone
// under the pointer through onChange.

import { width } from "./text";

/** A clickable span of chrome, recorded as it is drawn. */
export interface Zone {
  /** Stable name ("tab:2", "nav:back", …), the same across redraws. */
  id: string;
  row: number;
  /** First column (1-based). */
  col: number;
  /** Columns it covers. */
  width: number;
  /**
   * What it shows: text, with only foreground/bold SGR inside (no backgrounds).
   * A color inside stays when hovered; the style's own text color gives way to
   * the hover's.
   */
  text: string;
  /** The SGR it is normally drawn with, background included. */
  style: string;
  /** Its normal background already is the hover color (a focused pane title, say): hover lifts it further. */
  lit?: boolean;
  /** What a click does, for a status line. */
  hint?: string;
}

export type ZoneState = "hover" | "press";

/** SGR prefixes for the two states. */
export interface HoverStyles {
  /** Background (and text color) over a hovered span. */
  hover: string;
  /** Background over a hovered span whose background is the hover color already. */
  hoverLit: string;
  /** Background and text color while a click flashes. */
  press: string;
}

const SGR = /\x1b\[[0-9;:]*m/g;
const RESET = "\x1b[0m";
/** OSC 22: a hand over clickable chrome (kitty, Ghostty, foot; ignored elsewhere). */
export const POINTER_HAND = "\x1b]22;pointer\x1b\\";
/**
 * Back to the usual pointer: "default" (Ghostty takes names only), then the
 * empty reset, which in kitty and foot also brings back a pointer shape the
 * user configured.
 */
export const POINTER_RESET = "\x1b]22;default\x1b\\\x1b]22;\x1b\\";
/** How long a click's flash lasts. */
export const PRESS_MS = 120;

/** The escapes that draw `z` in `state` (or as normal), cursor left after it. */
export function paintZone(z: Zone, state: ZoneState | null, styles: HoverStyles): string {
  const go = `\x1b[${z.row};${z.col}H`;
  if (state === "press") return go + z.style + styles.press + z.text.replace(SGR, "") + RESET;
  if (state === "hover") return go + z.style + (z.lit ? styles.hoverLit : styles.hover) + z.text + RESET;
  return go + z.style + z.text + RESET;
}

export class Hover {
  private zones: Zone[] = [];
  /** Where the pointer is (cell), or null when it isn't over the chrome as far as we know. */
  private pointer: { col: number; row: number } | null = null;
  /** The zone flashing after a click, by id, until its timer ends. */
  private pressed: string | null = null;
  private pressTimer: ReturnType<typeof setTimeout> | null = null;
  /** Spans drawn in a state other than normal right now. */
  private shown = new Map<string, { zone: Zone; state: ZoneState }>();
  private hand = false;
  private notified: Zone | null = null;
  private listeners: ((zone: Zone | null) => void)[] = [];

  /**
   * @param write draws a (small) update now; returns false when there's
   *   nothing to draw on (no terminal attached), and the update is dropped.
   */
  constructor(
    private write: (s: string) => boolean,
    private styles: () => HoverStyles,
    private pressMs = PRESS_MS,
  ) {}

  /** Calls `fn` with the zone under the pointer whenever it changes (null: none). */
  onChange(fn: (zone: Zone | null) => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((f) => f !== fn);
    };
  }

  /** The zone under the pointer. */
  get current(): Zone | null {
    return this.pointer ? this.at(this.pointer.col, this.pointer.row) ?? null : null;
  }

  at(col: number, row: number): Zone | undefined {
    return this.zones.find((z) => z.row === row && col >= z.col && col < z.col + z.width);
  }

  /** A chrome redraw starts: its zones are recorded afresh as it draws. */
  begin(): void {
    this.zones = [];
  }

  /** Records a clickable span the redraw drew. Its width defaults to the text's. */
  add(zone: Omit<Zone, "width"> & { width?: number }): void {
    const w = zone.width ?? width(zone.text.replace(SGR, ""));
    if (w > 0) this.zones.push({ ...zone, width: w });
  }

  /**
   * A chrome redraw ends (having drawn every span as normal): returns what
   * draws the hovered and pressed spans over it. `live` false: nothing is
   * clickable now (an overlay covers the chrome's meaning).
   */
  end(live = true): string {
    if (!live) this.zones = [];
    this.shown.clear();
    return this.update();
  }

  /** The pointer moved to a cell (any cell: off the chrome is just no zone). */
  move(col: number, row: number): void {
    this.pointer = { col, row };
    this.flush();
  }

  /** The pointer left the chrome's reach (it's over a page that holds it). */
  leave(): void {
    if (!this.pointer) return;
    this.pointer = null;
    this.flush();
  }

  /** Flashes `zone` (the one clicked) for a moment. */
  press(zone: Zone | undefined): void {
    if (!zone) return;
    if (this.pressTimer) clearTimeout(this.pressTimer);
    this.pressed = zone.id;
    this.pressTimer = setTimeout(() => {
      this.pressTimer = null;
      this.pressed = null;
      this.flush();
    }, this.pressMs);
    this.flush();
  }

  /** The terminal changed (attached, detached): forget what it shows. */
  reset(): void {
    if (this.pressTimer) clearTimeout(this.pressTimer);
    this.pressTimer = null;
    this.pressed = null;
    this.pointer = null;
    this.shown.clear();
    this.hand = false;
    this.notify(null);
  }

  private flush(): void {
    const s = this.update();
    if (s && !this.write(s)) {
      // Not drawn: the next redraw puts everything right.
      this.shown.clear();
      this.hand = false;
    }
  }

  /** Brings the spans' look (and the pointer shape) up to date; returns the escapes for it. */
  private update(): string {
    const want = new Map<string, { zone: Zone; state: ZoneState }>();
    const hovered = this.current;
    const pressed = this.pressed ? this.zones.find((z) => z.id === this.pressed) : undefined;
    if (hovered) want.set(hovered.id, { zone: hovered, state: "hover" });
    if (pressed) want.set(pressed.id, { zone: pressed, state: "press" });
    const styles = this.styles();
    let s = "";
    // Spans going back to normal first: spans never overlap, so the order is free otherwise.
    for (const [id, was] of this.shown) {
      if (want.get(id)?.state !== was.state || want.get(id)?.zone !== was.zone) {
        if (!want.has(id)) s += paintZone(was.zone, null, styles);
        this.shown.delete(id);
      }
    }
    for (const [id, now] of want) {
      if (this.shown.has(id)) continue;
      s += paintZone(now.zone, now.state, styles);
      this.shown.set(id, now);
    }
    if (!!hovered !== this.hand) {
      this.hand = !!hovered;
      s += hovered ? POINTER_HAND : POINTER_RESET;
    }
    this.notify(hovered);
    return s;
  }

  private notify(zone: Zone | null): void {
    const was = this.notified;
    if (was === zone || (was && zone && was.id === zone.id && was.hint === zone.hint)) {
      this.notified = zone;
      return;
    }
    this.notified = zone;
    for (const fn of this.listeners) fn(zone);
  }
}
