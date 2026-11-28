// Terminal output: mode setup/teardown, capability queries and kitty
// graphics frame placement.

import { writeSync } from "node:fs";
import { ANSI_QUERIED } from "./theme";

const ESC = "\x1b";
const ST = `${ESC}\\`;

/** Kitty keyboard flags: disambiguate | report event types | all keys as escapes | associated text. */
export const KITTY_KBD_FLAGS = 1 | 2 | 8 | 16;

let entered = false;

/** Where out() sends terminal output; null drops it (nothing attached). */
export type Sink = (data: string, done?: () => void) => void;
let sink: Sink | null = null;

/** Inside tmux: kitty graphics escapes are wrapped in tmux's passthrough. */
let tmuxPassthrough = false;

export function setTmuxPassthrough(on: boolean): void {
  tmuxPassthrough = on;
}

/**
 * Wraps every kitty graphics escape in tmux's DCS passthrough (ESCs
 * doubled), so tmux hands it to the outer terminal instead of eating it.
 * Each escape is wrapped on its own: tmux limits the size of one sequence.
 */
export function wrapGraphics(data: string): string {
  if (!tmuxPassthrough || !data.includes(`${ESC}_G`)) return data;
  return data.replace(/\x1b_G[^\x1b]*\x1b\\/g, (m) => `${ESC}Ptmux;${m.replaceAll(ESC, ESC + ESC)}${ST}`);
}

/**
 * Ids of the pictures this terminal holds from us. Leaving, we delete just
 * these: a delete-all would also wipe other programs' pictures (another
 * tmux pane's, say).
 */
const ownImages = new Set<number>();

function trackImages(data: string): void {
  if (!data.includes(`${ESC}_G`)) return;
  for (const m of data.matchAll(/\x1b_G([^;\x1b]*)/g)) {
    const kv = Object.fromEntries(m[1]!.split(",").map((p) => p.split("=")));
    const id = Number(kv.i);
    if (kv.a === "T" || kv.a === "t") {
      if (id) ownImages.add(id);
    } else if (kv.a === "d") {
      if (kv.d === "I" || kv.d === "i") ownImages.delete(id);
      else if (kv.d === "A" || kv.d === "a") ownImages.clear();
    }
  }
}

const stdoutSink: Sink = (data, done) => {
  trackImages(data);
  data = wrapGraphics(data);
  if (done) process.stdout.write(data, () => done());
  else process.stdout.write(data);
};

/** Points out() somewhere else (the session server sends it to its client). */
export function setSink(s: Sink | null): void {
  sink = s;
}

/**
 * Queues output for the terminal without blocking the event loop. `done`
 * runs once the terminal has taken the data, which paces screencast frames.
 */
export function out(data: string, done?: () => void): void {
  if (!sink) {
    // Nothing to show it on (after restoreTerminal, or no client attached).
    done?.();
    return;
  }
  sink(data, done);
}

/** Resolves once everything queued so far has been written. */
export function drained(): Promise<void> {
  return new Promise((resolve) => process.stdout.write("", () => resolve()));
}

/** Blocking write, for the last words on the way out. */
function outSync(data: string): void {
  let buf = Buffer.from(data, "utf8");
  for (let tries = 0; buf.length > 0 && tries < 10_000; tries++) {
    try {
      buf = buf.subarray(writeSync(1, buf));
    } catch (err: any) {
      if (err?.code !== "EAGAIN") return;
    }
  }
}

export function enterTerminal(): void {
  entered = true;
  sink = stdoutSink;
  out(
    `${ESC}[?1049h` + // alternate screen
      `${ESC}[?25l` + // hide cursor
      `${ESC}[2J` +
      `${ESC}[?1003h` + // report all mouse motion
      `${ESC}[?1006h` + // SGR mouse encoding
      `${ESC}[?1016h` + // SGR pixel coordinates (Ghostty, kitty, WezTerm, foot)
      `${ESC}[?2004h` + // bracketed paste
      `${ESC}[>${KITTY_KBD_FLAGS}u`, // push kitty keyboard flags
  );
}

