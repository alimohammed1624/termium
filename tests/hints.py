#!/usr/bin/env python3
"""Link hints against the real stack (termium + Helium).

A terminal (a PTY that answers like Ghostty) shows tests/fixtures/hints.html;
Ctrl+B o labels its links and buttons. Checks, at 100% zoom, at another
zoom and on a HiDPI terminal (2x cells), that every label is drawn where
its element is (the label's top-left pixel, and its cell, against the
element's box mapped to the pane), that typing a label clicks that element
(a capital: a link opens in a background tab), that Esc and a click put
the labels away, and that `termium ctl hints` gives the same labels and
`ctl click LABEL` clicks by them.

Usage: python3 tests/hints.py [--shots DIR]
"""
import json, os, shutil, socket, subprocess, sys, tempfile, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
from drive import Term

SHOTS = sys.argv[sys.argv.index("--shots") + 1] if "--shots" in sys.argv else None
failures = []
def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))
    if not cond:
        failures.append(name)

main = os.path.join(ROOT, "src", "main.ts")
tmp = tempfile.mkdtemp(prefix="pr18-hints-")
rt = os.path.join(tmp, "run"); os.makedirs(rt)
ENV = {"XDG_RUNTIME_DIR": rt, "TMPDIR": tmp, "TERMIUM_NO_UPDATE_CHECK": "1",
       "XDG_DATA_HOME": os.path.join(tmp, "data"), "XDG_STATE_HOME": os.path.join(tmp, "state")}
with socket.socket() as so:
    so.bind(("127.0.0.1", 0)); PORT = so.getsockname()[1]
srv = subprocess.Popen([shutil.which("python3") or sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1",
                        "--directory", os.path.join(ROOT, "tests", "fixtures")], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.5)
URL = f"http://127.0.0.1:{PORT}/hints.html"
YELLOW = (0xf9, 0xe2, 0xaf)
SIDEBAR_W, TOP_ROWS = 22, 2

def ctl(session, *args):
    return subprocess.run(["bun", main, "ctl", "-s", session, *args], cwd=ROOT, env=dict(os.environ, **ENV),
                          stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=60)

def ctl_json(session, *args):
    r = ctl(session, *args, "--json")
    try:
        return json.loads(r.stdout)
    except ValueError:
        return {"_error": (r.returncode, r.stdout, r.stderr)}

def page(session, expr):
    return ctl_json(session, "eval", expr).get("value")

def near(c, want, tol=24):
    return all(abs(a - b) <= tol for a, b in zip(c, want))

def overlay_count(session):
    # The labels' host element (its shadow root is closed: only the host shows).
    return page(session, "document.querySelectorAll('termium-hints').length")

