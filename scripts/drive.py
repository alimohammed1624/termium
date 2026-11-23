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
import shutil
import struct
import tempfile
import termios
import threading
import time
import unicodedata

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
        real terminal renders and answers; scripted input is mixed in.

        termium runs as a client of a background session server. Unless env
        sets XDG_RUNTIME_DIR, each Term gets a private one, so its session
        can't meet any other (the user's own included), and close() makes
        sure that session's server is gone too."""
        self.passthrough = passthrough
        env = dict(env or {})
        self.own_runtime = "XDG_RUNTIME_DIR" not in env
        if self.own_runtime:
            env["XDG_RUNTIME_DIR"] = tempfile.mkdtemp(prefix="trt-")
        self.runtime_dir = env["XDG_RUNTIME_DIR"]
        if passthrough:
            rows, cols, xpix, ypix = struct.unpack("HHHH", fcntl.ioctl(0, termios.TIOCGWINSZ, b"\0" * 8))
            cell_w, cell_h = (xpix // cols or 10), (ypix // rows or 20)
        self.cols, self.rows, self.cell_w, self.cell_h = cols, rows, cell_w, cell_h
        self.screen = _Screen(cols, rows)
        self.stream = pyte.ByteStream(self.screen)
        self.images: dict[int, bytes] = {}
        self.placements: dict[int, tuple[int, int, int, int]] = {}
        # Virtual placements (U=1, shown through unicode placeholder cells): id -> (cols, rows)
        self.virtual: dict[int, tuple[int, int]] = {}
        # Graphics commands that arrived in the middle of a chunked transfer
        # (a real terminal takes them as the end of that picture).
        self.violations = 0
        self._loading = False
        self.frames = 0
        self.last_output = time.time()
        self.lock = threading.Lock()
        self.raw = bytearray()
        self._pending_apc: dict[str, bytes] = {}
        self._cursor = (1, 1)
        self._kbd_flags = 0
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            # The child must see its size (pixels too) from the start: tmux,
            # for one, takes the cell size once, as it attaches.
            fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, cols * cell_w, rows * cell_h))
            if cwd:
                os.chdir(cwd)
            e = dict(os.environ, TERM="xterm-ghostty", **env)
            e.pop("TMUX", None)  # we are the terminal here, not whatever tmux runs this script
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
                self.raw += buf
                text = APC_RE.sub(b"", buf)
                text = re.sub(rb"\x1b_[^\x1b]*|\x1bP[^\x1b]*(?:\x1b\x1b[^\x1b]*)*\x1b\\|\x1b\[\?[0-9;]*n", b"", text)
                try:
                    self.stream.feed(text)
                except Exception:
                    pass  # never let a parser bug kill the reader
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
            try:
                self._apc(m.group(1).decode(), m.group(2) or b"")
            except Exception:
                pass  # an image command this driver doesn't model
            pos = m.end()
        text += buf[pos:]
        self._track_cursor(bytes(text))
        # Sequences pyte can't parse (or chokes on, like tmux's CSI ? n) are dropped.
        cleaned = re.sub(rb"\x1b\[[<>=?][0-9;:]*u|\x1b\[[0-9;]*t|\x1b\[\?[0-9;]*\$p|\x1b\[\?[0-9;]*n|\x1b\[\d+ q", b"", bytes(text))
        # Colon-separated SGR (tmux writes 38:2:r:g:b) as pyte's semicolons.
        cleaned = re.sub(rb"\x1b\[[0-9:;]*:[0-9:;]*m", lambda m: m.group(0).replace(b"::", b":").replace(b":", b";"), cleaned)
        with self.lock:
            try:
                self.stream.feed(cleaned)
            except Exception:
                pass  # never let a parser bug kill the reader
            self.raw += buf
            self.last_output = time.time()
        return hold

    def _track_cursor(self, data: bytes):
        for m in CUP_RE.finditer(data):
            self._cursor = (int(m.group(1)), int(m.group(2)))

    def _answer_queries(self, data: bytes):
        replies = b""
        for m in re.finditer(rb"\x1b_G([^;\x1b]*)(?:;([^\x1b]*))?", data):
            kv = dict(p.split(b"=", 1) for p in m.group(1).split(b",") if b"=" in p)
            if kv.get(b"a") == b"q" and b"i" in kv:
                ok = True
                if kv.get(b"t") in (b"t", b"f"):
                    # A file: answer OK only if it can be read (and remove a temporary one).
                    try:
                        path = base64.b64decode(m.group(2) or b"").decode()
                        open(path, "rb").close()
                        if kv.get(b"t") == b"t":
                            os.remove(path)
                    except (OSError, ValueError):
                        ok = False
                replies += b"\x1b_Gi=" + kv[b"i"] + (b";OK\x1b\\" if ok else b";ENOENT:no such file\x1b\\")
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
                    self.virtual.clear()
                elif d in ("I", "i"):
                    i = int(kv.get("i", "0"))
                    self.images.pop(i, None)
                    self.placements.pop(i, None)
                    self.virtual.pop(i, None)
            return
        if self._loading and not (a is None and set(kv) <= {"m", "q"}):
            self.violations += 1
            self._loading = False
        if a == "q":
            return
        if a == "p":
            # Put an image sent earlier (a=t) at the cursor, as herdr does.
            i = int(kv.get("i", "0"))
            with self.lock:
                if i in self.images:
                    self.placements[i] = (*self._cursor, int(kv.get("c", "0")), int(kv.get("r", "0")))
                    self.virtual.pop(i, None)
                    self.frames += 1
            return
        key = "cur"
        if a in ("T", "t"):
            if kv.get("t") in ("t", "f"):
                # The picture is in a file (named by the payload); a temporary one is removed once read.
                path = base64.b64decode(payload).decode()
                with open(path, "rb") as f:
                    payload = base64.b64encode(f.read())
                if kv.get("t") == "t":
                    os.remove(path)
            self._pending_apc[key] = payload
            self._pending_meta = (int(kv["i"]), self._cursor, int(kv.get("c", "0")), int(kv.get("r", "0")))
            self._pending_kind = "virtual" if kv.get("U") == "1" else "place" if a == "T" else "store"
            self._pending_format = (kv.get("f", "32"), int(kv.get("s", "0")), int(kv.get("v", "0")))
        else:
            self._pending_apc[key] = self._pending_apc.get(key, b"") + payload
        self._loading = kv.get("m", "0") == "1"
        if kv.get("m", "0") == "0":
            data = base64.b64decode(self._pending_apc.pop(key))
            f, w, h = self._pending_format
            if f in ("32", "24"):
                # Raw pixels: keep them as PNG like everything else.
                buf = io.BytesIO()
                Image.frombytes("RGBA" if f == "32" else "RGB", (w, h), data).save(buf, "PNG")
                data = buf.getvalue()
            i, (row, col), c, r = self._pending_meta
            with self.lock:
                self.images[i] = data
                if self._pending_kind == "virtual":
                    self.virtual[i] = (c, r)
                    self.placements.pop(i, None)
                    self.frames += 1
                elif self._pending_kind == "place":
                    self.placements[i] = (row, col, c, r)
                    self.virtual.pop(i, None)
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
            scaled = {}
            for y, x, i, pr, pc in self._placeholder_cells():
                if i not in scaled:
                    c, r = self.virtual[i]
                    scaled[i] = Image.open(io.BytesIO(self.images[i])).convert("RGB").resize((c * cw, r * ch))
                img.paste(scaled[i].crop((pc * cw, pr * ch, (pc + 1) * cw, (pr + 1) * ch)), (x * cw, y * ch))
        img.save(path)
        return path

    def _placeholder_cells(self):
        """Unicode placeholder cells on screen showing a known image:
        (y, x, image id, row in image, column in image). Call with the lock held."""
        found = []
        for y in range(self.rows):
            line = self.screen.buffer[y]
            for x in range(self.cols):
                cell = line[x]
                if not cell.data.startswith(PLACEHOLDER) or len(cell.data) < 3:
                    continue
                i = _COLOR_INDEX.get(cell.fg)
                pr, pc = _DIACRITIC.get(cell.data[1]), _DIACRITIC.get(cell.data[2])
                if i is None or pr is None or pc is None:
                    continue
                # A third mark is the id's most significant byte.
                i += (_DIACRITIC.get(cell.data[3], 0) << 24) if len(cell.data) > 3 else 0
                if i not in self.virtual:
                    continue
                found.append((y, x, i, pr, pc))
        return found

    def placeholder_images(self):
        """Ids of virtually placed images shown on screen, with the cell rectangle
        (row, col, cols, rows; 1-based) their placeholders cover."""
        with self.lock:
            boxes = {}
            for y, x, i, _, _ in self._placeholder_cells():
                r0, c0, r1, c1 = boxes.get(i, (y, x, y, x))
                boxes[i] = (min(r0, y), min(c0, x), max(r1, y), max(c1, x))
            return {i: (r0 + 1, c0 + 1, c1 - c0 + 1, r1 - r0 + 1) for i, (r0, c0, r1, c1) in boxes.items()}

    def unsynced_clears(self, since=0):
        """Image deletes and screen clears outside a synchronized update
        (DECSET 2026) in the output since `since`: each is a moment the
        terminal may show a pane without its picture. The goodbye on exit
        (after the last alternate-screen switch back) doesn't count."""
        raw = bytes(self.raw[since:])
        end = raw.rfind(b"\x1b[?1049l")
        if end >= 0:
            raw = raw[:max(0, raw.rfind(b"\x1b_Ga=d,d=A", 0, end))] if raw.rfind(b"\x1b_Ga=d,d=A", 0, end) >= 0 else raw[:end]
        # (Entering the alternate screen clears it before anything is drawn: not counted.)
        first = raw.find(b"\x1b[?2026h")
        raw = raw[first:] if first >= 0 else raw
        found, depth = [], False
        for m in re.finditer(rb"\x1b\[\?2026([hl])|\x1b_Ga=d[^\x1b]*|\x1b\[2J", raw):
            g = m.group(0)
            if m.group(1):
                depth = m.group(1) == b"h"
            elif not depth:
                found.append((m.start(), g[:30]))
        return found

    # -- sessions

    def server_pid(self, session="default"):
        """Pid of the session server this client talks to (None if not running)."""
        try:
            with open(os.path.join(self.runtime_dir, "termium", f"{session}.pid")) as f:
                pid = int(f.read().strip())
            os.kill(pid, 0)
            return pid
        except (OSError, ValueError):
            return None

    def kill9(self, session="default"):
        """SIGKILLs the session server and then this client: termium killed outright."""
        pid = self.server_pid(session)
        if pid:
            os.kill(pid, signal.SIGKILL)
        try:
            os.kill(self.pid, signal.SIGKILL)
            os.waitpid(self.pid, 0)
        except (ProcessLookupError, ChildProcessError):
            pass
        self.alive = False
        return pid

    def stop_server(self, session="default"):
        pid = self.server_pid(session)
        if not pid:
            return
        os.kill(pid, signal.SIGTERM)
        end = time.time() + 8
        while time.time() < end:
            try:
                os.kill(pid, 0)
            except OSError:
                return
            time.sleep(0.1)
        os.kill(pid, signal.SIGKILL)

    def close(self):
        try:
            self._close_client()
        finally:
            if self.own_runtime:
                self.stop_server()
                shutil.rmtree(self.runtime_dir, ignore_errors=True)

    def _close_client(self):
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