export function restoreTerminal(): void {
  if (!entered) return;
  entered = false;
  sink = null;
  try {
    // (ownImages is cleared below, once the deletes are written.)
    outSync(
      wrapGraphics([...ownImages].map(deleteImage).join("")) + // delete our pictures
        `${ESC}[<u` + // pop kitty keyboard flags
        `${ESC}[?2004l${ESC}[?1016l${ESC}[?1006l${ESC}[?1003l` +
        `${ESC}[0m${ESC}[0 q${ESC}[?25h` + // default cursor shape, visible
        `${ESC}]22;default${ESC}\\` + // default pointer (OSC 22: a hand over clickable chrome)
        `${ESC}[?1049l`,
    );
  } catch {}
  ownImages.clear();
}

/**
 * Queries whose replies the input parser understands. Device attributes go
 * last: every terminal answers it, so its reply means the others are done.
 */
export function queryCapabilities(graphics = true, colors = true): void {
  out(
    (graphics ? `${ESC}_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA${ST}` : "") + // kitty graphics support
      (colors ? queryColors() : "") +
      `${ESC}[?u` + // kitty keyboard flags
      `${ESC}[?1016$p` + // is SGR-pixel mouse supported?
      `${ESC}[16t` + // cell size in pixels
      `${ESC}[14t` + // text area size in pixels
      `${ESC}[c`, // primary device attributes
  );
}

/** Asks for the terminal's text and background colors and the palette entries the chrome uses (OSC 10, 11, 4). */
export function queryColors(): string {
  return `${ESC}]10;?${ST}${ESC}]11;?${ST}` + ANSI_QUERIED.map((i) => `${ESC}]4;${i};?${ST}`).join("");
}

export function querySizes(): void {
  out(`${ESC}[16t${ESC}[14t${ESC}[c`);
}

const CHUNK = 4096;

/**
 * Transmits a base64 PNG as image `id`, places it at (row, col) scaled to
 * cols x rows cells, then frees the image `replaces` so the swap has no
 * visible gap.
 */
export function drawImage(
  base64Png: string,
  id: number,
  replaces: number | null,
  row: number,
  col: number,
  cols: number,
  rows: number,
): string {
  const parts: string[] = [`${ESC}[${row};${col}H`];
  for (let i = 0; i < base64Png.length; i += CHUNK) {
    const chunk = base64Png.slice(i, i + CHUNK);
    const more = i + CHUNK < base64Png.length ? 1 : 0;
    const ctrl =
      i === 0 ? `a=T,f=100,i=${id},p=1,q=2,C=1,c=${cols},r=${rows},m=${more}` : `m=${more}`;
    parts.push(`${ESC}_G${ctrl};${chunk}${ST}`);
  }
  if (replaces !== null) parts.push(`${ESC}_Ga=d,d=I,i=${replaces},q=2${ST}`);
  return parts.join("");
}

/**
 * Synchronized output (DECSET 2026): the terminal shows what comes between
 * these two at once, so a redraw never shows a cleared screen or a pane
 * whose old picture is gone and new one not yet there. Terminals without
 * it ignore them; tmux holds the pane's text back the same way.
 */
export const SYNC_START = `${ESC}[?2026h`;
export const SYNC_END = `${ESC}[?2026l`;

export function deleteImage(id: number): string {
  return `${ESC}_Ga=d,d=I,i=${id},q=2${ST}`;
}


/** OSC 52: put text on the system clipboard. */
export function setClipboard(text: string): string {
  return `${ESC}]52;c;${Buffer.from(text, "utf8").toString("base64")}${ST}`;
}

// ------------------------------------------------- unicode placeholders
//
// Inside tmux an image can't be placed at a cell: tmux moves the outer
// terminal's cursor as it likes. Instead the image is sent as a virtual
// placement (U=1) and the pane's cells are filled with U+10EEEE
// placeholder characters, ordinary text that tmux keeps, redraws and clips
// like any other. Each cell's foreground colour names the image (a 256-colour
// index, which tmux never remaps) and two combining marks give its row and
// column within the image.

