#!/usr/bin/env python3
"""termium inside tmux and inside herdr, against the real stack.

The outer terminal is drive.Term (it answers like Ghostty and composites
kitty graphics, including virtual placements shown through unicode
placeholders). Inside it run a private tmux server (its own -L socket and
config) and then a private, uniquely named herdr session; termium runs in
their panes. Neither touches any tmux server or herdr session of the user's.

Checks: the tmux allow-passthrough hint, pictures in a tmux split (through
placeholders, at the pane's position), keyboard input, detach with the
multiplexer's prefix pressed twice, re-attach from another pane of another
size, pane zoom, and the same in herdr (which re-renders images itself).

Usage: python3 tests/multiplexers.py [outdir]   (screenshots land in outdir)
"""
import json, os, shutil, signal, socket, subprocess, sys, tempfile, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
from drive import Term

failures = []
def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))
    if not cond:
        failures.append(name)

main = os.path.join(ROOT, "src", "main.ts")
OUT = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="termium-mux-")
os.makedirs(OUT, exist_ok=True)
tmp = tempfile.mkdtemp(prefix="tmx-")
rt = os.path.join(tmp, "run"); os.makedirs(rt)
ENV = {"XDG_RUNTIME_DIR": rt, "TERMIUM_TEST_DEVTOOLS_PORT": "1",
       "XDG_DATA_HOME": os.path.join(tmp, "data"), "XDG_STATE_HOME": os.path.join(tmp, "state")}
# herdr runs from a home of its own: a fresh default config (as a new user has
# it), and its sessions live there, never next to the user's.
HOME = os.path.join(tmp, "home"); os.makedirs(HOME)
HENV = dict(ENV, HOME=HOME, XDG_CONFIG_HOME=os.path.join(HOME, ".config"), SHELL="/bin/bash")
sockdir = os.path.join(rt, "termium")
TMUX_SOCK = f"termium-test-{os.getpid()}"
HERDR = shutil.which("herdr") or os.path.expanduser("~/.local/bin/herdr")
HERDR_SESSION = f"termium-test-{os.getpid()}"
BG = (0x33, 0x33, 0xcc)
PAGE = "data:text/html,<body style=\"background:%233333cc;color:white;font:40px sans-serif\"><h1>termium in a pane</h1>"

with socket.socket() as so:
    so.bind(("127.0.0.1", 0)); PORT = so.getsockname()[1]
srv = subprocess.Popen([shutil.which("python3") or sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1",
                        "--directory", os.path.join(ROOT, "tests", "fixtures")], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.5)
BASE = f"http://127.0.0.1:{PORT}"

def cli(*args):
    return subprocess.run(["bun", main, *args], cwd=ROOT, env=dict(os.environ, **ENV), capture_output=True, text=True, timeout=40)

def tmux(*args):
    return subprocess.run(["tmux", "-L", TMUX_SOCK, *args], capture_output=True, text=True)

def server_pid(session="default"):
    try:
        pid = int(open(os.path.join(sockdir, f"{session}.pid")).read())
        os.kill(pid, 0)
        return pid
    except (OSError, ValueError):
        return None

def state(profile):
    r = subprocess.run(["bun", os.path.join(ROOT, "tests/support/cdp-eval.ts"), profile, "window.termiumState ? termiumState() : null"],
                       capture_output=True, text=True, timeout=20)
    for p in json.loads(r.stdout or "[]"):
        if "page.html" in p["url"] and p["value"]:
            return p["value"]
    return None

