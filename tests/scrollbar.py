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

def page_value(expr, page="tall.html"):
    r = subprocess.run(["bun", os.path.join(ROOT, "tests/support/cdp-eval.ts"), profile, expr], capture_output=True, text=True, timeout=20)
    vals = [p["value"] for p in json.loads(r.stdout or "[]") if page in p["url"]]
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
    # the browser's own scrollbar of the page is hidden; a scroll box inside keeps its own
    check("the page's own scrollbar is hidden", page_value("innerWidth - document.documentElement.clientWidth") == 0)
    check("a scroll box inside the page keeps its scrollbar",
          (page_value("(e => e.offsetWidth - e.clientWidth)(document.getElementById('inner'))") or 0) > 0)
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

    def thumb_y():
        rows = thumb_rows()
        return (rows[len(rows) // 2] - 1) * CH + CH // 2

    # a drag ends when the button is let go elsewhere: over the help overlay...
    y0 = scroll_y()
    t.mouse(x, thumb_y(), 0, "press")
    t.key("ctrl+b"); t.key("question"); time.sleep(0.4)
    t.mouse(x, 300, 0, "release"); time.sleep(0.2)
    t.key("escape"); time.sleep(0.4)
    t.mouse(x, ROWS * CH - 5, 0, "move"); time.sleep(0.6)
    check("a drag released over the help overlay is over", abs((scroll_y() or 0) - y0) <= 2, (y0, scroll_y()))
    # ...or never reported (a move without the button held ends it)
    t.mouse(x, thumb_y(), 0, "press")
    t.mouse(x, ROWS * CH - 5, 0, "move"); time.sleep(0.6)
    check("a buttonless move ends a drag", abs((scroll_y() or 0) - y0) <= 2, (y0, scroll_y()))

    # the wheel over the bar scrolls the document, not a fixed box at the page's right edge
    page_value("(document.getElementById('fixed').scrollTop = 0, 1)")
    y0 = scroll_y()
    t.scroll(x, 300, down=True, n=5); time.sleep(0.8)
    fixed_top = page_value("document.getElementById('fixed').scrollTop")
    check("the wheel over the bar scrolls the document", (scroll_y() or 0) >= y0 + 250 and fixed_top == 0, (y0, scroll_y(), fixed_top))

    # while a dialog is up the bar does nothing (no scroll waiting for it)
    y0 = scroll_y()
    page_value("(setTimeout(() => alert('line one\\n'.repeat(4) + 'END-OF-ALERT'), 0), 1)")
    check("alert shown", t.wait_text("END-OF-ALERT", 5))
    t.click(x, (BOTTOM - 1) * CH + 10); time.sleep(0.3)
    t.key("enter"); time.sleep(0.8)
    check("a click on the bar under a dialog doesn't scroll", abs((scroll_y() or 0) - y0) <= 2, (y0, scroll_y()))

    # a dialog that comes up during a drag ends it: no jump once it's answered
    page_value("(scrollTo(0, 1500), 1)"); time.sleep(0.8)
    t.wait_for(lambda: thumb_rows(), 3)
    y0 = scroll_y()
    t.mouse(x, thumb_y(), 0, "press")
    page_value("(setTimeout(() => alert('DRAG-ALERT'), 0), 1)")
    check("alert during a drag shown", t.wait_text("DRAG-ALERT", 5))
    for py in range(thumb_y(), ROWS * CH, 20):
        t.mouse(x, py, 0, "drag"); time.sleep(0.01)
    t.mouse(x, ROWS * CH - 5, 0, "release"); time.sleep(0.2)
    t.key("enter"); time.sleep(1.0)
    check("a dialog during a drag stops it", abs((scroll_y() or 0) - y0) <= 2, (y0, scroll_y()))

    # track clicks each count, even when the page is slow to scroll
    page_value("(scrollTo(0, 0), window.addEventListener('scroll', () => { const t = Date.now(); while (Date.now() - t < 400); }), 1)")
    time.sleep(0.8)
    step = page_value("innerHeight * 0.875")
    for _ in range(3):
        t.click(x, (BOTTOM - 1) * CH + 10); time.sleep(0.1)
    check("three quick track clicks scroll three pages", t.wait_for(lambda: abs((scroll_y() or 0) - 3 * step) <= 3, 8), (scroll_y(), 3 * step))
    page_value("(location.reload(), 1)")
    t.wait_for(lambda: page_value("document.title") == "tall page", 15); t.wait_idle(1.0, 10)

    # a page that locked scrolling (overflow hidden on the root) isn't scrolled by the bar either
    page_value("(document.documentElement.style.overflow = 'hidden', scrollTo(0, 0), 1)"); time.sleep(0.5)
    t.scroll(x, 300, down=True, n=5); time.sleep(0.3)
    t.click(x, (BOTTOM - 1) * CH + 10); time.sleep(0.8)
    check("the bar doesn't scroll a locked page", scroll_y() == 0, scroll_y())
    page_value("(document.documentElement.style.overflow = '', 1)")

    # the page stops scrolling (its content shrinks): the thumb goes away
    page_value("(document.body.innerHTML = '<p>short</p>', 1)")
    check("a page that doesn't scroll has no thumb", t.wait_for(lambda: thumb_rows() == [], 5), bar())
    t.shot(f"{OUT}/05-short.png")

    # after a navigation, on a page whose CSP forbids style elements, the page's own bar stays hidden
    t.key("ctrl+l"); t.key("ctrl+a"); t.key("ctrl+k"); t.type(f"{BASE}/csp.html"); t.key("enter")
    check("CSP page loads", t.wait_for(lambda: page_value("document.title", "csp.html") == "csp page", 15))
    page_value("(document.body.style.height = '5000px', 1)", "csp.html")
    check("a CSP page's own scrollbar is hidden too", t.wait_for(lambda: page_value("innerWidth - document.documentElement.clientWidth", "csp.html") == 0, 5),
          page_value("innerWidth - document.documentElement.clientWidth", "csp.html"))
    check("...and termium's bar shows", t.wait_for(lambda: thumb_rows()[:1] == [TOP], 5), bar())
finally:
    t.close()

# HiDPI (2 device px per CSS px): frames only signal changes, and a page that
# looks the same scrolled (one colour) must still move the thumb
t = Term(["bun", os.path.join(ROOT, "src/main.ts"), "--profile", profile, f"{BASE}/tall.html"], cols=COLS // 2, rows=ROWS // 2, cell_w=CW * 2, cell_h=CH * 2, cwd=ROOT)
try:
    check("HiDPI page loads", t.wait_for(lambda: page_value("devicePixelRatio") == 2, 30), page_value("devicePixelRatio"))
    page_value("(document.body.innerHTML = '<section style=\"height: 7200px; background: #88c\"></section>', 1)")
    t.wait_idle(1.0, 10)
    top_rows = lambda: [i for i in range(2, ROWS // 2) if t.screen.buffer[i][COLS // 2 - 1].bg in ("6c7086", "a6adc8")]
    check("HiDPI: thumb at the top", t.wait_for(lambda: top_rows()[:1] == [2], 10), top_rows())
    t.scroll(700, 300, down=True, n=15); time.sleep(1.0)  # over the page (the sidebar is 22 cells)
    check("HiDPI: one-colour page scrolled, thumb follows", (scroll_y() or 0) > 0 and t.wait_for(lambda: top_rows() and top_rows()[0] > 2, 5), (scroll_y(), top_rows()))
finally:
    t.close()

# TERMIUM_NATIVE_SCROLLBAR=1 keeps the browser's own scrollbar
t = Term(["bun", os.path.join(ROOT, "src/main.ts"), "--profile", profile, f"{BASE}/tall.html"], cols=COLS, rows=ROWS, cell_w=CW, cell_h=CH, cwd=ROOT,
         env={"TERMIUM_NATIVE_SCROLLBAR": "1"})
try:
    check("page loads (native scrollbar kept)", t.wait_for(lambda: page_value("document.title") == "tall page", 30))
    w = page_value("innerWidth - document.documentElement.clientWidth")
    check("TERMIUM_NATIVE_SCROLLBAR=1 keeps the page's own scrollbar", (w or 0) > 0, w)
    check("...and termium's bar", t.wait_for(lambda: thumb_rows()[:1] == [TOP], 10), bar())
finally:
    t.close()
    srv.terminate()
    shutil.rmtree(profile, ignore_errors=True)

print(f"\nscreenshots in {OUT}")
print("ALL PASS" if not failures else f"{len(failures)} FAILED: {failures}")
sys.exit(1 if failures else 0)