/** Combining marks for row/column 0, 1, 2… (kitty's rowcolumn-diacritics.txt). */
const DIACRITICS = [
  0x0305, 0x030d, 0x030e, 0x0310, 0x0312, 0x033d, 0x033e, 0x033f, 0x0346, 0x034a, 0x034b, 0x034c, 0x0350, 0x0351,
  0x0352, 0x0357, 0x035b, 0x0363, 0x0364, 0x0365, 0x0366, 0x0367, 0x0368, 0x0369, 0x036a, 0x036b, 0x036c, 0x036d,
  0x036e, 0x036f, 0x0483, 0x0484, 0x0485, 0x0486, 0x0487, 0x0592, 0x0593, 0x0594, 0x0595, 0x0597, 0x0598, 0x0599,
  0x059c, 0x059d, 0x059e, 0x059f, 0x05a0, 0x05a1, 0x05a8, 0x05a9, 0x05ab, 0x05ac, 0x05af, 0x05c4, 0x0610, 0x0611,
  0x0612, 0x0613, 0x0614, 0x0615, 0x0616, 0x0617, 0x0657, 0x0658, 0x0659, 0x065a, 0x065b, 0x065d, 0x065e, 0x06d6,
  0x06d7, 0x06d8, 0x06d9, 0x06da, 0x06db, 0x06dc, 0x06df, 0x06e0, 0x06e1, 0x06e2, 0x06e4, 0x06e7, 0x06e8, 0x06eb,
  0x06ec, 0x0730, 0x0732, 0x0733, 0x0735, 0x0736, 0x073a, 0x073d, 0x073f, 0x0740, 0x0741, 0x0743, 0x0745, 0x0747,
  0x0749, 0x074a, 0x07eb, 0x07ec, 0x07ed, 0x07ee, 0x07ef, 0x07f0, 0x07f1, 0x07f3, 0x0816, 0x0817, 0x0818, 0x0819,
  0x081b, 0x081c, 0x081d, 0x081e, 0x081f, 0x0820, 0x0821, 0x0822, 0x0823, 0x0825, 0x0826, 0x0827, 0x0829, 0x082a,
  0x082b, 0x082c, 0x082d, 0x0951, 0x0953, 0x0954, 0x0f82, 0x0f83, 0x0f86, 0x0f87, 0x135d, 0x135e, 0x135f, 0x17dd,
  0x193a, 0x1a17, 0x1a75, 0x1a76, 0x1a77, 0x1a78, 0x1a79, 0x1a7a, 0x1a7b, 0x1a7c, 0x1b6b, 0x1b6d, 0x1b6e, 0x1b6f,
  0x1b70, 0x1b71, 0x1b72, 0x1b73, 0x1cd0, 0x1cd1, 0x1cd2, 0x1cda, 0x1cdb, 0x1ce0, 0x1dc0, 0x1dc1, 0x1dc3, 0x1dc4,
  0x1dc5, 0x1dc6, 0x1dc7, 0x1dc8, 0x1dc9, 0x1dcb, 0x1dcc, 0x1dd1, 0x1dd2, 0x1dd3, 0x1dd4, 0x1dd5, 0x1dd6, 0x1dd7,
  0x1dd8, 0x1dd9, 0x1dda, 0x1ddb, 0x1ddc, 0x1ddd, 0x1dde, 0x1ddf, 0x1de0, 0x1de1, 0x1de2, 0x1de3, 0x1de4, 0x1de5,
  0x1de6, 0x1dfe, 0x20d0, 0x20d1, 0x20d4, 0x20d5, 0x20d6, 0x20d7, 0x20db, 0x20dc, 0x20e1, 0x20e7, 0x20e9, 0x20f0,
  0x2cef, 0x2cf0, 0x2cf1, 0x2de0, 0x2de1, 0x2de2, 0x2de3, 0x2de4, 0x2de5, 0x2de6, 0x2de7, 0x2de8, 0x2de9, 0x2dea,
  0x2deb, 0x2dec, 0x2ded, 0x2dee, 0x2def, 0x2df0, 0x2df1, 0x2df2, 0x2df3, 0x2df4, 0x2df5, 0x2df6, 0x2df7, 0x2df8,
  0x2df9, 0x2dfa, 0x2dfb, 0x2dfc, 0x2dfd, 0x2dfe, 0x2dff, 0xa66f, 0xa67c, 0xa67d, 0xa6f0, 0xa6f1, 0xa8e0, 0xa8e1,
  0xa8e2, 0xa8e3, 0xa8e4, 0xa8e5, 0xa8e6, 0xa8e7, 0xa8e8, 0xa8e9, 0xa8ea, 0xa8eb, 0xa8ec, 0xa8ed, 0xa8ee, 0xa8ef,
  0xa8f0, 0xa8f1, 0xaab0, 0xaab2, 0xaab3, 0xaab7, 0xaab8, 0xaabe, 0xaabf, 0xaac1, 0xfe20, 0xfe21, 0xfe22, 0xfe23,
  0xfe24, 0xfe25, 0xfe26, 0x10a0f, 0x10a38, 0x1d185, 0x1d186, 0x1d187, 0x1d188, 0x1d189, 0x1d1aa, 0x1d1ab, 0x1d1ac,
  0x1d1ad, 0x1d242, 0x1d243, 0x1d244,
].map((c) => String.fromCodePoint(c));

