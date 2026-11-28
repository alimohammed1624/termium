#!/usr/bin/env python3
"""Hover and press states on the chrome: real termium + real headless Helium
in a PTY, driven with SGR mouse motion and clicks.

Usage: python3 tests/hover.py [outdir]
"""
import os, shutil, socket, subprocess, sys, tempfile, time
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
from drive import Term

OUT = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="termium-hover-")
os.makedirs(OUT, exist_ok=True)
root = tempfile.mkdtemp(prefix="termium-hover-run-")
profile = os.path.join(root, "profile")
ENV = {k: os.path.join(root, k.lower()) for k in ("XDG_RUNTIME_DIR", "XDG_DATA_HOME", "XDG_STATE_HOME")}
for d in ENV.values():
    os.makedirs(d, mode=0o700)
MAIN = ["bun", os.path.join(ROOT, "src/main.ts")]

with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0)); PORT = sock.getsockname()[1]
PY = shutil.which("python3") or sys.executable
srv = subprocess.Popen([PY, "-m", "http.server", str(PORT), "--bind", "127.0.0.1",
                        "--directory", os.path.join(ROOT, "tests", "fixtures")],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.5)
URL = f"http://127.0.0.1:{PORT}/page.html"

# Catppuccin Mocha (the palette when the terminal doesn't report its colors).
BACKGROUND, BACKDROP, SURFACE, HOVER, ACCENT = "1e1e2e", "11111b", "313244", "45475a", "cba6f7"
TEXT = "cdd6f4"
HOVER_SGR = b"48;2;69;71;90"
PRESS_SGR = b"48;2;203;166;247"

failures = []
def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))
    if not cond:
        failures.append(name)

def bg(t, col, row):
    with t.lock:
        return t.screen.buffer[row - 1][col - 1].bg

def find(t, row, s):
    """1-based column where `s` starts on `row`."""
    i = t.line(row).find(s)
    return i + 1 if i >= 0 else -1