class _Screen(pyte.Screen):
    """pyte, except that a combining mark after a character in the last column
    joins that character (as in real terminals) instead of wrapping first."""

    def draw(self, data: str) -> None:
        if not any(unicodedata.combining(ch) for ch in data):
            return super().draw(data)
        run = ""
        for ch in data:
            if unicodedata.combining(ch) and self.cursor.x == self.columns:
                super().draw(run)
                run = ""
                line = self.buffer[self.cursor.y]
                last = line[self.columns - 1]
                line[self.columns - 1] = last._replace(data=last.data + ch)
            else:
                run += ch
                if not unicodedata.combining(ch):
                    # Flush before a base character, so cursor.x is current for the next mark.
                    super().draw(run)
                    run = ""
        if run:
            super().draw(run)


PLACEHOLDER = "\U0010EEEE"
# pyte stores 256-colour foregrounds as hex; map them back to the index (the image id).
_COLOR_INDEX: dict[str, int] = {}
for _n, _hex in enumerate(pyte.graphics.FG_BG_256):
    _COLOR_INDEX.setdefault(_hex, _n)
# ...and the 16 basic colours by name (tmux re-encodes 38;5;1 as 31, and so on).
for _code, _name in pyte.graphics.FG_ANSI.items():
    if _name != "default":
        _COLOR_INDEX[_name] = _code - 30
