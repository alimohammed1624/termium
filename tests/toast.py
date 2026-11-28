#!/usr/bin/env python3
"""Toasts: stacked in the pages' bottom-right corner, with a shrinking timer
line; hovering pauses one, a click dismisses it. Real termium + real
headless Helium in a Ghostty-like PTY.

Usage: python3 tests/toast.py
"""
import os, shutil, socket, subprocess, sys, tempfile, time
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
from drive import Term

profile = tempfile.mkdtemp(prefix="termium-toast-profile-")
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0)); PORT = sock.getsockname()[1]
PY = shutil.which("python3") or sys.executable
srv = subprocess.Popen([PY, "-m", "http.server", str(PORT), "--bind", "127.0.0.1",
                        "--directory", os.path.join(ROOT, "tests", "fixtures")],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.5)

failures = []
def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))
    if not cond: failures.append(name)

COLS, ROWS = 120, 36
OFF = "Update news is off"

def rows_with(s):
    return [i + 1 for i, l in enumerate(t.screen.display) if s in l]

def toast_cell(s):
    """(col, row), 1-based, of the first cell of `s` on screen."""
    for i, l in enumerate(t.screen.display):
        if s in l:
            return l.index(s) + 1, i + 1
    return None

def hover(col, row):
    t.mouse((col - 1) * t.cell_w + 3, (row - 1) * t.cell_h + 3, action="move")

t = Term(["bun", os.path.join(ROOT, "src/main.ts"), "--profile", profile,
          f"http://127.0.0.1:{PORT}/page.html"], cols=COLS, rows=ROWS, cwd=ROOT)
try:
    t.wait_text("termium test page", 30); t.wait_idle(0.8, 10)

    # A toast: bottom right of the pane, not on the address line, with a timer line.
    t.key("ctrl+b"); t.key("shift+u")
    check("toast shows", t.wait_text(OFF, 5), t.text()[-400:])
    rs = rows_with("Update news")
    check("toast isn't on the address line", OFF not in t.line(2) and rs and rs[0] > ROWS // 2, (t.line(2), rs))
    bar_row = rs[-1] + 1
    while bar_row <= ROWS and "▂" not in t.line(bar_row) and bar_row - rs[-1] < 4:
        bar_row += 1
    bar = lambda: t.line(bar_row).rstrip()
    first = bar()
    check("timer line under it", "▂" in first, first)
    time.sleep(1.2)
    check("timer line shrinks", len(bar().replace(" ", "")) < len(first.replace(" ", "")), (first, bar()))

    # A second toast stacks above it; both show.
    t.key("ctrl+b"); t.key("shift+u")  # the same note again starts over (no copy)
    time.sleep(0.4)
    check("the same note isn't stacked twice", len(rows_with("Update news")) == 1, rows_with("Update news"))
    t.key("ctrl+a"); t.key("ctrl+c")
    check("a second toast shows", t.wait_text("Copied", 5), t.text()[-400:])
    check("both show at once, the newest below", t.wait_for(lambda: rows_with("Update news") and rows_with("Copied")
          and rows_with("Copied")[0] > rows_with("Update news")[0], 3), (rows_with("Update news"), rows_with("Copied")))

    # Hover pauses: the 1.5 s "Copied" toast stays while the pointer is on it.
    col, row = toast_cell("Copied")
    hover(col + 2, row)
    time.sleep(2.5)
    check("hovered toast stays past its time", rows_with("Copied"), t.text()[-400:])
    hover(10, 10)
    check("...and goes once the pointer leaves", t.wait_for(lambda: not rows_with("Copied"), 4))
    check("the other one moved down into its place", rows_with("Update news") and rows_with("Update news")[-1] >= ROWS - 4,
          rows_with("Update news"))

    # A click dismisses.
    col, row = toast_cell("Update news")
    t.click_cell(col + 2, row)
    check("a click dismisses it", t.wait_for(lambda: OFF not in t.text(), 2), t.text()[-400:])
    time.sleep(0.5)
    check("the corner is clear again", not any("▂" in l for l in t.screen.display[ROWS - 6:]), t.screen.display[ROWS - 6:])

    # Expiry: one left alone goes by itself (the pointer off it: a toast
    # that comes up under the pointer waits too).
    hover(10, 10)
    t.key("ctrl+b"); t.key("shift+u")
    t.wait_text(OFF, 5)
    check("an untouched toast expires", t.wait_for(lambda: OFF not in t.text(), 8))
finally:
    t.close()
    srv.terminate()
    shutil.rmtree(profile, ignore_errors=True)

print(f"\n{len(failures)} failure(s)" if failures else "\nall passed")
sys.exit(1 if failures else 0)