def labels_line_up(t, session, what):
    """Hints up: each label's top-left is on its element's top-left, in pixels and cells."""
    hints = ctl_json(session, "hints").get("hints") or []
    css = page(session, "[innerWidth, innerHeight]") or [1, 1]
    t.key("ctrl+b"); t.key("o")
    ok = t.wait_for(lambda: overlay_count(session) == 1, 10)
    t.wait_frames(2, 10); t.wait_idle(0.8, 10)
    path = os.path.join(tmp, f"{session}-{what}.png")
    t.shot(path)
    if SHOTS:
        shutil.copy(path, os.path.join(SHOTS, f"{session}-{what}.png"))
    from PIL import Image
    img = Image.open(path).convert("RGB")
    col0, row0 = SIDEBAR_W + 1, TOP_ROWS + 1
    pane_cols, pane_rows = t.cols - col0 + 1, t.rows - row0 + 1
    sx = pane_cols * t.cell_w / css[0]
    sy = pane_rows * t.cell_h / css[1]
    ox, oy = (col0 - 1) * t.cell_w, (row0 - 1) * t.cell_h
    # Labels whose element starts inside another labelled element may be covered by that one's label: skipped.
    def covered(h):
        return any(o is not h and o["rect"]["x"] <= h["rect"]["x"] < o["rect"]["x"] + 40 and o["rect"]["y"] <= h["rect"]["y"] < o["rect"]["y"] + 20
                   for o in hints if hints.index(o) > hints.index(h))
    bad, checked = [], 0
    for h in hints:
        if covered(h):
            continue
        r = h["rect"]
        # Where the element's top-left is on the terminal, in pixels.
        ex, ey = ox + r["x"] * sx, oy + r["y"] * sy
        # The label's top-left: its first yellow pixel going in diagonally from
        # 3 CSS px up-left of the element's corner (inside its 1px dark border).
        found = None
        for k in range(0, int(9 * max(sx, sy)) + 1):
            x, y = int(ex - 3 * sx + k * sx / max(sx, sy)), int(ey - 3 * sy + k * sy / max(sx, sy))
            if near(img.getpixel((max(0, x), max(0, y))), YELLOW):
                found = (x - sx, y - sy)  # back over the border
                break
        checked += 1
        if not found:
            bad.append((h["label"], h["text"], "no label"))
            continue
        # Within a CSS pixel (and so in the same cell) of the element's corner.
        lab_cell = (int(found[0] // t.cell_w) + 1, int(found[1] // t.cell_h) + 1)
        el_cell = (int(ex // t.cell_w) + 1, int(ey // t.cell_h) + 1)
        if abs(found[0] - ex) > 2.2 * sx or abs(found[1] - ey) > 2.2 * sy or (lab_cell != el_cell and
                (int((ex + sx) // t.cell_w) + 1, int((ey + sy) // t.cell_h) + 1) != lab_cell and
                (int((ex - sx) // t.cell_w) + 1, int((ey - sy) // t.cell_h) + 1) != lab_cell):
            bad.append((h["label"], h["text"], found, (ex, ey), lab_cell, el_cell))
    check(f"{what}: labels drawn ({len(hints)} hints)", ok and len(hints) > 60, (ok, len(hints)))
    check(f"{what}: every label sits on its element (pixel and cell; {checked} checked)", checked > 50 and not bad, bad[:5])
    return hints

def by_id(hints, text):
    return next((h for h in hints if h["text"] == text), None)

sessions = []
try:
    # --- 100%, then zoomed
    s = "pr18-hints"; sessions.append(s)
    t = Term(["bun", main, "-s", s, "--profile", os.path.join(tmp, "p1"), URL], cols=160, rows=45, cwd=ROOT, env=ENV)
    check("the page shows", t.wait_frames(1, 40) and t.wait_text("Hints fixture", 30))
    t.wait_idle(1, 10)
    hints = labels_line_up(t, s, "zoom100")
    texts = [h["text"] for h in hints]
    check("covered, disabled and off-screen elements get no label",
          not any(x in texts for x in ("covered", "disabled", "below the fold")), texts)
    check("a button in an open shadow root, a role=button, fields and a select get labels",
          all(x in texts for x in ("shadow button", "role button", "A field")) and any(h["tag"] == "select" for h in hints), texts)
    check("a focusable span inside a link doesn't get a second label",
          sum(1 for h in hints if "nested span" in h["text"]) == 1, [h for h in hints if "nested" in h["text"]])
    check("a button in a same-origin frame gets a label", "frame button" in texts, texts)
    check("a button covered at its centre but not at its edge gets a label", "half covered" in texts, texts)
    check("the mode shows in the address line", "HINTS" in t.line(2), t.line(2))

    # Typing a label clicks its element (the label from ctl hints: the person's and the agent's agree).
    b7 = by_id(hints, "button 7")
    page(s, "window.clicks = []")
    for ch in b7["label"]:
        t.key(ch)
    clicked = t.wait_for(lambda: (page(s, "window.clicks") or [{}])[-1:] == [{"id": "b7", "ctrl": False, "meta": False, "trusted": True}], 10)
    check(f"typing {b7['label'].upper()} clicks button 7 (a trusted click)", clicked, page(s, "window.clicks"))
    check("...and the labels are gone", t.wait_for(lambda: overlay_count(s) == 0, 5) and "HINTS" not in t.line(2), t.line(2))

    # Typing the label of a button in a frame (one scaled by a transform too) clicks it (their labels line up: checked above).
    for name, fid in (("frame button", "fb"), ("scaled frame button", "fb2")):
        fb = by_id(hints, name)
        t.key("ctrl+b"); t.key("o"); t.wait_for(lambda: overlay_count(s) == 1, 10)
        page(s, "window.clicks = []")
        for ch in fb["label"]:
            t.key(ch)
        check(f"typing {fb['label'].upper()} clicks the {name}",
              t.wait_for(lambda: [c.get("id") for c in page(s, "window.clicks") or []] == [fid], 10), page(s, "window.clicks"))

    # A dialog coming up while the labels are up takes the keys (they don't go to the labels).
    t.key("ctrl+b"); t.key("o"); t.wait_for(lambda: overlay_count(s) == 1, 10)
    page(s, "setTimeout(() => { window.answer = prompt('pr18 question', 'base'); }, 300)")
    shown = t.wait_for(lambda: "pr18 question" in t.line(2), 10)
    check("a prompt() opening puts the labels away", shown and "HINTS" not in t.line(2), t.line(2))
    t.type("xy"); t.key("enter")
    check("...and what's typed then answers it", t.wait_for(lambda: page(s, "window.answer") == "xy", 10), page(s, "window.answer"))
    check("...with the labels gone from the page", overlay_count(s) == 0)

    # Narrowing: the first letter of a two-letter label leaves the labels open, Backspace takes it back, Esc ends.
    two = next(h for h in hints if len(h["label"]) == 2)
    t.key("ctrl+b"); t.key("o"); t.wait_for(lambda: overlay_count(s) == 1, 10)
    time.sleep(0.5)
    t.key(two["label"][0])
    check("one letter of a two-letter label narrows (still in hint mode, typed letter shown)",
          t.wait_for(lambda: f"HINTS {two['label'][0].upper()}" in t.line(2), 5), t.line(2))
    t.key("backspace")
    check("Backspace takes it back", t.wait_for(lambda: "HINTS " in t.line(2) and f"HINTS {two['label'][0].upper()}" not in t.line(2), 5), t.line(2))
    page(s, "window.clicks = []")
    t.key("escape")
    check("Esc puts the labels away, clicking nothing",
          t.wait_for(lambda: overlay_count(s) == 0, 5) and "HINTS" not in t.line(2) and page(s, "window.clicks.length") == 0)

    # A click on the page puts them away too (and goes through).
    t.key("ctrl+b"); t.key("o"); t.wait_for(lambda: overlay_count(s) == 1, 10)
    t.scroll(600, 600)
    check("scrolling puts the labels away", t.wait_for(lambda: overlay_count(s) == 0, 5) and "HINTS" not in t.line(2))
    page(s, "scrollTo(0, 0)")

    # A capital: the link opens in a background tab; this tab stays in front.
    real = by_id(hints, "a real link")
    t.key("ctrl+b"); t.key("o"); t.wait_for(lambda: overlay_count(s) == 1, 10)
    time.sleep(0.4)
    for i, ch in enumerate(real["label"]):
        t.key(f"shift+{ch}" if i == len(real["label"]) - 1 else ch)
    tabs = []
    check("a capital opens the link in a new tab", t.wait_for(lambda: len(tabs := ctl_json(s, "tabs")) == 2 and tabs, 10), ctl_json(s, "tabs"))
    tabs = ctl_json(s, "tabs")
    newt = [x for x in tabs if "page.html?from=hints" in x.get("url", "")]
    front = [x for x in tabs if x.get("active")]
    check("...in the background (the hinted page keeps the focus)", newt and front and "hints.html" in front[0]["url"], tabs)
    check("...and the hinted page itself didn't navigate", page(s, "location.pathname") == "/hints.html")
    if newt:
        ctl(s, "close", str(newt[0]["id"]))

    # ctl click by label.
    page(s, "window.clicks = []")
    hints = ctl_json(s, "hints").get("hints") or []
    l3 = by_id(hints, "link 3")
    r = ctl(s, "click", l3["label"].upper())
    check(f"ctl click {l3['label'].upper()} clicks link 3", r.returncode == 0 and (page(s, "window.clicks") or [{}])[-1].get("id") == "l3",
          (r.returncode, r.stdout, r.stderr, page(s, "window.clicks")))
    check("ctl hints gives ids that click works with",
          ctl(s, "click", by_id(hints, "button 2")["id"]).returncode == 0 and (page(s, "window.clicks") or [{}])[-1].get("id") == "b2")
    page(s, "window.clicks = []")
    half = by_id(hints, "half covered")
    r = ctl(s, "click", half["label"])
    check("ctl click LABEL clicks where the hint was found (an element covered at its centre)",
          r.returncode == 0 and [c.get("id") for c in page(s, "window.clicks") or []] == ["half"], (r.returncode, r.stderr, page(s, "window.clicks")))
    # Several agents listing at once: each gets the whole, consistent list.
    procs = [subprocess.Popen(["bun", main, "ctl", "-s", s, "hints", "--json"], cwd=ROOT, env=dict(os.environ, **ENV), stdin=subprocess.DEVNULL,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in range(4)]
    outs = [json.loads(p.communicate(timeout=60)[0] or "{}").get("hints") for p in procs]
    check("ctl hints run at once give the same list", all(o == outs[0] for o in outs) and len(outs[0] or []) > 60
          and all(h.get("id") for h in outs[0]), [len(o or []) for o in outs])
    r = ctl(s, "click", "zzz")
    check("an unknown label is exit 1, saying where labels come from", r.returncode == 1 and "ctl hints" in r.stderr, (r.returncode, r.stderr))
    human = ctl(s, "hints").stdout
    check("ctl hints prints one line per label", f'{l3["label"].upper()}' in human and '"link 3"' in human and "[" in human, human[:300])

    # Zoomed in: other CSS sizes, the same lining up.
    t.key("alt+equal"); t.key("alt+equal")
    t.wait_for(lambda: "121%" in t.line(2), 10)
    t.wait_frames(2, 10); t.wait_idle(1, 10)
    labels_line_up(t, s, "zoom121")
    t.key("escape")
    t.close()

    # --- HiDPI: 2x cells (devicePixelRatio 2).
    s2 = "pr18-hints-hidpi"; sessions.append(s2)
    t = Term(["bun", main, "-s", s2, "--profile", os.path.join(tmp, "p2"), URL], cols=120, rows=36, cell_w=20, cell_h=40, cwd=ROOT, env=ENV)
    check("HiDPI: the page shows", t.wait_frames(1, 40) and t.wait_text("Hints fixture", 30))
    t.wait_idle(1, 10)
    check("HiDPI: devicePixelRatio is 2", page(s2, "devicePixelRatio") == 2, page(s2, "devicePixelRatio"))
    hints = labels_line_up(t, s2, "hidpi")
    t.key("escape")
    # Something always moving: termium keeps taking screenshots of the page (as at HiDPI it does on every change).
    page(s2, "(() => { const d = document.createElement('div'); d.id = 'spinner'; d.style.cssText = 'position:fixed;right:4px;bottom:4px;width:30px;height:30px;background:red';"
             " d.animate([{ transform: 'rotate(0)' }, { transform: 'rotate(360deg)' }], { duration: 400, iterations: Infinity }); document.body.appendChild(d); })()")
    time.sleep(0.5)
    hints = ctl_json(s2, "hints").get("hints") or []
    bad = []
    for want in ("button 1", "button 5", "link 12", "button 24", "frame button", "scaled frame button"):
        h = by_id(hints, want)
        page(s2, "window.clicks = []")
        r = ctl(s2, "click", h["label"])
        got = [c.get("id") for c in page(s2, "window.clicks") or []]
        if r.returncode != 0 or got != [{"frame button": "fb", "scaled frame button": "fb2"}.get(want, want.replace("button ", "b").replace("link ", "l"))]:
            bad.append((want, r.returncode, r.stderr.strip(), got))
    check("HiDPI, while the page keeps changing: ctl click LABEL clicks the right element every time", not bad, bad)
    hints = ctl_json(s2, "hints").get("hints") or []
    # Typed labels too, each click right after its labels go (a new frame, and a screenshot of it, under way).
    for want in ("button 3", "link 21", "button 20"):
        h = by_id(hints, want)
        t.key("ctrl+b"); t.key("o"); t.wait_for(lambda: overlay_count(s2) == 1, 10)
        page(s2, "window.clicks = []")
        for ch in h["label"]:
            t.key(ch)
        check(f"HiDPI: typing {h['label'].upper()} clicks {want}",
              t.wait_for(lambda: [c.get("id") for c in page(s2, "window.clicks") or []] == [want.replace("button ", "b").replace("link ", "l")], 10),
              page(s2, "window.clicks"))
    t.close()
finally:
    for s in sessions:
        subprocess.run(["bun", main, "kill", s], cwd=ROOT, env=dict(os.environ, **ENV), capture_output=True, timeout=30)
    srv.terminate()
    shutil.rmtree(tmp, ignore_errors=True)

print(f"\n{len(failures)} failed" if failures else "\nall passed")
sys.exit(1 if failures else 0)
