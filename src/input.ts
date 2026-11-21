// Terminal input parser. Understands the kitty keyboard protocol (what
// Ghostty speaks when asked), legacy xterm keys as a fallback, SGR / SGR-pixel
// mouse reports, bracketed paste, and the replies to our capability queries.

export interface Mods {
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  meta: boolean; // the "super" key
}

export interface KeyEvent {
  type: "key";
  key: string; // DOM KeyboardEvent.key
  code: string; // DOM KeyboardEvent.code
  vk: number; // windowsVirtualKeyCode
  text: string; // text the key produces ("" for non-text keys)
  mods: Mods;
  event: "press" | "repeat" | "release";
  location: number; // 0 standard, 1 left, 2 right, 3 numpad
  legacy: boolean; // no release event will follow (legacy encoding)
}

export interface MouseEvent {
  type: "mouse";
  action: "press" | "release" | "move" | "wheel";
  button: number; // 0 left, 1 middle, 2 right, 3 none, 7 back, 8 forward
  wheel?: "up" | "down" | "left" | "right";
  x: number; // 1-based, pixels in SGR-pixel mode, cells otherwise
  y: number;
  mods: Mods;
}

export type InputEvent =
  | KeyEvent
  | MouseEvent
  | { type: "paste"; text: string }
  | { type: "cellSize"; width: number; height: number }
  | { type: "textAreaSize"; width: number; height: number }
  | { type: "modeReport"; mode: number; value: number }
  | { type: "kittyKeyboard"; flags: number }
  | { type: "kittyGraphics"; id: number; message: string }
  | { type: "deviceAttributes" }
  | { type: "focus"; focused: boolean };

/** String.fromCodePoint that tolerates garbage (out-of-range values give ""). */
function cpString(n: number): string {
  return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
}

const NO_MODS: Mods = { shift: false, alt: false, ctrl: false, meta: false };

function decodeMods(raw: number): Mods {
  const bits = Math.max(0, (raw || 1) - 1);
  return {
    shift: !!(bits & 1),
    alt: !!(bits & 2),
    ctrl: !!(bits & 4),
    meta: !!(bits & 8),
  };
}

interface KeyInfo {
  key: string;
  code: string;
  vk: number;
  text?: string;
  location?: number;
}

// Kitty functional key codes and legacy CSI-encoded keys.
const KITTY_KEYS: Record<number, KeyInfo> = {
  27: { key: "Escape", code: "Escape", vk: 27 },
  13: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  9: { key: "Tab", code: "Tab", vk: 9 },
  127: { key: "Backspace", code: "Backspace", vk: 8 },
  8: { key: "Backspace", code: "Backspace", vk: 8 },
  57358: { key: "CapsLock", code: "CapsLock", vk: 20 },
  57359: { key: "ScrollLock", code: "ScrollLock", vk: 145 },
  57360: { key: "NumLock", code: "NumLock", vk: 144 },
  57361: { key: "PrintScreen", code: "PrintScreen", vk: 44 },
  57362: { key: "Pause", code: "Pause", vk: 19 },
  57363: { key: "ContextMenu", code: "ContextMenu", vk: 93 },
  57409: { key: ".", code: "NumpadDecimal", vk: 110, text: ".", location: 3 },
  57410: { key: "/", code: "NumpadDivide", vk: 111, text: "/", location: 3 },
  57411: { key: "*", code: "NumpadMultiply", vk: 106, text: "*", location: 3 },
  57412: { key: "-", code: "NumpadSubtract", vk: 109, text: "-", location: 3 },
  57413: { key: "+", code: "NumpadAdd", vk: 107, text: "+", location: 3 },
  57414: { key: "Enter", code: "NumpadEnter", vk: 13, text: "\r", location: 3 },
  57415: { key: "=", code: "NumpadEqual", vk: 187, text: "=", location: 3 },
  57417: { key: "ArrowLeft", code: "Numpad4", vk: 37, location: 3 },
  57418: { key: "ArrowRight", code: "Numpad6", vk: 39, location: 3 },
  57419: { key: "ArrowUp", code: "Numpad8", vk: 38, location: 3 },
  57420: { key: "ArrowDown", code: "Numpad2", vk: 40, location: 3 },
  57421: { key: "PageUp", code: "Numpad9", vk: 33, location: 3 },
  57422: { key: "PageDown", code: "Numpad3", vk: 34, location: 3 },
  57423: { key: "Home", code: "Numpad7", vk: 36, location: 3 },
  57424: { key: "End", code: "Numpad1", vk: 35, location: 3 },
  57425: { key: "Insert", code: "Numpad0", vk: 45, location: 3 },
  57426: { key: "Delete", code: "NumpadDecimal", vk: 46, location: 3 },
  57441: { key: "Shift", code: "ShiftLeft", vk: 16, location: 1 },
  57442: { key: "Control", code: "ControlLeft", vk: 17, location: 1 },
  57443: { key: "Alt", code: "AltLeft", vk: 18, location: 1 },
  57444: { key: "Meta", code: "MetaLeft", vk: 91, location: 1 },
  57447: { key: "Shift", code: "ShiftRight", vk: 16, location: 2 },
  57448: { key: "Control", code: "ControlRight", vk: 17, location: 2 },
  57449: { key: "Alt", code: "AltRight", vk: 18, location: 2 },
  57450: { key: "Meta", code: "MetaRight", vk: 92, location: 2 },
};
for (let i = 0; i <= 9; i++) {
  KITTY_KEYS[57399 + i] = { key: String(i), code: `Numpad${i}`, vk: 96 + i, text: String(i), location: 3 };
}
for (let i = 13; i <= 24; i++) {
  KITTY_KEYS[57376 + i - 13] = { key: `F${i}`, code: `F${i}`, vk: 111 + i };
}