for _code, _name in pyte.graphics.FG_AIXTERM.items():
    _COLOR_INDEX[_name] = _code - 90 + 8
_DIACRITICS_FILE = [
    0x0305, 0x030D, 0x030E, 0x0310, 0x0312, 0x033D, 0x033E, 0x033F, 0x0346, 0x034A, 0x034B, 0x034C,
    0x0350, 0x0351, 0x0352, 0x0357, 0x035B, 0x0363, 0x0364, 0x0365, 0x0366, 0x0367, 0x0368, 0x0369,
    0x036A, 0x036B, 0x036C, 0x036D, 0x036E, 0x036F, 0x0483, 0x0484, 0x0485, 0x0486, 0x0487, 0x0592,
    0x0593, 0x0594, 0x0595, 0x0597, 0x0598, 0x0599, 0x059C, 0x059D, 0x059E, 0x059F, 0x05A0, 0x05A1,
    0x05A8, 0x05A9, 0x05AB, 0x05AC, 0x05AF, 0x05C4, 0x0610, 0x0611, 0x0612, 0x0613, 0x0614, 0x0615,
    0x0616, 0x0617, 0x0657, 0x0658, 0x0659, 0x065A, 0x065B, 0x065D, 0x065E, 0x06D6, 0x06D7, 0x06D8,
    0x06D9, 0x06DA, 0x06DB, 0x06DC, 0x06DF, 0x06E0, 0x06E1, 0x06E2, 0x06E4, 0x06E7, 0x06E8, 0x06EB,
    0x06EC, 0x0730, 0x0732, 0x0733, 0x0735, 0x0736, 0x073A, 0x073D, 0x073F, 0x0740, 0x0741, 0x0743,
    0x0745, 0x0747, 0x0749, 0x074A, 0x07EB, 0x07EC, 0x07ED, 0x07EE, 0x07EF, 0x07F0, 0x07F1, 0x07F3,
    0x0816, 0x0817, 0x0818, 0x0819, 0x081B, 0x081C, 0x081D, 0x081E, 0x081F, 0x0820, 0x0821, 0x0822,
    0x0823, 0x0825, 0x0826, 0x0827, 0x0829, 0x082A, 0x082B, 0x082C, 0x082D, 0x0951, 0x0953, 0x0954,
    0x0F82, 0x0F83, 0x0F86, 0x0F87, 0x135D, 0x135E, 0x135F, 0x17DD, 0x193A, 0x1A17, 0x1A75, 0x1A76,
    0x1A77, 0x1A78, 0x1A79, 0x1A7A, 0x1A7B, 0x1A7C, 0x1B6B, 0x1B6D, 0x1B6E, 0x1B6F, 0x1B70, 0x1B71,
    0x1B72, 0x1B73, 0x1CD0, 0x1CD1, 0x1CD2, 0x1CDA, 0x1CDB, 0x1CE0, 0x1DC0, 0x1DC1, 0x1DC3, 0x1DC4,
    0x1DC5, 0x1DC6, 0x1DC7, 0x1DC8, 0x1DC9, 0x1DCB, 0x1DCC, 0x1DD1, 0x1DD2, 0x1DD3, 0x1DD4, 0x1DD5,
    0x1DD6, 0x1DD7, 0x1DD8, 0x1DD9, 0x1DDA, 0x1DDB, 0x1DDC, 0x1DDD, 0x1DDE, 0x1DDF, 0x1DE0, 0x1DE1,
    0x1DE2, 0x1DE3, 0x1DE4, 0x1DE5, 0x1DE6, 0x1DFE, 0x20D0, 0x20D1, 0x20D4, 0x20D5, 0x20D6, 0x20D7,
    0x20DB, 0x20DC, 0x20E1, 0x20E7, 0x20E9, 0x20F0, 0x2CEF, 0x2CF0, 0x2CF1, 0x2DE0, 0x2DE1, 0x2DE2,
    0x2DE3, 0x2DE4, 0x2DE5, 0x2DE6, 0x2DE7, 0x2DE8, 0x2DE9, 0x2DEA, 0x2DEB, 0x2DEC, 0x2DED, 0x2DEE,
    0x2DEF, 0x2DF0, 0x2DF1, 0x2DF2, 0x2DF3, 0x2DF4, 0x2DF5, 0x2DF6, 0x2DF7, 0x2DF8, 0x2DF9, 0x2DFA,
    0x2DFB, 0x2DFC, 0x2DFD, 0x2DFE, 0x2DFF, 0xA66F, 0xA67C, 0xA67D, 0xA6F0, 0xA6F1, 0xA8E0, 0xA8E1,
    0xA8E2, 0xA8E3, 0xA8E4, 0xA8E5, 0xA8E6, 0xA8E7, 0xA8E8, 0xA8E9, 0xA8EA, 0xA8EB, 0xA8EC, 0xA8ED,
    0xA8EE, 0xA8EF, 0xA8F0, 0xA8F1, 0xAAB0, 0xAAB2, 0xAAB3, 0xAAB7, 0xAAB8, 0xAABE, 0xAABF, 0xAAC1,
    0xFE20, 0xFE21, 0xFE22, 0xFE23, 0xFE24, 0xFE25, 0xFE26, 0x10A0F, 0x10A38, 0x1D185, 0x1D186, 0x1D187,
    0x1D188, 0x1D189, 0x1D1AA, 0x1D1AB, 0x1D1AC, 0x1D1AD, 0x1D242, 0x1D243, 0x1D244,
]
_DIACRITIC = {chr(c): n for n, c in enumerate(_DIACRITICS_FILE)}


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