/** Largest image, in cells either way, that placeholders can address. */
export const PLACEHOLDER_MAX = DIACRITICS.length;

/**
 * Placeholder ids live in a cell's foreground colour (24 bits as RGB, or a
 * 256-colour index when the terminal under tmux can't show RGB) plus a high
 * byte in a third combining mark. Each terminal attach picks random ones,
 * so two termiums in two tmux panes (one outer terminal) don't meet.
 * PLACEHOLDER_IDS is how many a session uses at once at most.
 */
export const PLACEHOLDER_IDS = 255;

export function placeholderImageId(high: number, colour: number): number {
  return ((high & 0xff) << 24 >>> 0) + (colour & 0xffffff);
}

/**
 * Transmits a base64 PNG as image `id` with a virtual placement of
 * cols x rows cells, replacing any earlier image with that id.
 */
export function transmitVirtual(base64Png: string, id: number, cols: number, rows: number): string {
  const parts: string[] = [];
  for (let i = 0; i < base64Png.length; i += CHUNK) {
    const chunk = base64Png.slice(i, i + CHUNK);
    const more = i + CHUNK < base64Png.length ? 1 : 0;
    const ctrl = i === 0 ? `a=T,U=1,f=100,i=${id},q=2,c=${cols},r=${rows},m=${more}` : `m=${more}`;
    parts.push(`${ESC}_G${ctrl};${chunk}${ST}`);
  }
  return parts.join("");
}

/**
 * Placeholder text showing image placeholderImageId(high, index) in the
 * cols x rows cells at (row, col).
 */
export function placeholderCells(high: number, colour: number, rgb: boolean, row: number, col: number, cols: number, rows: number): string {
  const c = Math.min(cols, PLACEHOLDER_MAX);
  const r = Math.min(rows, PLACEHOLDER_MAX);
  const top = DIACRITICS[high & 0xff];
  const fg = rgb ? `38;2;${(colour >> 16) & 0xff};${(colour >> 8) & 0xff};${colour & 0xff}` : `38;5;${colour & 0xff}`;
  let s = `${ESC}[0m${ESC}[${fg}m`;
  // Only a row's first cell carries its marks (row, column, the id's high
  // byte); the rest are bare, and the terminal counts on from the cell to
  // their left. Marks on every cell made a full redraw of a big pane ~6x
  // larger (tmux rewrites a cell for each combining mark), over the amount
  // tmux lets queue for the terminal: it then discards and redraws again,
  // dropping passthrough (our pictures) all the while.
  const bare = "\u{10EEEE}".repeat(Math.max(0, c - 1));
  for (let y = 0; y < r; y++) s += `${ESC}[${row + y};${col}H\u{10EEEE}${DIACRITICS[y]}${DIACRITICS[0]}${top}${bare}`;
  return s + `${ESC}[0m`;
}