def move(t, col, row, settle=0.25):
    """Moves the pointer to a cell; returns the bytes termium wrote in reply."""
    with t.lock:
        n = len(t.raw)
    t.mouse((col - 1) * t.cell_w + t.cell_w // 2, (row - 1) * t.cell_h + t.cell_h // 2, action="move")
    time.sleep(settle)
    with t.lock:
        return bytes(t.raw[n:])

try:
    t = Term(MAIN + ["-s", "pr16-hover", "--profile", profile, URL], cols=140, rows=40, cwd=ROOT, env=ENV)
    check("page loads", t.wait_text("termium test page", 40))
    t.wait_frames(1, 30); t.wait_idle(1.5)
    tab = find(t, 1, " 1 ")
    plus = find(t, 1, " + ")
    back = find(t, 2, "←")
    check("chrome drawn", tab > 0 and plus > 0 and back > 0, f"tab={tab} plus={plus} back={back}")
    check("active tab starts unlit", bg(t, tab + 2, 1) == BACKGROUND, bg(t, tab + 2, 1))
    t.shot(f"{OUT}/0-idle.png")

    # Over the "+": it lights up, the hand pointer comes on, and the write is small.
    w = move(t, plus + 1, 1)
    check("+ lit on hover", bg(t, plus + 1, 1) == HOVER, bg(t, plus + 1, 1))
    with t.lock:
        plus_fg = t.screen.buffer[0][plus].fg
    check("hovered text brightens", plus_fg == TEXT, plus_fg)
    check("hand pointer on", b"\x1b]22;pointer\x1b\\" in w, w[-80:])
    check("hover write is small", 0 < len(w) < 200, f"{len(w)} bytes")
    print(f"  bytes for entering a span: {len(w)}")
    t.shot(f"{OUT}/1-hover-plus.png")

    # Within the same span: nothing to redraw.
    w = move(t, plus + 2, 1)
    check("move within a span writes nothing", len(w) == 0, f"{len(w)} bytes: {w[:80]!r}")

    # Onto the tab: the tab lights, the "+" goes back.
    w = move(t, tab + 3, 1)
    check("tab lit on hover", bg(t, tab + 3, 1) == HOVER, bg(t, tab + 3, 1))
    check("+ back to normal", bg(t, plus + 1, 1) == BACKDROP, bg(t, plus + 1, 1))
    check("span-to-span write is small", 0 < len(w) < 300, f"{len(w)} bytes")
    print(f"  bytes for moving between spans: {len(w)}")
    t.shot(f"{OUT}/2-hover-tab.png")

    # Over the page: the tab goes back, the pointer too.
    w = move(t, 70, 20)
    check("tab back to normal off the chrome", bg(t, tab + 3, 1) == BACKGROUND, bg(t, tab + 3, 1))
    check("hand pointer off", b"\x1b]22;default\x1b\\\x1b]22;\x1b\\" in w, w[-80:])
    w = move(t, 72, 22)
    check("moves over the page write no chrome", HOVER_SGR not in w and b"\x1b]22;" not in w, w[:80])

    # Sidebar row (the active space, drawn on the surface color) and the address bar's back button.
    w = move(t, 5, 3)
    check("sidebar row lit on hover", bg(t, 5, 3) == HOVER, bg(t, 5, 3))
    move(t, back, 2)
    check("back button lit on hover", bg(t, back, 2) == HOVER, bg(t, back, 2))

    # A click flashes the span (accent), then it's hovered again.
    with t.lock:
        n = len(t.raw)
    t.click_cell(back, 2)
    time.sleep(0.05)
    with t.lock:
        w = bytes(t.raw[n:])
    check("click flashes the button", PRESS_SGR in w, w[:120])
    check("flash shows on screen", bg(t, back, 2) == ACCENT, bg(t, back, 2))
    t.shot(f"{OUT}/3-press-back.png")
    time.sleep(0.3)
    check("flash ends, hover stays", bg(t, back, 2) == HOVER, bg(t, back, 2))

    # Clicking a tab flashes it too, through the chrome redraw the click causes.
    move(t, tab + 3, 1)
    with t.lock:
        n = len(t.raw)
    t.click_cell(tab + 3, 1)
    time.sleep(0.06)
    with t.lock:
        w = bytes(t.raw[n:])
    check("tab click flashes", PRESS_SGR in w)
    time.sleep(0.3)
    check("tab hovered after the flash", bg(t, tab + 3, 1) == HOVER, bg(t, tab + 3, 1))

    # Motion while an overlay (help) is up still counts: closing it lights what's under the pointer now.
    move(t, tab + 3, 1)
    t.key("ctrl+b"); t.key("question"); time.sleep(0.5)
    move(t, 70, 20)
    t.key("escape"); time.sleep(0.5)
    check("after help, the old span isn't relit", bg(t, tab + 3, 1) == BACKGROUND, bg(t, tab + 3, 1))

    # A drag on the page released over the "+": lit once the button is up.
    plus = find(t, 1, " + ")  # (the back click went to the previous page: the tab's title changed)
    t.mouse(700, 400, action="press")
    for x in range(700, (plus - 1) * t.cell_w, -60):
        t.mouse(x, 400 - (400 - 10) * (700 - x) // 700, action="drag")
        time.sleep(0.01)
    t.mouse(plus * t.cell_w, 10, action="drag")
    time.sleep(0.2)
    check("no hover while dragging a page", bg(t, plus + 1, 1) == BACKDROP, bg(t, plus + 1, 1))
    t.mouse(plus * t.cell_w, 10, action="release")
    time.sleep(0.25)
    check("+ lit after the drag's release", bg(t, plus + 1, 1) == HOVER, bg(t, plus + 1, 1))

    # A page drag whose button comes up under the help overlay: the page lets go, hover comes back.
    move(t, 70, 20)
    t.mouse(700, 400, action="press")
    t.mouse(640, 380, action="drag"); time.sleep(0.1)
    t.key("ctrl+b"); t.key("question"); time.sleep(0.5)
    t.mouse(plus * t.cell_w, 10, action="drag"); time.sleep(0.1)
    t.mouse(plus * t.cell_w, 10, action="release"); time.sleep(0.1)
    t.key("escape"); time.sleep(0.5)
    check("released over + under an overlay: lit once it closes", bg(t, plus + 1, 1) == HOVER, bg(t, plus + 1, 1))
    move(t, tab + 3, 1)
    check("hover works after a release under an overlay", bg(t, tab + 3, 1) == HOVER, bg(t, tab + 3, 1))

    # A second tab; closing the tab that is flashing doesn't pass the flash on.
    move(t, 70, 20)
    t.key("ctrl+t"); time.sleep(0.5); t.type(URL); t.key("enter")
    check("second tab", t.wait_for(lambda: " 2 " in t.line(1), 20))
    t.wait_idle(1.0)
    t.click_cell(tab + 3, 1)
    time.sleep(0.03)
    t.key("ctrl+w")
    time.sleep(0.06)
    check("the tab taking the closed one's place doesn't flash", bg(t, tab + 3, 1) != ACCENT, bg(t, tab + 3, 1))

    # A burst of motion over the page and chrome stays cheap.
    with t.lock:
        n = len(t.raw)
    for i in range(40):
        t.mouse(400 + i * 5, 400, action="move")
        time.sleep(0.005)
    time.sleep(0.4)
    with t.lock:
        w = bytes(t.raw[n:])
    check("40 moves over the page: no chrome redraw", HOVER_SGR not in w, f"{len(w)} bytes")
    print(f"  bytes for 40 moves over the page: {len(w)}")
    t.close()
finally:
    srv.terminate()
    # The session's own runtime dir means Term.close() leaves its server: stop it.
    subprocess.run(MAIN + ["kill", "pr16-hover"], env={**os.environ, **ENV}, capture_output=True)
    shutil.rmtree(root, ignore_errors=True)

print(f"\nscreenshots: {OUT}")
if failures:
    print(f"{len(failures)} FAILED: {failures}")
    sys.exit(1)
print("all passed")
