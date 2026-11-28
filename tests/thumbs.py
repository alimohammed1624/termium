#!/usr/bin/env python3
"""Hover thumbnails, end to end: real termium + real headless Helium in the
Ghostty-like PTY of scripts/drive.py, with real SGR-pixel mouse motion.

Usage: python3 tests/thumbs.py [outdir] [direct|text|placeholders ...]

Checks the tab preview (shows after a pause, clears when the pointer
leaves, a click on it switches tab, a tab never drawn gets one), the space
contact sheet (click switches space and tab), the spaces picker (Ctrl+B w),
the text fallback (TERMIUM_THUMBNAILS=text) and unicode placeholders
(TERMIUM_GRAPHICS=placeholders, as inside tmux).
"""
import json, os, shutil, socket, subprocess, sys, tempfile, time
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
from drive import Term

OUT = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="termium-thumbs-")
os.makedirs(OUT, exist_ok=True)
MAIN = os.path.join(ROOT, "src", "main.ts")
SESSION = "pr20-thumbs"

with socket.socket() as so:
    so.bind(("127.0.0.1", 0)); PORT = so.getsockname()[1]
srv = subprocess.Popen([shutil.which("python3") or sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1",
                        "--directory", os.path.join(ROOT, "tests", "fixtures")], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.5)
BASE = f"http://127.0.0.1:{PORT}"

failures = []
def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))
    if not cond:
        failures.append(name)

