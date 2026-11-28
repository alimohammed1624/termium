#!/usr/bin/env python3
"""The popup address bar and command palette (Ctrl+L), against the real
termium and headless browser.

    python3 tests/palette.py [OUT_DIR]
"""
import json, os, shutil, socket, subprocess, sys, tempfile, time
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
from drive import Term

OUT = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="termium-palette-")
os.makedirs(OUT, exist_ok=True)
profile = tempfile.mkdtemp(prefix="termium-palette-profile-")
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0)); PORT = sock.getsockname()[1]
PY = shutil.which("python3") or sys.executable
srv = subprocess.Popen([PY, "-m", "http.server", str(PORT), "--bind", "127.0.0.1",
                        "--directory", os.path.join(ROOT, "tests", "fixtures")],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.5)
BASE = f"http://127.0.0.1:{PORT}"
SESSION = "pr8-palette"

failures = []
def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else f"  -- {detail!r}"), flush=True)
    if not cond:
        failures.append(name)

t = Term(["bun", os.path.join(ROOT, "src/main.ts"), "-s", SESSION, "--profile", profile, f"{BASE}/page.html"], cwd=ROOT)

def ctl(*args):
    env = dict(os.environ, XDG_RUNTIME_DIR=t.runtime_dir)
    r = subprocess.run(["bun", os.path.join(ROOT, "src/main.ts"), "ctl", "-s", SESSION, *args, "--json"],
                       cwd=ROOT, env=env, capture_output=True, text=True, timeout=60)
    return json.loads(r.stdout) if r.stdout.strip() else None

def row_with(s):
    """The (1-based) screen row showing `s`, or 0."""
    for i in range(1, t.rows + 1):
        if s in t.line(i):
            return i
    return 0

def popup_open():
    return "Go to an address, search, or run a command" in t.text()

try:
    check("page loads", t.wait_text("termium test page", 40)); t.wait_idle(1.0, 15)
    check("page picture shown", len(t.placements) > 0)

    # Ctrl+L: the box opens with the current address selected, and Enter's row first.
    t.key("ctrl+l")
    check("Ctrl+L opens the popup", t.wait_for(popup_open, 5), t.text())
    t.wait_idle(0.5, 5)
    check("page pictures are taken away under it", t.wait_for(lambda: not t.placements, 3), t.placements)
    check("Enter's row: go to the current address", row_with(f"Go to {BASE}/page.html") > 0, t.text())
    r = row_with("› ")
    check("the address shows selected in the box", r > 0 and BASE in t.line(r), t.text())
    check("actions are listed with their shortcuts", row_with("New tab") and "Ctrl+T" in t.line(row_with("New tab")), t.text())
    check("the list counts every action", "/31 " in t.text(), t.text())
    t.shot(os.path.join(OUT, "palette-open.png"))

    # Typing filters; Enter on the default row searches/goes, never runs an action by surprise.
    t.type("split")
    check("typing filters to matching actions", t.wait_for(lambda: row_with("Split down") and not row_with("Reload"), 3), t.text())
    check("search row first", row_with("Search for split") and row_with("Search for split") < row_with("Split right"), t.text())
    t.shot(os.path.join(OUT, "palette-filter.png"))
    # Down, Enter: split right.
    t.key("down"); t.key("enter")
    check("Down + Enter runs the action (split right; new pane asks for its address)",
          t.wait_for(lambda: popup_open() and t.line(row_with("› ")).strip() == "›" and "⊞2" in t.line(1), 8), t.text())
    t.type(f"{BASE}/page.html?second=1"); t.key("enter")
    check("Enter navigates the new pane", t.wait_for(lambda: not popup_open(), 5), t.text())
    time.sleep(2)
    tabs = ctl("tabs") or []
    check("the split made a second pane in the tab", len(tabs) == 2 and any("second=1" in x.get("url", "") for x in tabs), tabs)
    check("pages painted again after the popup closes", t.wait_for(lambda: len(t.placements) >= 2, 8), t.placements)

    # Esc closes, nothing done.
    t.key("ctrl+l"); t.wait_for(popup_open, 3)
    t.key("escape")
    check("Esc closes", t.wait_for(lambda: not popup_open(), 3))
    check("pages come back after Esc", t.wait_for(lambda: len(t.placements) >= 2, 8), t.placements)

    # ">" lists actions only; Enter runs the first.
    t.key("ctrl+l"); t.wait_for(popup_open, 3); t.type(">zoom in")
    check("'>' lists actions only, no search row", t.wait_for(lambda: row_with("Zoom in") and not row_with("Search for"), 3), t.text())
    t.key("enter")
    check("Enter runs 'Zoom in'", t.wait_for(lambda: "110%" in t.line(2), 5), t.line(2))
    t.key("alt+0"); time.sleep(0.5)

    # Mouse: a click on a row runs it.
    t.key("ctrl+l"); t.wait_for(popup_open, 3); t.type(">sidebar"); time.sleep(0.4)
    r = row_with("Toggle sidebar")
    col = t.line(r).find("Toggle sidebar") + 3
    had_sidebar = t.line(1).startswith(" termium")
    t.click_cell(col, r)
    check("a click on a row runs it (sidebar toggled)",
          t.wait_for(lambda: not popup_open() and t.line(1).startswith(" termium") != had_sidebar, 5), (t.line(1), t.text()))
    # A click outside the box closes it.
    t.key("ctrl+l"); t.wait_for(popup_open, 3); time.sleep(0.3)
    t.click_cell(2, t.rows - 1)
    check("a click outside closes it", t.wait_for(lambda: not popup_open(), 3))

    # Typed address, history and tabs.
    t.key("ctrl+l"); t.wait_for(popup_open, 3); t.type(f"{BASE}/page.html?third=1"); t.key("enter")
    check("typed address + Enter navigates", t.wait_for(lambda: "third=1" in t.line(2), 8), t.line(2))
    time.sleep(1.5)
    t.key("ctrl+l"); t.wait_for(popup_open, 3); t.type("page.html")
    check("a page seen before (and gone) is offered from history",
          t.wait_for(lambda: any("↺" in t.line(i) for i in range(1, t.rows + 1)), 3), t.text())
    t.key("escape"); time.sleep(0.3)
    t.key("ctrl+t"); t.wait_for(popup_open, 5); t.type(f"{BASE}/anim.html"); t.key("enter")
    time.sleep(2)
    t.key("ctrl+l"); t.wait_for(popup_open, 3); t.type("third")
    check("another tab is offered, with its shortcut", t.wait_for(lambda: row_with("Ctrl+B 1") > 0, 3), t.text())
    t.shot(os.path.join(OUT, "palette-tab.png"))
    t.key("down"); t.key("enter"); time.sleep(1)
    check("choosing it switches to that tab", t.wait_for(lambda: "third=1" in t.line(2), 5), t.line(2))

    # Paste goes into the box.
    t.key("ctrl+l"); t.wait_for(popup_open, 3); t.paste(">reset zoom")
    check("a paste lands in the box", t.wait_for(lambda: row_with("Reset zoom") and not row_with("Split right"), 3), t.text())
    t.key("escape")
finally:
    t.close()
    srv.terminate()
    shutil.rmtree(profile, ignore_errors=True)

print(f"\n{len(failures)} failure(s)" + (f": {failures}" if failures else ""), f"\nshots in {OUT}")
sys.exit(1 if failures else 0)
