#!/usr/bin/env python3
"""Drive termium in a pseudo-terminal that answers like Ghostty.

Runs the real termium (and so the real headless Helium) inside a PTY,
answers its capability queries (kitty graphics, kitty keyboard, SGR-pixel
mouse, cell size), sends kitty-protocol keys and SGR-pixel mouse events,
and composites what termium draws (text via pyte, images from the kitty
graphics stream) into PNG screenshots.

Usage as a library:

    from drive import Term
    with Term(["bun", "src/main.ts", "--incognito", "https://example.com"]) as t:
        t.wait_idle()
        t.click(400, 300)
        t.type("hello")
        t.key("enter")
        t.shot("out.png")
"""

from __future__ import annotations

import base64
import fcntl
import io
import os
import pty
import re
import select
import signal
import struct
import termios
import threading
import time

import pyte
from PIL import Image, ImageDraw, ImageFont

APC_RE = re.compile(rb"\x1b_G([^;\x1b]*)(?:;([^\x1b]*))?\x1b\\")
CUP_RE = re.compile(rb"\x1b\[(\d+);(\d+)H")

FONT_CANDIDATES = [
    "/usr/share/fonts/TTF/JetBrainsMonoNerdFont-Regular.ttf",
    "/usr/share/fonts/TTF/JetBrainsMono-Regular.ttf",
    "/usr/share/fonts/noto/NotoSansMono-Regular.ttf",
    "/usr/share/fonts/TTF/DejaVuSansMono.ttf",
    "/usr/share/fonts/dejavu/DejaVuSansMono.ttf",
]

NAMED_KITTY = {
    "enter": "13", "escape": "27", "tab": "9", "backspace": "127", "space": "32",
}
LEGACY_FINAL = {"up": "A", "down": "B", "right": "C", "left": "D", "home": "H", "end": "F"}
TILDE = {"pageup": 5, "pagedown": 6, "delete": 3, "insert": 2, "f5": 15, "f6": 17}


def mods_value(mods: set[str]) -> int:
    v = 0
    if "shift" in mods: v |= 1
    if "alt" in mods: v |= 2
    if "ctrl" in mods: v |= 4
    if "super" in mods: v |= 8
    return v + 1


