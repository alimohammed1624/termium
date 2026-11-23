// Terminal output: mode setup/teardown, capability queries and kitty
// graphics frame placement.

import { writeSync } from "node:fs";

const ESC = "\x1b";
const ST = `${ESC}\\`;

/** Kitty keyboard flags: disambiguate | report event types | all keys as escapes | associated text. */
export const KITTY_KBD_FLAGS = 1 | 2 | 8 | 16;

let entered = false;

/** Where out() sends terminal output; null drops it (nothing attached). */
export type Sink = (data: string, done?: () => void) => void;
let sink: Sink | null = null;

const stdoutSink: Sink = (data, done) => {
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
    outSync(
      `${ESC}_Ga=d,d=A,q=2${ST}` + // delete all images
        `${ESC}[<u` + // pop kitty keyboard flags
        `${ESC}[?2004l${ESC}[?1016l${ESC}[?1006l${ESC}[?1003l` +
        `${ESC}[0m${ESC}[0 q${ESC}[?25h` + // default cursor shape, visible
        `${ESC}[?1049l`,
    );
  } catch {}
}

/**
 * Queries whose replies the input parser understands. Device attributes go
 * last: every terminal answers it, so its reply means the others are done.
 */
export function queryCapabilities(): void {
  out(
    `${ESC}_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA${ST}` + // kitty graphics support
      `${ESC}[?u` + // kitty keyboard flags
      `${ESC}[?1016$p` + // is SGR-pixel mouse supported?
      `${ESC}[16t` + // cell size in pixels
      `${ESC}[14t` + // text area size in pixels
      `${ESC}[c`, // primary device attributes
  );
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

export function deleteAllImages(): string {
  return `${ESC}_Ga=d,d=A,q=2${ST}`;
}

/** OSC 52: put text on the system clipboard. */
export function setClipboard(text: string): string {
  return `${ESC}]52;c;${Buffer.from(text, "utf8").toString("base64")}${ST}`;
}

