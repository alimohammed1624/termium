#!/usr/bin/env python3
"""The address row as a status line (#15): where a hovered link goes, and a
chrome control's action and keybind after a pause. Real termium + real
headless Helium in a PTY, driven with SGR mouse motion.

Usage: python3 tests/status.py [outdir]
"""
import os, shutil, socket, subprocess, sys, tempfile, time
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
from drive import Term

OUT = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="termium-status-")
os.makedirs(OUT, exist_ok=True)
root = tempfile.mkdtemp(prefix="termium-status-run-")
profile = os.path.join(root, "profile")
ENV = {k: os.path.join(root, k.lower()) for k in ("XDG_RUNTIME_DIR", "XDG_DATA_HOME", "XDG_STATE_HOME")}
for d in ENV.values():
    os.makedirs(d, mode=0o700)
MAIN = ["bun", os.path.join(ROOT, "src/main.ts")]
SESSION = os.environ.get("STATUS_SESSION", "pr15-status")

with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0)); PORT = sock.getsockname()[1]
PY = shutil.which("python3") or sys.executable
srv = subprocess.Popen([PY, "-m", "http.server", str(PORT), "--bind", "127.0.0.1",
                        "--directory", os.path.join(ROOT, "tests", "fixtures")],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.5)
URL = f"http://127.0.0.1:{PORT}/links.html"
HOST = f"127.0.0.1:{PORT}"
TEXT = "cdd6f4"  # Catppuccin Mocha text (bright)

failures = []
def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))
    if not cond:
        failures.append(name)

def fg(t, col, row):
    with t.lock:
        return t.screen.buffer[row - 1][col - 1].fg

def move(t, col, row, settle=0.3):
    t.mouse((col - 1) * t.cell_w + t.cell_w // 2, (row - 1) * t.cell_h + t.cell_h // 2, action="move")
    time.sleep(settle)

try:
    t = Term(MAIN + ["-s", SESSION, "--profile", profile, URL], cols=140, rows=40, cwd=ROOT, env=ENV)
    check("page loads", t.wait_text("termium links", 40))
    t.wait_frames(1, 30); t.wait_idle(1.5)
    addr = t.line(2)
    check("address shows the page", f"{HOST}/links.html" in addr, addr)

    # The page: rows 3..40 (one pane, no header), each band 20% of it.
    top, bottom = 3, t.rows
    def band(frac):
        return top + int((bottom - top + 1) * frac)
    col = 80

    # A plain link: its target, host bright, path dim.
    move(t, col, band(0.1), 0.6)
    line = t.line(2)
    check("plain link shows its target", f"{HOST}/page.html?from=links" in line, line)
    h = line.find(HOST) + 1
    p = line.find("/page.html") + 1
    check("host bright", fg(t, h, 2) == TEXT, fg(t, h, 2))
    check("path dim", fg(t, p + 1, 2) not in (TEXT, "default"), fg(t, p + 1, 2))
    check("current address not shown meanwhile", "/links.html" not in line, line)
    t.shot(f"{OUT}/1-link-plain.png")

    # Off the link (onto plain text): the address comes back.
    move(t, col, band(0.5), 0.6)
    check("address restored off a link", f"{HOST}/links.html" in t.line(2), t.line(2))

    # A long link: cut at its end, the host stays in view.
    move(t, col, band(0.3), 0.6)
    line = t.line(2)
    check("long link: host shown", f"{HOST}/a/very/long/path" in line, line)
    check("long link: cut with an ellipsis", "…" in line, line)
    t.shot(f"{OUT}/2-link-long.png")

    # A link inside an out-of-process (cross-site) iframe, then a same-site one.
    move(t, col, band(0.7), 0.8)
    check("link in a cross-site iframe", "example.org/inside/a/frame?x=1" in t.line(2), t.line(2))
    move(t, col, band(0.5), 0.6)
    check("restored after the iframe", f"{HOST}/links.html" in t.line(2), t.line(2))
    move(t, col, band(0.9), 0.8)
    check("link in a same-site iframe", "example.org/inside/a/frame?x=1" in t.line(2), t.line(2))

    # Straight from a link onto the chrome: the address comes back.
    move(t, col, band(0.1), 0.6)
    check("link again", "page.html?from=links" in t.line(2), t.line(2))
    move(t, 120, 1, 0.6)
    check("restored when the pointer leaves the page", f"{HOST}/links.html" in t.line(2), t.line(2))

    # Chrome controls: nothing at first, the action and keybind after the pause.
    def hint_after(col_, row_, want, name):
        move(t, 120, 1, 0.8)  # over nothing; the hint goes and the warm-up ends
        move(t, col_, row_, 0.15)
        early = want in t.line(2)
        time.sleep(0.6)
        line = t.line(2)
        check(f"{name}: no hint before the pause", not early, line)
        check(f"{name}: '{want}' after it", want in line, line)
        check(f"{name}: address still shown", "http://127.0.0.1" in line, line)
        return line

    back = t.line(2).find("←") + 1
    hint_after(back, 2, "Back  Alt+←", "back")
    t.shot(f"{OUT}/3-hint-back.png")
    hint_after(back + 3, 2, "Forward  Alt+→", "forward")
    hint_after(back + 6, 2, "Reload page  ^R", "reload")
    hint_after(back + 20, 2, "Edit address  ^L", "address")
    tab = t.line(1).find(" 1 ") + 1
    hint_after(tab + 2, 1, "Go to tab 1 · middle-click closes  ^B 1", "tab")
    t.shot(f"{OUT}/4-hint-tab.png")
    plus = t.line(1).find(" + ") + 1
    hint_after(plus + 1, 1, "New tab  ^T", "new tab")
    hint_after(5, 3, "Go to space 1  ^B w 1", "sidebar space")
    newspace = next((r for r in range(3, t.rows) if "+ new space" in t.line(r)), -1)
    hint_after(5, newspace, "New space  ^B N", "new space")

    # Moving along the tabs once a hint shows: the next one's comes at once.
    move(t, plus + 1, 1, 0.15)
    check("next control's hint at once", "New tab  ^T" in t.line(2), t.line(2))

    # Off the chrome: the hint goes.
    move(t, col, band(0.5), 0.6)
    check("hint gone off the chrome", "^T" not in t.line(2) and f"{HOST}/links.html" in t.line(2), t.line(2))

    # A split: pane titles get theirs.
    t.key("ctrl+b"); t.key("v"); time.sleep(0.5); t.type(URL); t.key("enter")
    t.wait_idle(1.5)
    header = next((r for r in range(3, 6) if "termium links" in t.line(r)), -1)
    check("pane headers", header > 0, t.line(3))
    hint_after(60, header, "Focus pane · middle-click closes  ^B h", "pane title")

    # Narrow: the keybind stays when the hint is cut.
    t.resize(70, 30); time.sleep(1.0); t.wait_idle(1.0)
    move(t, 60, 20, 0.6)
    back = t.line(2).find("←") + 1
    hint_after(back + 6, 2, "^R", "reload (narrow)")
    t.shot(f"{OUT}/5-hint-narrow.png")
    t.close()
finally:
    srv.terminate()
    subprocess.run(MAIN + ["kill", SESSION], env={**os.environ, **ENV}, capture_output=True)
    shutil.rmtree(root, ignore_errors=True)

print(f"\nscreenshots: {OUT}")
if failures:
    print(f"{len(failures)} FAILED: {failures}")
    sys.exit(1)
print("all passed")
