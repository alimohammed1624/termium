#!/usr/bin/env python3
"""Toasts: stacked in the pages' bottom-right corner, with a shrinking timer
line; hovering pauses one, a click dismisses it. Real termium + real
headless Helium in a Ghostty-like PTY.

Usage: python3 tests/toast.py
"""
import json, os, shutil, socket, subprocess, sys, tempfile, time
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

def page_eval(expr):
    r = subprocess.run(["bun", os.path.join(ROOT, "tests/support/cdp-eval.ts"), profile, expr], capture_output=True, text=True, timeout=20)
    vals = [p["value"] for p in json.loads(r.stdout or "[]") if "page.html" in p["url"]]
    return vals[0] if vals else None

def hover(col, row):
    t.mouse((col - 1) * t.cell_w + 3, (row - 1) * t.cell_h + 3, action="move")

t2 = None
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

    # A click dismisses, and none of that click reaches the page under it.
    page_eval("window.__ev = []; for (const k of ['mousedown', 'mouseup', 'click']) addEventListener(k, () => __ev.push(k), true); 1")
    col, row = toast_cell("Update news")
    x, y = (col + 1) * t.cell_w + 5, (row - 1) * t.cell_h + 8
    t.mouse(x, y, action="press"); time.sleep(0.3)
    t.mouse(x + 30, y, button=0, action="drag"); time.sleep(0.1)
    t.mouse(x + 30, y, action="release")
    check("a click dismisses it", t.wait_for(lambda: OFF not in t.text(), 2), t.text()[-400:])
    time.sleep(0.3)
    check("...and the page under it gets none of that click", page_eval("__ev") == [], page_eval("__ev"))
    c = page_eval("(() => { const r = document.getElementById('log').getBoundingClientRect(); return [r.x + 20, r.y + r.height / 2]; })()")
    t.click(220 + int(c[0]), 40 + int(c[1])); time.sleep(0.3)
    ev = page_eval("__ev")
    check("...while the next click on the page reaches it", ev == ["mousedown", "mouseup", "click"], repr(ev))
    time.sleep(0.5)
    check("the corner is clear again", not any("▂" in l for l in t.screen.display[ROWS - 6:]), t.screen.display[ROWS - 6:])

    # Expiry: one left alone goes by itself (the pointer off it: a toast
    # that comes up under the pointer waits too).
    hover(10, 10)
    t.key("ctrl+b"); t.key("shift+u")
    t.wait_text(OFF, 5)
    check("an untouched toast expires", t.wait_for(lambda: OFF not in t.text(), 8))

    # While a long dialog message covers the page, toasts aren't drawn over it, and wait.
    t.key("ctrl+b"); t.key("shift+u"); t.wait_text(OFF, 5)
    c = page_eval("(() => { const r = document.getElementById('longmsg').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()")
    t.click(220 + int(c[0]), 40 + int(c[1]))
    check("a long dialog message shows over the page", t.wait_text("END-OF-MESSAGE", 5), t.text()[-600:])
    check("...with no toast over it", t.wait_for(lambda: OFF not in t.text(), 2), t.text()[-600:])
    time.sleep(6)  # longer than the toast's 5 s
    t.key("enter")
    check("once it's answered, the toast is back (it waited)", t.wait_text(OFF, 4), t.text()[-600:])

    # Detached while hovering a toast: in the next terminal nothing is under
    # a pointer yet, so the toast's timer runs again.
    t.key("ctrl+b"); t.key("shift+u"); t.wait_text(OFF, 5)
    col, row = toast_cell("Update news"); hover(col + 2, row); time.sleep(0.3)
    t.key("ctrl+b"); t.key("d")
    t.wait_for(lambda: os.waitpid(t.pid, os.WNOHANG)[0] != 0, 10)
    t2 = Term(["bun", os.path.join(ROOT, "src/main.ts"), "attach"], cols=COLS, rows=ROWS, cwd=ROOT,
              env={"XDG_RUNTIME_DIR": t.runtime_dir, "XDG_DATA_HOME": os.path.join(t.own_root, "data"),
                   "XDG_STATE_HOME": os.path.join(t.own_root, "state")})
    check("re-attached: the toast is still there", t2.wait_text(OFF, 10), t2.text()[-400:])
    check("...and expires with no pointer over it", t2.wait_for(lambda: OFF not in t2.text(), 8), t2.text()[-400:])
finally:
    if t2: t2.close()
    t.close()
    srv.terminate()
    shutil.rmtree(profile, ignore_errors=True)

print(f"\n{len(failures)} failure(s)" if failures else "\nall passed")
sys.exit(1 if failures else 0)
