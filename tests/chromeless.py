#!/usr/bin/env python3
"""Chromeless mode (no tab bar, address bar or sidebar), against the real
termium and headless browser: Ctrl+B F, the palette, `ctl chromeless`,
--chromeless, the page filling the terminal (pictures and mouse), Ctrl+L,
tab switches, and the setting surviving a restart into a newer termium.

    python3 tests/chromeless.py [OUT_DIR]
"""
import json, os, re, shutil, socket, subprocess, sys, tempfile, time
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
from drive import Term

OUT = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="termium-chromeless-")
os.makedirs(OUT, exist_ok=True)
tmp = tempfile.mkdtemp(prefix="termium-chromeless-tmp-")
profile = os.path.join(tmp, "profile")
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0)); PORT = sock.getsockname()[1]
PY = shutil.which("python3") or sys.executable
srv = subprocess.Popen([PY, "-m", "http.server", str(PORT), "--bind", "127.0.0.1",
                        "--directory", os.path.join(ROOT, "tests", "fixtures")],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.5)
BASE = f"http://127.0.0.1:{PORT}"
SESSION = "pr7-chromeless"
COLS, ROWS = 160, 45
FULL = [(1, 1, COLS, ROWS)]
# With the bars: below the tab and address bars, right of the sidebar.
BARS = [(3, 23, COLS - 22, ROWS - 2)]

# A newer termium (this checkout claiming the next version) to restart into.
newer = os.path.join(tmp, "newer")
shutil.copytree(os.path.join(ROOT, "src"), os.path.join(newer, "src"))
with open(os.path.join(ROOT, "package.json")) as f:
    pkg = json.load(f)
major, minor, patch = pkg["version"].split(".")
NEXT = f"{major}.{minor}.{int(patch) + 1}"
pkg["version"] = NEXT
with open(os.path.join(newer, "package.json"), "w") as f:
    json.dump(pkg, f)

failures = []
def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else f"  -- {detail!r}"), flush=True)
    if not cond:
        failures.append(name)

t = Term(["bun", os.path.join(ROOT, "src/main.ts"), "-s", SESSION, "--profile", profile, f"{BASE}/page.html"],
         cols=COLS, rows=ROWS, cwd=ROOT)
ENV = dict(os.environ, XDG_RUNTIME_DIR=t.runtime_dir, XDG_DATA_HOME=os.path.join(t.own_root, "data"),
           XDG_STATE_HOME=os.path.join(t.own_root, "state"), TERMIUM_NO_UPDATE_CHECK="1")
ENV.pop("TERM", None)  # (drive.Term sets its own)
clients = [t]

def ctl(*args, main=os.path.join(ROOT, "src/main.ts")):
    r = subprocess.run(["bun", main, "ctl", "-s", SESSION, *args, "--json"],
                       cwd=ROOT, env=ENV, capture_output=True, text=True, timeout=60)
    return json.loads(r.stdout) if r.stdout.strip() else {"stderr": r.stderr}

def ev(js):
    r = ctl("eval", js)
    return r.get("value") if isinstance(r, dict) else r

def placed(term):
    with term.lock:
        return sorted(term.placements.values())

def bars_shown(term):
    return "←" in term.line(2) and "→" in term.line(2)

def wait_placed(term, want, timeout=10):
    return term.wait_for(lambda: placed(term) == want, timeout)

def active_tab():
    return next((x["id"] for x in ctl("tabs") if x.get("active")), None)