def shows_page(t, rect, path):
    """The composited screen has the test page's colour in the middle of rect (row, col, cols, rows)."""
    t.shot(path)
    from PIL import Image
    im = Image.open(path).convert("RGB")
    row, col, cols, rows = rect
    x = (col - 1 + cols // 2) * t.cell_w
    y = (row - 1 + rows // 2) * t.cell_h
    px = im.getpixel((x, y))
    return all(abs(a - b) < 12 for a, b in zip(px, BG)), px

def newest_placement(t):
    with t.lock:
        return t.placements[max(t.placements)] if t.placements else None

def run_in(t, cmd):
    """Types a shell command into the focused pane."""
    t.write(cmd + "\r")

try:
    # ------------------------------------------------------------- tmux
    conf = os.path.join(tmp, "tmux.conf")
    with open(conf, "w") as f:
        f.write("set -g status off\nset -g escape-time 10\n")
    prof = os.path.join(tmp, "tmux-profile")
    t = Term(["tmux", "-L", TMUX_SOCK, "-f", conf, "new-session", "-s", "main", "-x", "160", "-y", "45"],
             cols=160, rows=45, env=ENV)
    time.sleep(1.5)

    tmux("send-keys", "-t", "main", f"cd {ROOT} && bun src/main.ts --profile {prof}; echo EXIT=$?", "Enter")
    check("tmux: passthrough off gives a clear hint", t.wait_text("allow-passthrough", 15) and t.wait_text("EXIT=2", 10),
          tmux("capture-pane", "-p", "-t", "main").stdout[-400:])
    check("tmux: ...and starts no session", server_pid() is None)
    tmux("send-keys", "-t", "main", "clear", "Enter"); time.sleep(0.5)

    tmux("set", "-g", "allow-passthrough", "on")
    tmux("split-window", "-h", "-t", "main")
    # Everything written into the two panes (by termium, before tmux), to check what termium itself sends.
    pane_out = [os.path.join(tmp, f"pane{i}.out") for i in (0, 1)]
    for i in (0, 1):
        tmux("pipe-pane", "-t", f"main.{i}", f"cat >> {pane_out[i]}")
    tmux("select-pane", "-t", "main.1")  # termium starts in pane 0 while pane 1 is the active one
    panes = tmux("list-panes", "-t", "main", "-F", "#{pane_left} #{pane_width} #{pane_height}").stdout.split("\n")
    (l0, w0, h0), (l1, w1, h1) = [tuple(map(int, p.split())) for p in panes[:2]]
    tmux("send-keys", "-t", "main.0", f"bun src/main.ts --profile {prof} '{PAGE}'", "Enter")
    check("tmux: starting in a pane that isn't the active one works (no hint)", t.wait_frames(1, 40)
          and "allow-passthrough" not in tmux("capture-pane", "-p", "-t", "main.0").stdout,
          tmux("capture-pane", "-p", "-t", "main.0").stdout[-300:])
    time.sleep(2)
    check("tmux: ...without typing terminal answers into the active pane's shell",
          "Gi=" not in tmux("capture-pane", "-p", "-t", "main.1").stdout, tmux("capture-pane", "-p", "-t", "main.1").stdout[-300:])
    mark = len(t.raw)
    tmux("select-pane", "-t", "main.0")
    import re as _re
    check("tmux: once its pane is active, pictures switch to temporary files",
          t.wait_for(lambda: _re.search(rb"\x1b_Ga=T[^;\x1b]*,t=t;", bytes(t.raw[mark:])) is not None, 15))
    want = (3, l0 + 1 + 22, w0 - 22, h0 - 2)
    check("tmux: the page is drawn through placeholders in its pane", t.wait_for(lambda: want in t.placeholder_images().values(), 15),
          (t.placeholder_images(), want))
    time.sleep(1)
    ok, px = shows_page(t, want, f"{OUT}/tmux-split.png")
    check("tmux: the placeholders show the page's picture", ok, px)
    check("tmux: no image is placed at a cell (only virtual placements)", not t.placements, t.placements)
    rgb = "RGB" in tmux("display-message", "-p", "#{client_termfeatures}").stdout.split(",")
    check("tmux: placeholder ids are 24-bit colours where the terminal shows RGB", not rgb or all((i & 0xFFFFFF) > 255 for i in t.placeholder_images()),
          (rgb, list(t.placeholder_images())))
    check("tmux: temporary files have unguessable names, mode 0600, and are no symlinks",
          t.graphics_files and all(_re.fullmatch(r"termium-tty-graphics-protocol-[0-9a-f]{32}", n) and m == 0o600 and not l
                                   for n, m, l in t.graphics_files), t.graphics_files[:3])

    # keyboard through tmux: address bar, then a page with state
    t.write("\x0c"); time.sleep(0.4)  # Ctrl+L
    t.write(f"{BASE}/page.html\r")
    check("tmux: keyboard input reaches termium", t.wait_for(lambda: state(prof) is not None, 25))

    # switching tabs: the old picture is deleted only after the new one and its cells are out
    t.write("\x14"); time.sleep(1); t.write(f"{PAGE}\r")  # Ctrl+T, a second tab
    t.wait_for(lambda: len(t.virtual) >= 2, 20); time.sleep(2)
    mark = len(t.raw)
    t.write("\x02"); time.sleep(0.2); t.write("\x02"); time.sleep(0.2); t.write("p")  # previous tab
    time.sleep(3)
    import re as _re
    seg = bytes(t.raw[mark:])
    sends = [(m.start(), int(m.group(1))) for m in _re.finditer(rb"\x1b_Ga=T[^;\x1b]*i=(\d+)", seg)]
    dels = [(m.start(), int(m.group(1))) for m in _re.finditer(rb"\x1b_Ga=d,d=I,i=(\d+)", seg)]
    first_send = sends[0][0] if sends else None
    synced = first_send is not None and dels and all(seg.find(b"\x1b[?2026l", first_send) not in (-1,) and seg.find(b"\x1b[?2026l", first_send) < d for d, _ in dels)
    check("tmux: on a tab switch the old picture goes after the new one and a finished redraw", bool(sends) and bool(dels) and synced,
          (sends[:3], dels[:3]))

    # detach with tmux's prefix pressed twice (tmux sends one Ctrl+B through)
    spid = server_pid()
    t.write("\x02"); time.sleep(0.2); t.write("\x02"); time.sleep(0.2); t.write("d")
    check("tmux: Ctrl+B Ctrl+B d detaches termium", t.wait_text("[detached (from session default)]", 10),
          tmux("capture-pane", "-p", "-t", "main.0").stdout[-300:])
    check("tmux: the session survives", server_pid() == spid and "detached" in cli("ls").stdout)

    # re-attach from the other pane, which is a different size
    tmux("select-pane", "-t", "main.1")
    tmux("send-keys", "-t", "main.1", f"cd {ROOT} && bun src/main.ts attach", "Enter")
    want = (3, l1 + 1 + 22, w1 - 22, h1 - 2)
    check("tmux: re-attach in another pane draws there at its size", t.wait_for(lambda: want in t.placeholder_images().values(), 20),
          (t.placeholder_images(), want, tmux("capture-pane", "-p", "-t", "main.1").stdout[-600:]))
    check("tmux: re-attach redraws the chrome", t.wait_text("termium test page", 10))
    time.sleep(1.5)
    t.shot(f"{OUT}/tmux-reattached.png")

    tmux("resize-pane", "-Z", "-t", "main.1")
    want = (3, 23, 160 - 22, 45 - 2)
    check("tmux: zooming the pane resizes the page", t.wait_for(lambda: want in t.placeholder_images().values(), 15),
          (t.placeholder_images(), want))
    zoomed = lambda: (state(prof) or {}).get("w") == 160 * 10 - 220 and (state(prof) or {}).get("h") == 43 * 20
    check("tmux: the viewport follows the zoomed pane", t.wait_for(zoomed, 10, 0.5), state(prof) and (state(prof)["w"], state(prof)["h"]))
    t.shot(f"{OUT}/tmux-zoomed.png")

    # a pane wider than placeholders can address (297 cells) is cut into tiles
    t.resize(360, 45)
    tiles = lambda: sorted(r for r in t.placeholder_images().values() if r[0] == 3)
    want_tiles = [(3, 23, 169, 43), (3, 192, 169, 43)]
    check("tmux: a 338-cell-wide page is drawn as two tiles", t.wait_for(lambda: tiles() == want_tiles, 20), (tiles(), want_tiles))
    time.sleep(1)
    from PIL import Image as _Image
    import io as _io
    def tile_sizes():
        shown = [i for i, r in t.placeholder_images().items() if r[0] == 3]  # (takes the lock itself)
        with t.lock:
            return sorted(_Image.open(_io.BytesIO(t.images[i])).size for i in shown if i in t.images)
    check("tmux: ...each tile holds its half of the page at full resolution", tile_sizes() == [(1690, 860), (1690, 860)], tile_sizes())
    t.shot(f"{OUT}/tmux-wide.png")
    t.resize(160, 45)
    check("tmux: back to one image when it fits again", t.wait_for(lambda: tiles() == [(3, 23, 138, 43)], 20), tiles())

    # large pictures (random pixels barely compress), both ways of sending them (pane still zoomed)
    t.write("\x0c"); time.sleep(0.4); t.write(f"{BASE}/noise.html\r")
    big = lambda: any(len(t.images.get(i, b"")) > 1_000_000 for i in t.virtual)
    check("tmux: a large picture arrives whole as a file", t.wait_for(big, 25), {i: len(t.images.get(i, b"")) for i in t.virtual})
    # hidden (another tmux window in front): no pictures, no files; shown again: drawn again
    t.write("\x0c"); time.sleep(0.4); t.write(f"{BASE}/anim.html\r"); time.sleep(5)
    pipe = pane_out[1]
    time.sleep(1)
    tmux("new-window", "-d", "-t", "main:9"); tmux("select-window", "-t", "main:9")
    time.sleep(2)
    hidden_from = os.path.getsize(pipe) if os.path.exists(pipe) else 0
    time.sleep(4)
    hidden = open(pipe, "rb").read()[hidden_from:] if os.path.exists(pipe) else b""
    check("tmux: while its window is hidden, an animating page sends no pictures", hidden.count(b"a=T") == 0, hidden.count(b"a=T"))
    shown_from = len(hidden) + hidden_from
    tmux("select-window", "-t", "main:0")
    t.wait_for(lambda: b"a=T" in open(pipe, "rb").read()[shown_from:], 8)
    check("tmux: shown again, it draws again", b"a=T" in open(pipe, "rb").read()[shown_from:])
    tmux("kill-window", "-t", "main:9")
    time.sleep(1)

    # a second session in the other pane: its attach, detach and quit leave this picture alone
    if tmux("display-message", "-p", "-t", "main", "#{window_zoomed_flag}").stdout.strip() == "1":
        tmux("resize-pane", "-Z", "-t", "main.1")  # unzoom: both panes visible (-Z toggles)
    time.sleep(1.5)
    mine = lambda: [i for i, r in t.placeholder_images().items() if r[1] > l1]
    check("tmux: (precondition) this session's picture is in pane 1", t.wait_for(lambda: len(mine()) == 1, 15), t.placeholder_images())
    a_id = mine()[0] if mine() else None
    tmux("send-keys", "-t", "main.0", "clear", "Enter")
    tmux("send-keys", "-t", "main.0", f"bun src/main.ts -s other --incognito '{PAGE}'", "Enter")
    t.wait_for(lambda: len(t.placeholder_images()) >= 2, 30)
    tmux("send-keys", "-t", "main.0", "C-b", "d"); time.sleep(2)
    tmux("send-keys", "-t", "main.0", "bun src/main.ts attach other", "Enter"); time.sleep(5)
    tmux("send-keys", "-t", "main.0", "C-q"); time.sleep(4)
    check("tmux: another session's attach, detach and quit leave this pane's picture",
          a_id in t.images and a_id in t.virtual and a_id in t.placeholder_images(), (a_id, list(t.virtual)))
    check("tmux: the other session ended", server_pid("other") is None)
    r = cli("kill")
    check("tmux: kill ends the session", r.returncode == 0 and server_pid() is None, r.stderr)
    tmux("send-keys", "-t", "main.1", "clear", "Enter")
    time.sleep(0.5)
    before = len(t.raw)
    tmux("send-keys", "-t", "main.1", f"TERMIUM_TMUX_FILES=0 bun src/main.ts --profile {prof} {BASE}/noise.html", "Enter")
    big_now = lambda: any(len(t.images.get(i, b"")) > 1_000_000 for i in t.virtual) and b"\x1b_Gm=1;" in bytes(t.raw[before:])
    check("tmux: without files, a large picture arrives whole in paced chunks", t.wait_for(big_now, 40),
          {i: len(t.images.get(i, b"")) for i in t.virtual})
    def interleaved(path):
        """Graphics commands termium wrote inside one of its own chunked transfers (not counting
        what tmux may drop on the way: that's checked at the source, the pane's input)."""
        raw = open(path, "rb").read() if os.path.exists(path) else b""
        bad, loading = [], False
        for m in _re.finditer(rb"\x1bPtmux;((?:[^\x1b]|\x1b\x1b)*)\x1b\\", raw):
            inner = m.group(1).replace(b"\x1b\x1b", b"\x1b")
            c = _re.match(rb"\x1b_G([^;\x1b]*)", inner)
            if not c:
                continue
            ctrl = c.group(1)
            kv = dict(p.split(b"=", 1) for p in ctrl.split(b",") if b"=" in p)
            if loading and not (set(kv) <= {b"m", b"q"}):
                bad.append(ctrl[:50])
            loading = kv.get(b"m") == b"1"
        return bad
    bad = interleaved(pane_out[0]) + interleaved(pane_out[1])
    check("tmux: termium never sends a graphics command inside one of its chunked transfers", not bad, bad[:5])
    r = cli("kill")
    check("tmux: kill ends the second session", r.returncode == 0 and server_pid() is None, r.stderr)
    tmux("kill-server")
    t.close()

    # ------------------------------------------------------------- herdr
    if not os.path.exists(HERDR):
        print("SKIP herdr: not installed")
    else:
        hprof = os.path.join(tmp, "herdr-profile")
        h = Term([HERDR, "--session", HERDR_SESSION], cols=160, rows=45, env=HENV)
        hc = lambda *a: subprocess.run([HERDR, "--session", HERDR_SESSION, *a], capture_output=True, text=True, env=dict(os.environ, **HENV))
        def shell_ready(pane_id, timeout=30):
            """The pane's shell has drawn its prompt and gone quiet (typing earlier can be mangled)."""
            last, since, end = None, time.time(), time.time() + timeout
            while time.time() < end:
                text = hc("pane", "read", pane_id, "--source", "visible").stdout.strip()
                if text != last:
                    last, since = text, time.time()
                elif text and time.time() - since > 1.5:
                    return True
                time.sleep(0.3)
            return False
        h.wait_for(lambda: hc("pane", "list").returncode == 0 and '"panes"' in hc("pane", "list").stdout, 20)
        first = next((p["pane_id"] for p in json.loads(hc("pane", "list").stdout).get("result", {}).get("panes", []) if p.get("focused")), None)
        # A first run shows an introduction that takes every key: continue (Enter), then close it (Esc).
        onboarding = lambda: "continue" in h.text() or "integration" in h.text().lower()
        for _ in range(6):
            if not h.wait_for(onboarding, 3):
                break
            h.write("\r" if "continue" in h.text() else "\x1b"); time.sleep(1)
        check("herdr: the first-run introduction is out of the way", not onboarding(), h.text()[-600:])
        check("herdr: its shell is ready", first is not None and shell_ready(first))
        # Keys typed on the outer terminal reach the pane (not herdr's own UI) before any are relied on.
        marker = f"ready{os.getpid()}"
        h.write(f"echo {marker}x\r")
        check("herdr: typing reaches the pane", h.wait_for(lambda: f"{marker}x" in hc("pane", "read", first, "--source", "visible").stdout, 10))
        hc("pane", "run", first, f"cd {ROOT} && bun src/main.ts --profile {hprof} '{PAGE}'")
        check("herdr: frames reach the outer terminal", h.wait_frames(1, 40))
        time.sleep(1.5)
        pl = newest_placement(h)
        ok, px = shows_page(h, pl, f"{OUT}/herdr.png") if pl else (False, None)
        check("herdr: the page's picture is placed in the pane", ok, (pl, px))
        spid = server_pid()
        h.write("\x02"); time.sleep(0.3); h.write("\x02"); time.sleep(0.3); h.write("d")
        check("herdr: Ctrl+B Ctrl+B d detaches termium", h.wait_text("[detached (from session default)]", 10), h.text()[:600])
        check("herdr: the session survives", server_pid() == spid and "detached" in cli("ls").stdout)
        import re as _re
        r = hc("pane", "split", first, "--direction", "down", "--cwd", ROOT)
        new = [x for x in _re.findall(r'"pane_id":"([^"]+)"', r.stdout) if x != first]
        check("herdr: the new pane's shell is ready", bool(new) and shell_ready(new[0]))
        before = h.frames
        hc("pane", "run", new[0] if new else first, "bun src/main.ts attach")
        check("herdr: re-attach from a new, smaller pane draws", h.wait_for(lambda: h.frames > before, 25), r.stdout[-300:] + r.stderr[-300:])
        time.sleep(1.5)
        pl2 = newest_placement(h)
        check("herdr: ...at the new pane's size", pl and pl2 and pl2[3] < pl[3] and pl2[0] > pl[0], (pl, pl2, r.stdout[-300:], r.stderr[-300:], h.text()[-1500:]))
        ok, px = shows_page(h, pl2, f"{OUT}/herdr-reattached.png") if pl2 else (False, None)
        check("herdr: ...showing the page", ok, px)
        r = cli("kill")
        check("herdr: kill ends the session", r.returncode == 0 and server_pid() is None, r.stderr)
finally:
    tmux("kill-server")
    if os.path.exists(HERDR):
        henv = dict(os.environ, **HENV)
        subprocess.run([HERDR, "session", "stop", HERDR_SESSION], capture_output=True, env=henv)
        time.sleep(1)
        subprocess.run([HERDR, "session", "delete", HERDR_SESSION], capture_output=True, env=henv)
    for x in [x for x in globals().values() if isinstance(x, Term)]:
        if x.alive:
            try:
                x.close()
            except Exception:
                pass
    for name in ("default", "other"):
        pid = server_pid(name)
        if pid:
            os.kill(pid, signal.SIGTERM)
            time.sleep(3)
    srv.terminate()
    shutil.rmtree(tmp, ignore_errors=True)

print("FAILED: " + ", ".join(failures) if failures else "ALL PASSED")
sys.exit(1 if failures else 0)