const LETTER_FINAL: Record<string, KeyInfo> = {
  A: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  B: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  C: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  D: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  H: { key: "Home", code: "Home", vk: 36 },
  F: { key: "End", code: "End", vk: 35 },
  E: { key: "Clear", code: "Numpad5", vk: 12 },
  P: { key: "F1", code: "F1", vk: 112 },
  Q: { key: "F2", code: "F2", vk: 113 },
  R: { key: "F3", code: "F3", vk: 114 },
  S: { key: "F4", code: "F4", vk: 115 },
};

const TILDE_KEYS: Record<number, KeyInfo> = {
  1: { key: "Home", code: "Home", vk: 36 },
  2: { key: "Insert", code: "Insert", vk: 45 },
  3: { key: "Delete", code: "Delete", vk: 46 },
  4: { key: "End", code: "End", vk: 35 },
  5: { key: "PageUp", code: "PageUp", vk: 33 },
  6: { key: "PageDown", code: "PageDown", vk: 34 },
  7: { key: "Home", code: "Home", vk: 36 },
  8: { key: "End", code: "End", vk: 35 },
  11: { key: "F1", code: "F1", vk: 112 },
  12: { key: "F2", code: "F2", vk: 113 },
  13: { key: "F3", code: "F3", vk: 114 },
  14: { key: "F4", code: "F4", vk: 115 },
  15: { key: "F5", code: "F5", vk: 116 },
  17: { key: "F6", code: "F6", vk: 117 },
  18: { key: "F7", code: "F7", vk: 118 },
  19: { key: "F8", code: "F8", vk: 119 },
  20: { key: "F9", code: "F9", vk: 120 },
  21: { key: "F10", code: "F10", vk: 121 },
  23: { key: "F11", code: "F11", vk: 122 },
  24: { key: "F12", code: "F12", vk: 123 },
  29: { key: "ContextMenu", code: "ContextMenu", vk: 93 },
};