def mouse_lines_up(term, label):
    """Clicks in the four corners land on the page where they were made (CSS pixels)."""
    ev("window.__md = []; addEventListener('mousedown', e => __md.push([e.clientX, e.clientY]), true); 0")
    w, h = ev("[innerWidth, innerHeight]")
    cells = [(1, 1), (COLS, 1), (1, ROWS), (COLS, ROWS), (COLS // 2, ROWS // 2)]
    for col, row in cells:
        term.click_cell(col, row); time.sleep(0.15)
    time.sleep(0.6)
    got = ev("__md")
    want = [(((c - 1) * term.cell_w + term.cell_w // 2) * w / (COLS * term.cell_w),
             ((r - 1) * term.cell_h + term.cell_h // 2) * h / (ROWS * term.cell_h)) for c, r in cells]
    ok = isinstance(got, list) and len(got) == len(want) and all(abs(g[0] - x) <= 2 and abs(g[1] - y) <= 2 for g, (x, y) in zip(got, want))
    check(f"{label}: clicks in every corner land where they were made", ok, (got, want, w, h))

try:
    check("page loads", t.wait_text("termium test page", 40)); t.wait_idle(1.0, 15)
    check("with the bars: the page is under them, right of the sidebar", wait_placed(t, BARS), placed(t))
    t.shot(os.path.join(OUT, "bars.png"))

    # ---------------------------------------------------- Ctrl+B F
    t.key("ctrl+b"); t.key("f"); time.sleep(1.0)
    check("Ctrl+B f (lower case) leaves chromeless off", ctl("chromeless") == {"chromeless": False} and bars_shown(t), (ctl("chromeless"), t.line(2)))
    t.key("ctrl+b"); t.key("shift+f")
    check("Ctrl+B F: a line over the top says how to get back", t.wait_for(lambda: "Ctrl+B F shows the bars" in t.line(1), 5), t.line(1))
    check("...while it shows, the picture leaves that row out (cut, not squeezed)",
          t.wait_for(lambda: placed(t) == [(2, 1, COLS, ROWS - 1)], 5) and b",r=44,y=" in bytes(t.raw), placed(t))
    check("...then the page fills every row and column", wait_placed(t, FULL, 8), placed(t))
    check("...and no bar is drawn", not bars_shown(t) and "termium test page" not in t.text(), t.text()[:400])
    size = ev("[innerWidth, innerHeight]")
    check("the page's viewport has the terminal's shape", isinstance(size, list) and abs(size[0] / size[1] - (COLS * 10) / (ROWS * 20)) < 0.01, size)
    img = t.latest_image()
    check("the picture has the terminal's shape", img is not None and abs(img.width / img.height - (COLS * 10) / (ROWS * 20)) < 0.01, img and img.size)
    t.shot(os.path.join(OUT, "chromeless.png"))
    mouse_lines_up(t, "chromeless")
    check("the Ctrl+B prefix shows over the top while it waits", (t.key("ctrl+b"), t.wait_for(lambda: "^B" in t.line(1), 3))[1], t.line(1))
    t.key("escape"); check("...and goes after", wait_placed(t, FULL, 5), placed(t))

    # ---------------------------------------------------- Ctrl+L navigates
    t.key("ctrl+l")
    check("Ctrl+L opens the popup address bar", t.wait_for(lambda: "Go to an address, search, or run a command" in t.text(), 5), t.text()[:300])
    t.type(f"{BASE}/reader.html"); t.key("enter")
    check("...and Enter goes there", t.wait_for(lambda: (ctl("tabs") or [{}])[0].get("url", "").endswith("/reader.html"), 20), ctl("tabs"))
    check("a navigation says it's loading, then the title, over the top",
          t.wait_for(lambda: "Loading" in t.line(1) or "eader" in t.line(1), 5), t.line(1))
    check("...then the page fills the terminal again", wait_placed(t, FULL, 10), placed(t))

    # ---------------------------------------------------- tabs
    ctl("open", f"{BASE}/page.html", "--new-tab")
    check("a second tab", len(ctl("tabs")) == 2, ctl("tabs"))
    wait_placed(t, FULL, 10)
    first = ctl("tabs")[0]["id"]
    t.key("ctrl+b"); t.key("1")
    check("Ctrl+B 1 switches tab", t.wait_for(lambda: active_tab() == first, 5), ctl("tabs"))
    check("...and says which over the top", t.wait_for(lambda: "Tab 1 of 2" in t.line(1), 3), t.line(1))
    t.key("ctrl+b"); t.key("n")
    check("Ctrl+B n switches to the next", t.wait_for(lambda: active_tab() != first, 5), ctl("tabs"))
    check("...the page fills the terminal", wait_placed(t, FULL, 8), placed(t))
    t.key("ctrl+l"); time.sleep(0.4); t.type(">clipboard reader"); time.sleep(0.5); t.key("enter")
    check("a tab picked in the palette says which over the top too", t.wait_for(lambda: "Tab 1 of 2" in t.line(1), 5), t.line(1))
    check("...and shows it", t.wait_for(lambda: active_tab() == first, 5), ctl("tabs"))
    wait_placed(t, FULL, 8)
    t.key("alt+equal")
    check("zoom says its level over the top", t.wait_for(lambda: "Zoom 110%" in t.line(1), 5), t.line(1))
    t.key("alt+0"); wait_placed(t, FULL, 8)

    # ---------------------------------------------------- splits: the line over the top covers pane headers
    t.key("ctrl+b"); t.key("v"); time.sleep(1.5); t.key("escape")
    check("a split: two panes, each with a header on row 1", t.wait_for(lambda: len(placed(t)) == 2 and all(p[0] == 2 for p in placed(t)), 10), placed(t))
    t.key("ctrl+b"); t.key("shift+w")
    check("the rename prompt shows over the pane headers", t.wait_for(lambda: "Rename space" in t.line(1), 5), t.line(1))
    t.key("escape")
    check("...the resize mode label too", (t.key("ctrl+b"), t.key("r"), t.wait_for(lambda: "RESIZE" in t.line(1), 5))[2], t.line(1))
    t.key("escape"); time.sleep(0.3)
    t.key("ctrl+b"); t.key("x")
    check("back to one pane filling the terminal", wait_placed(t, FULL, 10), placed(t))
    ev("window.__wh = 0; addEventListener('wheel', () => __wh++, true); 0")
    t.key("ctrl+b"); t.key("shift+w"); t.wait_for(lambda: "Rename space" in t.line(1), 5)
    t.scroll(COLS * 5, 5, n=3); time.sleep(0.6)
    check("the wheel over that line doesn't reach the page under it", ev("__wh") == 0, ev("__wh"))
    t.scroll(COLS * 5, 100, n=3); time.sleep(0.6)
    check("...below it, it does", (ev("__wh") or 0) > 0, ev("__wh"))
    t.key("escape"); wait_placed(t, FULL, 8)
    # A one-row pane on top: while the line shows, its picture goes (it would cover the line).
    t.resize(COLS, 10); time.sleep(1.5)
    t.key("ctrl+b"); t.key("minus"); time.sleep(1.5); t.key("escape"); time.sleep(0.5)
    t.key("ctrl+b"); t.key("k"); time.sleep(0.3)
    t.key("ctrl+b"); t.key("r")
    for _ in range(4):
        t.key("shift+k"); time.sleep(0.2)
    t.key("escape"); time.sleep(1.0)
    top = lambda: [p for p in placed(t) if p[0] == 1]
    check("a one-row pane on top", t.wait_for(lambda: [p[3] for p in top()] == [1], 8), placed(t))
    t.key("ctrl+b")
    check("...hides while the ^B line shows", t.wait_for(lambda: not top() and "^B" in t.line(1), 5), (placed(t), t.line(1)))
    t.key("escape")
    check("...and comes back after", t.wait_for(lambda: [p[3] for p in top()] == [1], 8), placed(t))
    t.key("ctrl+b"); t.key("x"); time.sleep(1.0)
    t.resize(COLS, ROWS)
    check("back to one pane filling the terminal (again)", wait_placed(t, FULL, 10), placed(t))

    # ---------------------------------------------------- the palette, the help
    t.key("ctrl+l"); time.sleep(0.4); t.type(">chromeless"); time.sleep(0.5)
    check("the palette offers 'Toggle chromeless' with its key", "Toggle chromeless" in t.text() and "Ctrl+B F" in t.text(), t.text()[:600])
    t.key("enter")
    check("...which brings the bars back", t.wait_for(lambda: bars_shown(t), 5) and wait_placed(t, BARS, 8), (t.line(2), placed(t)))
    t.key("ctrl+l"); time.sleep(0.4); t.type(">chromeless"); time.sleep(0.5); t.key("enter")
    check("...and hides them again", wait_placed(t, FULL, 8) and not bars_shown(t), placed(t))
    t.key("ctrl+b"); t.key("question")
    check("help lists Ctrl+B F", t.wait_for(lambda: re.search(r"(^|\s)F\s+chromeless", t.text(), re.M), 5), t.text()[:600])
    t.key("escape"); wait_placed(t, FULL, 8)

    # ---------------------------------------------------- ctl
    check("ctl chromeless says it's on", ctl("chromeless") == {"chromeless": True}, ctl("chromeless"))
    check("ctl chromeless off", ctl("chromeless", "off") == {"chromeless": False} and wait_placed(t, BARS, 8), placed(t))
    check("ctl chromeless toggle", ctl("chromeless", "toggle") == {"chromeless": True} and wait_placed(t, FULL, 8), placed(t))
    ctl("chromeless", "off"); ctl("chromeless", "on"); ctl("chromeless", "off")
    check("turned off while its hint shows: the hint goes too", t.wait_for(lambda: bars_shown(t), 5) and "Chromeless:" not in t.text(), t.line(2))
    ctl("chromeless", "on")
    t.key("ctrl+l"); time.sleep(0.3); t.type(f"{BASE}/page.html?soon=1"); t.key("enter")
    check("a page loaded while the hint shows still says what it is", t.wait_for(lambda: "termium test page" in t.line(1), 5), t.line(1))
    wait_placed(t, FULL, 8)
    bad = subprocess.run(["bun", os.path.join(ROOT, "src/main.ts"), "ctl", "-s", SESSION, "chromeless", "maybe"], env=ENV, capture_output=True, text=True)
    check("ctl chromeless maybe: a usage error", bad.returncode == 2 and "on, off or toggle" in bad.stderr, bad.stderr)

    # ---------------------------------------------------- a restart into a newer termium keeps it
    t.key("ctrl+b"); t.key("d"); time.sleep(1.5)
    u = Term(["bun", os.path.join(newer, "src/main.ts"), "attach", SESSION], cols=COLS, rows=ROWS, cwd=ROOT, env=ENV)
    clients.append(u)
    check("attached from a newer termium: still chromeless", wait_placed(u, FULL, 20) and not bars_shown(u), placed(u))
    old = u.server_pid(SESSION)
    time.sleep(2)  # (that termium is checked to report its version)
    u.key("ctrl+b"); u.key("shift+u")
    check("Ctrl+B U offers the restart", u.wait_for(lambda: "r restart" in u.text(), 10), u.text()[:600])
    u.key("r")
    check("the session restarts", u.wait_for(lambda: u.server_pid(SESSION) not in (None, old), 40))
    check("...says so over the top", u.wait_for(lambda: f"→ {NEXT}" in u.line(1), 40), u.line(1))
    check("...and is still chromeless", wait_placed(u, FULL, 20) and not bars_shown(u), placed(u))
    check("...ctl agrees", ctl("chromeless", main=os.path.join(newer, "src/main.ts")) == {"chromeless": True})
    check("...both tabs came back", len(ctl("tabs", main=os.path.join(newer, "src/main.ts"))) == 2)
    u.shot(os.path.join(OUT, "after-restart.png"))
    mouse_lines_up(u, "after the restart")

    # ---------------------------------------------------- --chromeless
    ctl("chromeless", "off", main=os.path.join(newer, "src/main.ts"))
    check("off again", wait_placed(u, BARS, 8), placed(u))
    u.key("ctrl+b"); u.key("d"); time.sleep(1.5)
    a = Term(["bun", os.path.join(newer, "src/main.ts"), "attach", SESSION, "--chromeless"], cols=COLS, rows=ROWS, cwd=ROOT, env=ENV)
    clients.append(a)
    check("termium attach --chromeless turns it on in a running session", wait_placed(a, FULL, 20) and not bars_shown(a), placed(a))
    check("...the bars are never drawn for it (no tab bar or sidebar)", b"space 1" not in bytes(a.raw))
    a.close(); clients.remove(a)
    fresh = Term(["bun", os.path.join(ROOT, "src/main.ts"), "-s", "pr7-flag", "--incognito", "--chromeless", f"{BASE}/page.html"],
                 cols=COLS, rows=ROWS, cwd=ROOT, env=ENV)
    clients.append(fresh)
    check("termium --chromeless: a new session starts chromeless", fresh.wait_for(lambda: fresh.frames > 0, 40) and wait_placed(fresh, FULL, 20), placed(fresh))
    check("...the bars are never drawn (no tab bar or sidebar)", b"space 1" not in bytes(fresh.raw))
    fresh.close(); clients.remove(fresh)
    bad = subprocess.run(["bun", os.path.join(ROOT, "src/main.ts"), "ls", "--chromeless"], env=ENV, capture_output=True, text=True)
    check("--chromeless with ls: a usage error", bad.returncode == 2, bad.stderr)
finally:
    # Ctrl+Q from a client ends the session; then the servers left, then the first client (it owns the dirs).
    for c in reversed(clients):
        if c is not t:
            try:
                c.close()
            except Exception:
                pass
    for s in (SESSION, "pr7-flag"):
        t.stop_server(s)
    t.close()
    srv.terminate()
    shutil.rmtree(tmp, ignore_errors=True)

print(f"\n{len(failures)} failure(s)" + (f": {failures}" if failures else ""), f"\nshots in {OUT}")
sys.exit(1 if failures else 0)