CW, CH = 10, 20
def move(t, col, row):
    t.mouse((col - 1) * CW + CW // 2, (row - 1) * CH + CH // 2, action="move")

def ctl(t, *args):
    env = dict(os.environ, XDG_RUNTIME_DIR=t.runtime_dir, TERMIUM_NO_UPDATE_CHECK="1")
    return subprocess.run(["bun", MAIN, "ctl", "-s", SESSION, *args], cwd=ROOT, env=env, stdin=subprocess.DEVNULL,
                          capture_output=True, text=True, timeout=60, start_new_session=True)

def tabs(t):
    r = ctl(t, "tabs", "--json")
    try:
        v = json.loads(r.stdout)
        return v.get("tabs", v) if isinstance(v, dict) else v
    except ValueError:
        return []

def active(t):
    return next((x for x in tabs(t) if x.get("active")), None)

def placed(t, pred):
    with t.lock:
        return {i: p for i, p in t.placements.items() if pred(p)}

def preview(t):
    """The tab preview: a direct placement PREVIEW_COLS (40) wide, on row 3."""
    return placed(t, lambda p: p[0] == 3 and p[2] == 40)

LISTEN = ("window.__ev = []; if (!window.__evOn) { window.__evOn = 1; "
          "for (const k of ['mousedown','mouseup','click','auxclick','wheel']) addEventListener(k, () => __ev.push(k), true); } 0")

def events(t, page):
    """Mouse events the page saw since listen() (None if it can't be asked)."""
    r = ctl(t, "--json", "eval", "window.__ev || null", str(page))
    try:
        return json.loads(r.stdout).get("value")
    except ValueError:
        return None

def listen(t, page):
    ctl(t, "eval", LISTEN, str(page))

def tab_col(t, label):
    i = t.line(1).find(label)
    return i + 1 if i >= 0 else None

def start(env, name):
    t = Term(["bun", MAIN, "-s", SESSION, "--incognito", f"{BASE}/page.html"], cols=160, rows=45, cwd=ROOT, env=env)
    check(f"[{name}] first page loads", t.wait_text("termium test page", 40), t.line(1))
    t.wait_idle(0.8, 15)
    return t

def setup_tabs(t, name):
    # Tab 2 (shown), and tab 3 opened in the background by an agent: never drawn.
    t.key("ctrl+t"); time.sleep(0.5); t.type(f"{BASE}/reader.html"); t.key("enter")
    t.wait_idle(1.0, 15); time.sleep(1.0)
    r = ctl(t, "open", f"{BASE}/anim.html", "--background")
    check(f"[{name}] background tab opened", r.returncode == 0, r.stdout + r.stderr)
    time.sleep(1.5); t.wait_idle(0.8, 10)
    check(f"[{name}] three tabs", len(tabs(t)) == 3, tabs(t))
    for x in tabs(t):
        listen(t, x["id"])

def run_direct():
    t = start({}, "direct")
    try:
        setup_tabs(t, "direct")
        col = tab_col(t, " 1 ")
        move(t, col + 3, 1)
        time.sleep(0.2)
        check("no preview before the pause", not preview(t), preview(t))
        check("tab preview shows after a pause", t.wait_for(lambda: preview(t), 3))
        p = preview(t)
        if p:
            (pid, (row, pcol, c, r)), = p.items()
            check("preview has the page's shape", r > 5, (row, pcol, c, r))
            check("preview label names the page", "termium test page" in t.line(2), t.line(2))
            with t.lock:
                raw = bytes(t.raw)
            check("preview stacks above the pages (z=1)", f"i={pid},".encode() in raw and b",z=1," in raw)
        t.shot(f"{OUT}/direct-tab-preview.png")
        move(t, 100, 30)
        check("tab preview clears when the pointer leaves", t.wait_for(lambda: not preview(t), 3), preview(t))
        check("address bar back on row 2", "127.0.0.1" in t.line(2), t.line(2))

        # A tab never drawn (opened in the background) still gets a picture.
        col3 = tab_col(t, " 3 ")
        move(t, col3 + 3, 1)
        check("a never-drawn tab gets a thumbnail", t.wait_for(lambda: preview(t), 5))
        t.shot(f"{OUT}/direct-undrawn-preview.png")
        # Down onto the preview, then click it: that tab shows.
        move(t, col3 + 3, 2); move(t, col3 + 5, 6)
        time.sleep(0.3)
        check("moving onto the preview keeps it", preview(t))
        t.click_cell(col3 + 5, 6)
        ok = t.wait_for(lambda: (active(t) or {}).get("url", "").endswith("anim.html"), 5)
        check("clicking the preview switches to its tab", ok, active(t))
        time.sleep(0.5)
        check("preview gone after the switch", not preview(t), preview(t))
        check("the switched-to page saw nothing of that click", events(t, 3) == [], events(t, 3))

        # Two buttons pressed on a preview: neither's drag or release reaches the page it switched to.
        move(t, tab_col(t, " 1 ") + 3, 1)
        check("preview again", t.wait_for(lambda: preview(t), 3))
        p1 = preview(t)
        if p1:
            (_, (row, pcol, c, r)), = p1.items()
            x, y = (pcol + 4) * 10 - 5, (row + 2) * 20 - 10
            t.mouse(x, y - 20, action="move"); t.mouse(x, y, action="move")
            t.mouse(x, y, button=2, action="press"); time.sleep(0.1)
            t.mouse(x, y, button=0, action="press"); time.sleep(0.6)
            t.mouse(x, y, button=2, action="release"); time.sleep(0.1)
            t.mouse(x + 30, y + 40, button=0, action="drag"); time.sleep(0.1)
            t.mouse(x + 30, y + 40, button=0, action="release"); time.sleep(0.6)
            check("two-button press on the preview switches tab", (active(t) or {}).get("tab") == 1, active(t))
            check("...and the page saw none of it", events(t, 1) == [], events(t, 1))

        # A second space, with one tab.
        t.key("ctrl+b"); t.key("shift+n"); time.sleep(0.6)
        t.type(f"{BASE}/page.html?space=2"); t.key("enter")
        t.wait_idle(1.0, 15); time.sleep(1.0)
        space2 = (active(t) or {}).get("id")
        listen(t, space2)
        # Hover space 1 in the sidebar (row 3): its contact sheet.
        move(t, 5, 3)
        check("space contact sheet shows after a pause", t.wait_text("· 3 tabs", 4), t.text()[:400])
        # Wheel and a click over the sheet's backdrop never reach the page it hides.
        t.scroll(1400, 800)
        time.sleep(0.4)
        check("wheel over the sheet's backdrop stays there", "· 3 tabs" in t.text() and events(t, space2) == [], events(t, space2))
        t.click_cell(150, 40)
        check("a click on the backdrop closes the sheet", t.wait_for(lambda: "· 3 tabs" not in t.text(), 3))
        time.sleep(0.3)
        check("...and doesn't reach the page", events(t, space2) == [], events(t, space2))
        move(t, 5, 4); move(t, 5, 3)
        check("the sheet shows again", t.wait_text("· 3 tabs", 4))
        thumbs = lambda: placed(t, lambda p: p[1] >= 23 and p[2] < 40)
        check("contact sheet has a picture per tab", t.wait_for(lambda: len(thumbs()) >= 3, 6), t.placements)
        check("the page picture is gone under the sheet", not placed(t, lambda p: p[2] > 100), t.placements)
        t.shot(f"{OUT}/direct-space-sheet.png")
        # Tab 1's picture: above its title (found as text: the driver's model of
        # where pictures sit can be off when a cursor move is split across reads).
        at = next(((y + 1, ln.find("1 termium test page") + 1) for y, ln in enumerate(t.text().split("\n"))
                   if y > 2 and "1 termium test page" in ln), None)
        check("sheet titles each tab", at is not None, t.text()[:600])
        if at:
            row, col = at
            move(t, 23, 3); move(t, col + 2, row - 2)
            time.sleep(0.2)
            t.click_cell(col + 2, row - 2)
            ok = t.wait_for(lambda: (active(t) or {}).get("space") == 1 and (active(t) or {}).get("tab") == 1, 5)
            check("clicking a sheet thumbnail switches space and tab", ok, active(t))
            time.sleep(0.4)
            check("the switched-to page saw nothing of that click", events(t, 1) == [], events(t, 1))
        time.sleep(0.8)
        check("the sheet is gone after the switch", "· 3 tabs" not in t.text())
        check("the page picture is back", t.wait_for(lambda: placed(t, lambda p: p[2] > 100), 4), t.placements)

        # The spaces picker shows the same sheet, and puts the panes back on Esc.
        move(t, 100, 30)
        t.key("ctrl+b"); t.key("w")
        check("spaces picker shows the contact sheet", t.wait_text("· 3 tabs", 4))
        t.key("j")
        check("picker sheet follows the cursor", t.wait_text("· 1 tab", 4))
        t.shot(f"{OUT}/direct-picker.png")
        t.key("escape")
        check("picker sheet goes with the picker", t.wait_for(lambda: "· 1 tab" not in t.text(), 4))
        check("pane picture back after the picker", t.wait_for(lambda: placed(t, lambda p: p[2] > 100), 4), t.placements)

        # Leaving the picker by number: the sheet isn't drawn again on the way out.
        t.key("ctrl+b"); t.key("w")
        check("picker again", t.wait_text("· 3 tabs", 4))
        time.sleep(1.0)
        with t.lock:
            mark = len(t.raw)
        t.key("1"); time.sleep(1.5)
        with t.lock:
            after = bytes(t.raw[mark:])
        check("picker closes by number", "· 3 tabs" not in t.text())
        check("...without sending its thumbnails again", after.count(b",z=1,") == 0, after.count(b",z=1,"))

        # A button the preview took, released while another is held on the page: the page sees only its own click.
        listen(t, 1)
        move(t, tab_col(t, " 2 ") + 3, 1)
        check("preview for the mixed-button press", t.wait_for(lambda: preview(t), 3))
        p2 = preview(t)
        if p2:
            (_, (row, pcol, c, r)), = p2.items()
            x, y = (pcol + 4) * 10 - 5, (row + 2) * 20 - 10
            t.mouse(x, y - 20, action="move"); t.mouse(x, y, action="move")
            t.mouse(x, y, button=2, action="press"); time.sleep(0.2)
            t.mouse(1400, 700, button=0, action="press"); time.sleep(0.2)  # the page, outside the preview
            t.mouse(1400, 700, button=2, action="release"); time.sleep(0.1)
            t.mouse(1400, 700, button=0, action="release"); time.sleep(0.6)
            ev = events(t, (active(t) or {}).get("id"))
            check("...the page sees only its own click", ev == ["mousedown", "mouseup", "click"], ev)

        # A page's dialog opening under a hover sheet puts the sheet away, so the whole message shows.
        ctl(t, "eval", "setTimeout(() => alert('first line\\nsecond line'), 1500); 0", "1")
        move(t, 100, 30); move(t, 5, 3)
        check("sheet up before the dialog", t.wait_text("· 3 tabs", 4))
        check("the dialog's whole message shows", t.wait_text("second line", 5) and "· 3 tabs" not in t.text(), t.text()[:500])
        t.key("enter"); time.sleep(0.5)
        move(t, 100, 30)

        # A preview narrower than its label (a tall page in a short terminal): only the
        # label and the picture are the preview; the page beside it isn't.
        t.resize(160, 12); time.sleep(1.5)
        col2 = tab_col(t, " 2 ")
        move(t, col2 + 3, 1)
        check("preview in a short terminal", t.wait_for(lambda: placed(t, lambda p: p[0] == 3 and p[2] <= 40 and p[1] >= col2 - 5), 5), t.placements)
        pv = placed(t, lambda p: p[0] == 3 and p[2] <= 40 and p[1] >= col2 - 5)
        if pv:
            (_, (row, pcol, c, r)), = pv.items()
            check("the picture is narrower than its label", c < 40, (row, pcol, c, r))
            if c < 38:
                move(t, pcol + 1, 2); move(t, pcol + c + 1, 5)
                time.sleep(0.3)
                t.click_cell(pcol + c + 1, 5)
                time.sleep(0.8)
                check("a click beside the picture doesn't switch tab", (active(t) or {}).get("tab") == 1, active(t))
    finally:
        t.close()

def run_text():
    t = start({"TERMIUM_THUMBNAILS": "text"}, "text")
    try:
        setup_tabs(t, "text")
        col = tab_col(t, " 1 ")
        move(t, col + 3, 1)
        ok = t.wait_for(lambda: "termium test page —" in t.line(2), 3)
        check("text fallback: title and address under the tab", ok, t.line(2))
        check("text fallback: no picture", not preview(t))
        t.shot(f"{OUT}/text-preview.png")
        move(t, 100, 30)
        check("text fallback clears", t.wait_for(lambda: "termium test page —" not in t.line(2), 3), t.line(2))
        move(t, 5, 3)
        ok = t.wait_text("· 3 tabs", 4)
        check("text fallback: space sheet lists the tabs", ok and "1 termium test page" in t.text(), t.text()[:300])
        t.shot(f"{OUT}/text-sheet.png")
        move(t, 100, 40)
        check("text sheet clears", t.wait_for(lambda: "· 3 tabs" not in t.text(), 3))
        # Too short for every tab: the rest are counted.
        t.resize(160, 6); time.sleep(1.0)
        move(t, 5, 4); move(t, 5, 3)
        check("text sheet counts the tabs that don't fit", t.wait_text("+2 more", 4), t.text())
        # No row to spare: a tab, never the count, takes the last one.
        move(t, 100, 5)
        t.resize(160, 5); time.sleep(1.0)
        move(t, 5, 4); move(t, 5, 3)
        ok = t.wait_text("· 3 tabs", 4)
        check("text sheet in 5 rows shows a tab, not the count", ok and "1 termium test page" in t.text() and "more" not in t.text(), t.text())
    finally:
        t.close()

def run_placeholders():
    t = start({"TERMIUM_GRAPHICS": "placeholders"}, "placeholders")
    try:
        setup_tabs(t, "placeholders")
        time.sleep(1.0)
        col = tab_col(t, " 1 ")
        move(t, col + 3, 1)
        pv = lambda: {i: b for i, b in t.placeholder_images().items() if b[0] == 3 and b[2] == 40}
        check("placeholders: preview shows as placeholder cells", t.wait_for(pv, 4), t.placeholder_images())
        t.shot(f"{OUT}/placeholder-preview.png")
        b = next(iter(pv().values()), None)
        if b:
            # The page's cell just right of the preview still knows its place in the page's picture.
            y, x = 5, b[1] + b[2]  # 1-based row, column
            with t.lock:
                cell = next((c for c in t._placeholder_cells() if c[0] == y - 1 and c[1] == x - 1), None)
            check("placeholders: page cells right of the preview keep their place",
                  cell is not None and cell[3] == y - 3 and cell[4] == x - 23, cell)
        move(t, 100, 30)
        check("placeholders: preview clears", t.wait_for(lambda: not pv(), 4), t.placeholder_images())
        check("placeholders: pane cells written again",
              t.wait_for(lambda: any(b[2] > 100 for b in t.placeholder_images().values()), 3), t.placeholder_images())
        move(t, 5, 3)
        ok = t.wait_for(lambda: len([b for b in t.placeholder_images().values() if b[2] < 40]) >= 3, 6)
        check("placeholders: sheet pictures", ok, t.placeholder_images())
        t.shot(f"{OUT}/placeholder-sheet.png")
        move(t, 100, 40)
        ok = t.wait_for(lambda: "· 3 tabs" not in t.text(), 4)
        ok = ok and t.wait_for(lambda: any(b[2] > 100 for b in t.placeholder_images().values()), 4)
        check("placeholders: sheet clears and the page comes back", ok, t.placeholder_images())
    finally:
        t.close()

try:
    which = sys.argv[2:] or ["direct", "text", "placeholders"]
    if "direct" in which: run_direct()
    if "text" in which: run_text()
    if "placeholders" in which: run_placeholders()
finally:
    srv.terminate()
print(f"\n{len(failures)} failed" if failures else "\nall passed", f"(shots in {OUT})")
sys.exit(1 if failures else 0)