// US-layout physical key for each printable ASCII character.
const PUNCT: Record<string, { code: string; vk: number }> = {
  " ": { code: "Space", vk: 32 },
  "-": { code: "Minus", vk: 189 }, _: { code: "Minus", vk: 189 },
  "=": { code: "Equal", vk: 187 }, "+": { code: "Equal", vk: 187 },
  "[": { code: "BracketLeft", vk: 219 }, "{": { code: "BracketLeft", vk: 219 },
  "]": { code: "BracketRight", vk: 221 }, "}": { code: "BracketRight", vk: 221 },
  "\\": { code: "Backslash", vk: 220 }, "|": { code: "Backslash", vk: 220 },
  ";": { code: "Semicolon", vk: 186 }, ":": { code: "Semicolon", vk: 186 },
  "'": { code: "Quote", vk: 222 }, '"': { code: "Quote", vk: 222 },
  ",": { code: "Comma", vk: 188 }, "<": { code: "Comma", vk: 188 },
  ".": { code: "Period", vk: 190 }, ">": { code: "Period", vk: 190 },
  "/": { code: "Slash", vk: 191 }, "?": { code: "Slash", vk: 191 },
  "`": { code: "Backquote", vk: 192 }, "~": { code: "Backquote", vk: 192 },
};
const SHIFTED_DIGITS = ")!@#$%^&*(";

/** DOM code and virtual key code for a printable character (US layout). */
export function printableKey(ch: string): { code: string; vk: number } {
  if (/^[a-z]$/i.test(ch)) {
    const up = ch.toUpperCase();
    return { code: `Key${up}`, vk: up.charCodeAt(0) };
  }
  if (/^[0-9]$/.test(ch)) return { code: `Digit${ch}`, vk: ch.charCodeAt(0) };
  const d = SHIFTED_DIGITS.indexOf(ch);
  if (d >= 0) return { code: `Digit${d}`, vk: 48 + d };
  return PUNCT[ch] ?? { code: "", vk: 0 };
}

function makeKey(
  info: KeyInfo,
  mods: Mods,
  event: KeyEvent["event"] = "press",
  legacy = false,
  textOverride?: string,
): KeyEvent {
  return {
    type: "key",
    key: info.key,
    code: info.code,
    vk: info.vk,
    text: textOverride ?? info.text ?? "",
    mods,
    event,
    location: info.location ?? 0,
    legacy,
  };
}

function printable(ch: string, mods: Mods, event: KeyEvent["event"], legacy: boolean, text: string): KeyEvent {
  const { code, vk } = printableKey(ch);
  return makeKey({ key: ch, code, vk }, mods, event, legacy, text);
}

const EVENT_TYPES: Record<number, KeyEvent["event"]> = { 1: "press", 2: "repeat", 3: "release" };