class Term:
    def __init__(self, argv, cols=160, rows=45, cell_w=10, cell_h=20, cwd=None, env=None, passthrough=False):
        """With passthrough, run inside a real terminal: the child's output goes
        to our stdout and the terminal's replies come back from our stdin, so the
        real terminal renders and answers; scripted input is mixed in."""
        self.passthrough = passthrough
        if passthrough:
            rows, cols, xpix, ypix = struct.unpack("HHHH", fcntl.ioctl(0, termios.TIOCGWINSZ, b"\0" * 8))
            cell_w, cell_h = (xpix // cols or 10), (ypix // rows or 20)
        self.cols, self.rows, self.cell_w, self.cell_h = cols, rows, cell_w, cell_h
        self.screen = pyte.Screen(cols, rows)
        self.stream = pyte.ByteStream(self.screen)
        self.images: dict[int, bytes] = {}
        self.placements: dict[int, tuple[int, int, int, int]] = {}
        self.frames = 0
        self.last_output = time.time()
        self.lock = threading.Lock()
        self.raw = bytearray()
        self._pending_apc: dict[str, bytes] = {}
        self._cursor = (1, 1)
        self._kbd_flags = 0
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            if cwd:
                os.chdir(cwd)
            e = dict(os.environ, TERM="xterm-ghostty", **(env or {}))
            os.execvpe(argv[0], argv, e)
        self._set_size()
        self.alive = True
        self.reader = threading.Thread(target=self._read_loop, daemon=True)
        self.reader.start()
        if passthrough:
            import tty
            self._saved_tty = termios.tcgetattr(0)
            tty.setraw(0)
            threading.Thread(target=self._forward_stdin, daemon=True).start()

    def _forward_stdin(self):
        while self.alive:
            r, _, _ = select.select([0], [], [], 0.1)
            if r:
                data = os.read(0, 65536)
                if not data:
                    break
                self.write(data)

    # -- plumbing

    def _set_size(self):
        ws = struct.pack("HHHH", self.rows, self.cols, self.cols * self.cell_w, self.rows * self.cell_h)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, ws)

    def resize(self, cols, rows):
        with self.lock:
            self.cols, self.rows = cols, rows
            self.screen.resize(rows, cols)
        self._set_size()
        os.kill(self.pid, signal.SIGWINCH)

    def write(self, data: bytes | str):
        if isinstance(data, str):
            data = data.encode()
        os.write(self.fd, data)

    def _read_loop(self):
        buf = b""
        while self.alive:
            try:
                r, _, _ = select.select([self.fd], [], [], 0.1)
            except (OSError, ValueError):
                break
            if not r:
                continue
            try:
                chunk = os.read(self.fd, 1 << 20)
            except OSError:
                break
            if not chunk:
                break
            buf += chunk
            buf = self._process(buf)
        self.alive = False

    def _process(self, buf: bytes) -> bytes:
        if self.passthrough:
            out = buf
            while out:
                out = out[os.write(1, out):]
            with self.lock:
                text = APC_RE.sub(b"", buf)
                self.stream.feed(re.sub(rb"\x1b_[^\x1b]*", b"", text))
                self.last_output = time.time()
            return b""
        # Hold back an unterminated APC so it is parsed whole.
        start = buf.rfind(b"\x1b_")
        hold = b""
        if start >= 0 and buf.find(b"\x1b\\", start) < 0:
            buf, hold = buf[:start], buf[start:]
        elif buf.endswith(b"\x1b"):
            # Could be the start of an APC split across reads.
            buf, hold = buf[:-1], b"\x1b"
        self._answer_queries(buf)
        text = bytearray()
        pos = 0
        for m in APC_RE.finditer(buf):
            text += buf[pos:m.start()]
            self._track_cursor(bytes(text))
            self._apc(m.group(1).decode(), m.group(2) or b"")
            pos = m.end()
        text += buf[pos:]
        self._track_cursor(bytes(text))
        cleaned = re.sub(rb"\x1b\[[<>=?][0-9;:]*u|\x1b\[[0-9;]*t|\x1b\[\?1016\$p|\x1b\[\d+ q", b"", bytes(text))
        with self.lock:
            self.stream.feed(cleaned)
            self.raw += buf
            self.last_output = time.time()
        return hold

    def _track_cursor(self, data: bytes):
        for m in CUP_RE.finditer(data):
            self._cursor = (int(m.group(1)), int(m.group(2)))

    def _answer_queries(self, data: bytes):
        replies = b""
        if b"a=q" in data and b"i=31" in data:
            replies += b"\x1b_Gi=31;OK\x1b\\"
        for m in re.finditer(rb"\x1b\[>(\d+)u", data):
            self._kbd_flags = int(m.group(1))
        if b"\x1b[?u" in data:
            replies += f"\x1b[?{self._kbd_flags}u".encode()
        if b"\x1b[?1016$p" in data:
            replies += b"\x1b[?1016;1$y"
        if b"\x1b[16t" in data:
            replies += f"\x1b[6;{self.cell_h};{self.cell_w}t".encode()
        if b"\x1b[14t" in data:
            replies += f"\x1b[4;{self.rows * self.cell_h};{self.cols * self.cell_w}t".encode()
        if re.search(rb"\x1b\[0?c", data):
            replies += b"\x1b[?62;22c"
        if replies:
            self.write(replies)

    def _apc(self, ctrl: str, payload: bytes):
        kv = dict(p.split("=", 1) for p in ctrl.split(",") if "=" in p)
        a = kv.get("a")
        if a == "d":
            d = kv.get("d", "a")
            with self.lock:
                if d in ("A", "a"):
                    self.images.clear()
                    self.placements.clear()
                elif d in ("I", "i"):
                    i = int(kv.get("i", "0"))
                    self.images.pop(i, None)
                    self.placements.pop(i, None)
            return
        if a == "q":
            return
        key = "cur"
        if a == "T":
            self._pending_apc[key] = payload
            self._pending_meta = (int(kv["i"]), self._cursor, int(kv.get("c", "0")), int(kv.get("r", "0")))
        else:
            self._pending_apc[key] = self._pending_apc.get(key, b"") + payload
        if kv.get("m", "0") == "0":
            data = base64.b64decode(self._pending_apc.pop(key))
            i, (row, col), c, r = self._pending_meta
            with self.lock:
                self.images[i] = data
                self.placements[i] = (row, col, c, r)
                self.frames += 1

    # -- input

    def key(self, spec: str, release=True):
        """spec like 'a', 'shift+a', 'ctrl+l', 'enter', 'alt+left', 'f5'."""
        parts = spec.split("+")
        name = parts[-1]
        mods = set(parts[:-1])
        m = mods_value(mods)
        if name in LEGACY_FINAL:
            fin = LEGACY_FINAL[name]
            self.write(f"\x1b[1;{m}{fin}" if m > 1 else f"\x1b[{fin}")
            if release:
                self.write(f"\x1b[1;{m}:3{fin}")
            return
        if name in TILDE:
            n = TILDE[name]
            self.write(f"\x1b[{n};{m}~" if m > 1 else f"\x1b[{n}~")
            if release:
                self.write(f"\x1b[{n};{m}:3~")
            return
        if name in NAMED_KITTY:
            code = NAMED_KITTY[name]
            text = ";32" if name == "space" and m == 1 else ""
            self.write(f"\x1b[{code};{m}{text}u")
            if release:
                self.write(f"\x1b[{code};{m}:3u")
            return
        ch = {"minus": "-", "equal": "=", "plus": "+", "question": "?", "comma": ",", "period": "."}.get(name, name)
        base = ch.lower()
        text = ""
        if not (mods - {"shift"}):
            t = ch.upper() if "shift" in mods else ch
            text = f";{ord(t)}"
        self.write(f"\x1b[{ord(base)};{m}{text}u")
        if release:
            self.write(f"\x1b[{ord(base)};{m}:3u")

    def type(self, text: str, delay=0.01):
        for ch in text:
            if ch == " ":
                self.key("space")
            elif ch.isupper():
                self.key(f"shift+{ch.lower()}")
            else:
                self.write(f"\x1b[{ord(ch)};1;{ord(ch)}u\x1b[{ord(ch)};1:3u")
            time.sleep(delay)

    def paste(self, text: str):
        self.write(f"\x1b[200~{text}\x1b[201~")

    def mouse(self, x: int, y: int, button=0, action="click", mods=0):
        """x/y are 0-based pixels."""
        X, Y = x + 1, y + 1
        if action in ("press", "click"):
            self.write(f"\x1b[<{button | mods};{X};{Y}M")
        if action == "click":
            time.sleep(0.03)
        if action in ("release", "click"):
            self.write(f"\x1b[<{button | mods};{X};{Y}m")
        if action == "move":
            self.write(f"\x1b[<{35 | mods};{X};{Y}M")
        if action == "drag":
            self.write(f"\x1b[<{32 | button | mods};{X};{Y}M")

    def click(self, x, y, button=0):
        self.mouse(x, y, button, "click")

    def click_cell(self, col, row, button=0):
        """1-based cell coordinates."""
        self.click((col - 1) * self.cell_w + self.cell_w // 2, (row - 1) * self.cell_h + self.cell_h // 2, button)

    def scroll(self, x, y, down=True, n=1):
        for _ in range(n):
            self.write(f"\x1b[<{65 if down else 64};{x + 1};{y + 1}M")
            time.sleep(0.02)

    # -- waiting and inspection

    def text(self) -> str:
        with self.lock:
            return "\n".join(self.screen.display)

    def line(self, row: int) -> str:
        with self.lock:
            return self.screen.display[row - 1]

    def wait_for(self, pred, timeout=20.0, interval=0.1) -> bool:
        end = time.time() + timeout
        while time.time() < end:
            if pred():
                return True
            time.sleep(interval)
        return False

    def wait_text(self, s: str, timeout=20.0) -> bool:
        return self.wait_for(lambda: s in self.text(), timeout)

    def wait_idle(self, quiet=0.8, timeout=20.0) -> bool:
        return self.wait_for(lambda: time.time() - self.last_output > quiet, timeout)

    def wait_frames(self, n=1, timeout=20.0) -> bool:
        target = self.frames + n
        return self.wait_for(lambda: self.frames >= target, timeout)

    def latest_image(self, region=None) -> Image.Image | None:
        """Most recent placed image, optionally the one at a (row, col) cell."""
        with self.lock:
            items = list(self.placements.items())
            if region:
                r, c = region
                items = [(i, p) for i, p in items if p[0] <= r < p[0] + p[3] and p[1] <= c < p[1] + p[2]]
            if not items:
                return None
            i = max(i for i, _ in items)
            return Image.open(io.BytesIO(self.images[i])).convert("RGB")

    def shot(self, path: str):
        """Composite text (with colors) and images into a PNG like the terminal would show."""
        cw, ch = self.cell_w, self.cell_h
        with self.lock:
            img = Image.new("RGB", (self.cols * cw, self.rows * ch), (30, 30, 46))
            draw = ImageDraw.Draw(img)
            font = None
            for f in FONT_CANDIDATES:
                if os.path.exists(f):
                    font = ImageFont.truetype(f, int(ch * 0.7))
                    break
            font = font or ImageFont.load_default()
            for y in range(self.rows):
                line = self.screen.buffer[y]
                for x in range(self.cols):
                    cell = line[x]
                    bgc = _color(cell.bg, (30, 30, 46))
                    fgc = _color(cell.fg, (205, 214, 244))
                    if cell.reverse:
                        bgc, fgc = fgc, bgc
                    draw.rectangle([x * cw, y * ch, (x + 1) * cw - 1, (y + 1) * ch - 1], fill=bgc)
                    if cell.data.strip():
                        draw.text((x * cw, y * ch + ch * 0.12), cell.data, font=font, fill=fgc)
            for i in sorted(self.placements):
                row, col, c, r = self.placements[i]
                im = Image.open(io.BytesIO(self.images[i])).convert("RGB")
                im = im.resize((c * cw, r * ch))
                img.paste(im, ((col - 1) * cw, (row - 1) * ch))
        img.save(path)
        return path

    def close(self):
        try:
            try:
                self.key("ctrl+q")
            except OSError:
                pass  # already gone
            end = time.time() + 6
            while time.time() < end:
                pid, _ = os.waitpid(self.pid, os.WNOHANG)
                if pid:
                    self.exit_code = _
                    break
                time.sleep(0.1)
            else:
                os.kill(self.pid, signal.SIGKILL)
                os.waitpid(self.pid, 0)
        except ChildProcessError:
            pass
        self.alive = False
        if self.passthrough:
            termios.tcsetattr(0, termios.TCSADRAIN, self._saved_tty)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


def _color(c, default):
    if c == "default":
        return default
    if isinstance(c, str) and re.fullmatch(r"[0-9a-fA-F]{6}", c):
        return tuple(int(c[i:i + 2], 16) for i in (0, 2, 4))
    named = {
        "black": (0, 0, 0), "red": (243, 139, 168), "green": (166, 227, 161), "brown": (249, 226, 175),
        "blue": (137, 180, 250), "magenta": (203, 166, 247), "cyan": (148, 226, 213), "white": (205, 214, 244),
    }
    return named.get(c, default)
