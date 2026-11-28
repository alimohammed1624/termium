#!/usr/bin/env python3
"""End-to-end check of the pane scrollbar: real termium + real headless Helium.

Usage: python3 tests/scrollbar.py [outdir]
"""
import json, os, shutil, socket, subprocess, sys, tempfile, time
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
from drive import Term

OUT = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="termium-scrollbar-")
os.makedirs(OUT, exist_ok=True)
profile = tempfile.mkdtemp(prefix="termium-scrollbar-profile-")
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0)); PORT = sock.getsockname()[1]
PY = shutil.which("python3") or sys.executable
srv = subprocess.Popen([PY, "-m", "http.server", str(PORT), "--bind", "127.0.0.1",
                        "--directory", os.path.join(ROOT, "tests", "fixtures")],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.5)
BASE = f"http://127.0.0.1:{PORT}"

failures = []
def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))
    if not cond: failures.append(name)

def page_value(expr):
    r = subprocess.run(["bun", os.path.join(ROOT, "tests/support/cdp-eval.ts"), profile, expr], capture_output=True, text=True, timeout=20)
    vals = [p["value"] for p in json.loads(r.stdout or "[]") if "tall.html" in p["url"]]
    return vals[0] if vals else None

COLS, ROWS, CW, CH = 120, 40, 10, 20
BAR_COL = COLS            # the pane's last column (1-based)
TOP, BOTTOM = 3, ROWS     # the bar's rows (single pane: no header)

def bar():
    """The bar column as (char, fg, bg) per row."""
    with t.lock:
        out = []
        for y in range(TOP - 1, BOTTOM):
            c = t.screen.buffer[y][BAR_COL - 1]
            out.append((c.data, c.fg, c.bg))
        return out

def thumb_rows():
    """Rows (1-based) whose background or block is thumb-coloured."""
    rows = [TOP + i for i, (ch, fg, bg) in enumerate(bar()) if bg == "6c7086" or bg == "a6adc8" or (ch.strip() and fg in ("6c7086", "a6adc8"))]
    return rows

def scroll_y():
    return page_value("scrollY")

t = Term(["bun", os.path.join(ROOT, "src/main.ts"), "--profile", profile, f"{BASE}/tall.html"], cols=COLS, rows=ROWS, cell_w=CW, cell_h=CH, cwd=ROOT)
try:
    check("page loads", t.wait_for(lambda: page_value("document.title") == "tall page", 30))
    t.wait_idle(1.0, 15)
    check("bar shows a thumb at the top", t.wait_for(lambda: thumb_rows()[:1] == [TOP], 10), bar())
    first = thumb_rows()
    t.shot(f"{OUT}/01-top.png")

    # wheel scrolls the page and the thumb follows
    for _ in range(3):
        t.scroll(400, 300, down=True, n=5); time.sleep(0.3)
    time.sleep(1.0)
    y = scroll_y()
    check("wheel scrolls the page", y and y > 0, y)
    check("thumb follows the wheel", t.wait_for(lambda: thumb_rows() and thumb_rows()[0] > TOP, 5), (y, bar()))
    t.shot(f"{OUT}/02-wheel.png")

    # click below the thumb: a page down
    before = scroll_y()
    t.click((BAR_COL - 1) * CW + 5, (BOTTOM - 1) * CH + 10)
    check("click below the thumb pages down", t.wait_for(lambda: (scroll_y() or 0) > before + 500, 5), (before, scroll_y()))
    # click above: a page up
    before = scroll_y()
    t.click((BAR_COL - 1) * CW + 5, (TOP - 1) * CH + 2)
    check("click above the thumb pages up", t.wait_for(lambda: (scroll_y() or 0) < before - 500, 5), (before, scroll_y()))

    # drag the thumb to the bottom and back
    t.wait_for(lambda: thumb_rows(), 3)
    rows = thumb_rows()
    grab_y = (rows[len(rows) // 2] - 1) * CH + CH // 2
    x = (BAR_COL - 1) * CW + 5
    t.mouse(x, grab_y, 0, "press")
    ys = []
    for py in range(grab_y, ROWS * CH, 15):
        t.mouse(x, py, 0, "drag"); time.sleep(0.02)
    time.sleep(0.5)
    ys.append(scroll_y())
    max_y = page_value("document.documentElement.scrollHeight - innerHeight")
    check("dragging the thumb down scrolls to the end", ys[-1] is not None and abs(ys[-1] - max_y) <= 2, (ys, max_y))
    t.shot(f"{OUT}/03-dragged-bottom.png")
    mid_y = (TOP - 1 + (BOTTOM - TOP) // 2) * CH
    t.mouse(x, mid_y, 0, "drag"); time.sleep(0.5)
    mid = scroll_y()
    check("dragging to the middle scrolls to about the middle", mid is not None and 0.3 * max_y < mid < 0.7 * max_y, (mid, max_y))
    t.mouse(x, mid_y, 0, "release"); time.sleep(0.8)
    check("after the drag the thumb stays where the page is", thumb_rows() and TOP < thumb_rows()[0] < BOTTOM - 3, bar())
    t.shot(f"{OUT}/04-dragged-middle.png")

    # the page stops scrolling (its content shrinks): the thumb goes away
    page_value("(document.body.innerHTML = '<p>short</p>', 1)")
    check("a page that doesn't scroll has no thumb", t.wait_for(lambda: thumb_rows() == [], 5), bar())
    t.shot(f"{OUT}/05-short.png")
finally:
    t.close()
    srv.terminate()
    shutil.rmtree(profile, ignore_errors=True)

print(f"\nscreenshots in {OUT}")
print("ALL PASS" if not failures else f"{len(failures)} FAILED: {failures}")
sys.exit(1 if failures else 0)