export class InputParser {
  private buf = "";
  private pasting = false;
  private pasteBuf = "";
  private escTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private emit: (ev: InputEvent) => void) {}

  feed(chunk: string): void {
    if (this.escTimer) {
      clearTimeout(this.escTimer);
      this.escTimer = null;
    }
    this.buf += chunk;
    this.drain();
  }

  private drain(): void {
    const buf = this.buf;
    let i = 0;
    while (i < buf.length) {
      if (this.pasting) {
        const end = buf.indexOf("\x1b[201~", i);
        if (end < 0) {
          // Keep a possible partial terminator for the next chunk.
          const keep = Math.min(5, buf.length - i);
          this.pasteBuf += buf.slice(i, buf.length - keep);
          i = buf.length - keep;
          break;
        }
        this.pasteBuf += buf.slice(i, end);
        this.emit({ type: "paste", text: this.pasteBuf });
        this.pasteBuf = "";
        this.pasting = false;
        i = end + 6;
        continue;
      }

      const c = buf[i]!;
      if (c !== "\x1b") {
        const cp = buf.codePointAt(i)!;
        const ch = String.fromCodePoint(cp);
        this.legacyChar(ch, false);
        i += ch.length;
        continue;
      }

      if (i + 1 >= buf.length) {
        // A lone ESC: either the Escape key (legacy) or the start of a sequence.
        this.escTimer = setTimeout(() => {
          this.escTimer = null;
          if (this.buf === "\x1b") {
            this.buf = "";
            this.emit(makeKey(KITTY_KEYS[27]!, NO_MODS, "press", true));
          }
        }, 40);
        break;
      }

      const n = buf[i + 1]!;
      if (n === "[") {
        let j = i + 2;
        while (j < buf.length) {
          const cc = buf.charCodeAt(j);
          if (cc >= 0x20 && cc <= 0x3f) j++;
          else break;
        }
        if (j >= buf.length) break; // incomplete
        this.csi(buf.slice(i + 2, j), buf[j]!);
        i = j + 1;
        continue;
      }
      if (n === "O") {
        if (i + 2 >= buf.length) break;
        const info = LETTER_FINAL[buf[i + 2]!];
        if (info) this.emit(makeKey(info, NO_MODS, "press", true));
        i += 3;
        continue;
      }
      // String sequences are only replies to our queries (kitty graphics
      // replies are APC "ESC _ G"); otherwise a legacy Alt+_ / Alt+] / Alt+P
      // must stay a key rather than swallow all input after it.
      if ((n === "_" && (this.expectApc || buf[i + 2] === "G" && this.kittyActive)) || ((n === "]" || n === "P") && this.kittyActive)) {
        // String sequence terminated by ST (ESC \) or BEL.
        let end = -1;
        let termLen = 0;
        for (let j = i + 2; j < buf.length; j++) {
          if (buf[j] === "\x07") { end = j; termLen = 1; break; }
          if (buf[j] === "\x1b" && buf[j + 1] === "\\") { end = j; termLen = 2; break; }
          if (buf[j] === "\x1b" && j + 1 >= buf.length) break;
        }
        if (end < 0) break; // incomplete
        if (n === "_") this.apc(buf.slice(i + 2, end));
        i = end + termLen;
        continue;
      }
      // ESC followed by a character: Alt+key in legacy encoding.
      const cp = buf.codePointAt(i + 1)!;
      const ch = String.fromCodePoint(cp);
      this.legacyChar(ch, true);
      i += 1 + ch.length;
    }
    this.buf = buf.slice(i);
  }

  private legacyChar(ch: string, alt: boolean): void {
    const mods: Mods = { ...NO_MODS, alt };
    const code = ch.codePointAt(0)!;
    if (ch === "\r" || ch === "\n") return this.emit(makeKey(KITTY_KEYS[13]!, mods, "press", true));
    if (ch === "\t") return this.emit(makeKey(KITTY_KEYS[9]!, mods, "press", true));
    if (ch === "\x7f") return this.emit(makeKey(KITTY_KEYS[127]!, mods, "press", true));
    if (ch === "\x08") return this.emit(makeKey(KITTY_KEYS[8]!, { ...mods, ctrl: true }, "press", true));
    if (ch === "\x1b") return this.emit(makeKey(KITTY_KEYS[27]!, mods, "press", true));
    if (code === 0) return this.emit(printable(" ", { ...mods, ctrl: true }, "press", true, ""));
    if (code < 32) {
      const letter = String.fromCharCode(code + 96);
      return this.emit(printable(letter, { ...mods, ctrl: true }, "press", true, ""));
    }
    const shift = ch !== ch.toLowerCase();
    this.emit(printable(ch, { ...mods, shift }, "press", true, alt ? "" : ch));
  }

  private apc(body: string): void {
    // Kitty graphics reply: G<key=value,...>;<message>
    if (!body.startsWith("G")) return;
    const semi = body.indexOf(";");
    const ctrl = semi >= 0 ? body.slice(1, semi) : body.slice(1);
    const message = semi >= 0 ? body.slice(semi + 1) : "";
    const idMatch = ctrl.match(/(?:^|,)i=(\d+)/);
    this.emit({ type: "kittyGraphics", id: idMatch ? Number(idMatch[1]) : 0, message });
  }

  private csi(params: string, final: string): void {
    const prefix = /^[<>?=]/.test(params) ? params[0]! : "";
    const body = prefix ? params.slice(1) : params;

    if (prefix === "<" && (final === "M" || final === "m")) return this.mouse(body, final);
    if (prefix === "?" && final === "u") {
      return this.emit({ type: "kittyKeyboard", flags: Number(body) || 0 });
    }
    if (prefix === "?" && final === "c") return this.emit({ type: "deviceAttributes" });
    if (prefix === "?" && final === "y" && body.endsWith("$")) {
      const [mode, value] = body.slice(0, -1).split(";").map(Number);
      return this.emit({ type: "modeReport", mode: mode ?? 0, value: value ?? 0 });
    }
    if (final === "t" && !prefix) {
      const [kind, h, w] = body.split(";").map(Number);
      if (kind === 6 && h && w) return this.emit({ type: "cellSize", width: w, height: h });
      if (kind === 4 && h && w) return this.emit({ type: "textAreaSize", width: w, height: h });
      return;
    }
    if (final === "I" && !params) return this.emit({ type: "focus", focused: true });
    if (final === "O" && !params) return this.emit({ type: "focus", focused: false });
    if (prefix) return;

    const fields = body.split(";");
    const [modRaw, evRaw] = (fields[1] ?? "").split(":");
    const mods = decodeMods(Number(modRaw) || 1);
    const event = EVENT_TYPES[Number(evRaw) || 1] ?? "press";
    // Kitty omits the event field for plain presses, so its absence only
    // means "no release will follow" when the kitty protocol is off.
    const legacyKey = !this.kittyActive;

    if (final === "u") {
      const [cpRaw, shiftedRaw] = (fields[0] ?? "").split(":");
      const cp = Number(cpRaw);
      const text = fields[2]
        ? fields[2].split(":").map((n) => cpString(Number(n))).join("")
        : "";
      const legacy = !this.kittyActive;
      const info = KITTY_KEYS[cp];
      if (info) {
        // Keys like Enter carry implicit text, but not when modified by ctrl/alt/super.
        const t = mods.ctrl || mods.alt || mods.meta ? "" : info.text;
        return this.emit(makeKey(info, mods, event, legacy, t));
      }
      if (cp >= 57344 && cp <= 63743) return; // other private-use functional keys
      let ch = cpString(cp);
      if (!ch) return;
      if (mods.shift) {
        if (shiftedRaw) ch = cpString(Number(shiftedRaw)) || ch;
        else if (text) ch = text;
        else ch = ch.toUpperCase();
      }
      // Without "report associated text", plain keys still produce text.
      const produced = text || (mods.ctrl || mods.alt || mods.meta ? "" : ch);
      return this.emit(printable(ch, mods, event, legacy, event === "release" ? "" : produced));
    }

    if (final === "~") {
      const num = Number(fields[0]);
      if (num === 200) {
        this.pasting = true;
        this.pasteBuf = "";
        return;
      }
      const info = TILDE_KEYS[num];
      if (info) this.emit(makeKey(info, mods, event, legacyKey));
      return;
    }

    if (final === "Z") {
      return this.emit(makeKey(KITTY_KEYS[9]!, { ...NO_MODS, shift: true }, "press", true));
    }

    const info = LETTER_FINAL[final];
    if (info) this.emit(makeKey(info, mods, event, legacyKey));
  }

  /** Set when the terminal confirmed the kitty keyboard protocol with event types. */
  kittyActive = false;
  /** True while capability replies (APC) may still arrive. */
  expectApc = true;

  private mouse(body: string, final: string): void {
    const [bRaw, xRaw, yRaw] = body.split(";").map(Number);
    const b = bRaw ?? 0;
    const mods: Mods = { shift: !!(b & 4), alt: !!(b & 8), ctrl: !!(b & 16), meta: false };
    const low = b & 3;
    const x = xRaw ?? 1;
    const y = yRaw ?? 1;
    if (b & 64 && !(b & 128)) {
      const wheel = (["up", "down", "left", "right"] as const)[low]!;
      return this.emit({ type: "mouse", action: "wheel", button: 3, wheel, x, y, mods });
    }
    let button = low;
    if (b & 128) button = low === 0 ? 7 : low === 1 ? 8 : 3; // back / forward
    if (b & 32) return this.emit({ type: "mouse", action: "move", button, x, y, mods });
    this.emit({ type: "mouse", action: final === "M" ? "press" : "release", button, x, y, mods });
  }
}
