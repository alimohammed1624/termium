#!/usr/bin/env python3
"""End-to-end check of mouse-only use (issue #14): real termium + real headless
Helium in a Ghostty-like PTY, driven only by clicks, right-clicks, the wheel
and drags.

Usage: python3 tests/mouse.py [outdir]
"""
import json, os, shutil, socket, subprocess, sys, tempfile, time
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
from drive import Term

OUT = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="termium-mouse-")
os.makedirs(OUT, exist_ok=True)
profile = tempfile.mkdtemp(prefix="termium-mouse-profile-")
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

def evaluate(expr, match="menu.html"):
    r = subprocess.run(["bun", os.path.join(ROOT, "tests/support/cdp-eval.ts"), profile, expr], capture_output=True, text=True, timeout=20)
    return [p["value"] for p in json.loads(r.stdout or "[]") if match in p["url"]]

def find(text, row=None):
    """1-based (col, row) of the first cell showing `text` (on `row`, or anywhere)."""
    rows = [row] if row else range(1, t.rows + 1)
    for r in rows:
        i = t.line(r).find(text)
        if i >= 0:
            return i + 1, r
    return None

def click_text(text, row=None, button=0):
    at = find(text, row)
    assert at, f"{text!r} not on screen"
    t.click_cell(at[0], at[1], button)
    return at

def tab_count():
    return sum(1 for p in json.loads(subprocess.run(["bun", os.path.join(ROOT, "tests/support/cdp-eval.ts"), profile, "1"],
               capture_output=True, text=True, timeout=20).stdout or "[]"))

t = Term(["bun", os.path.join(ROOT, "src/main.ts"), "-s", "pr14-mouse", "--profile", profile, f"{BASE}/menu.html"],
         cols=160, rows=45, cwd=ROOT)
try:
    t.wait_text("menu test", 25); t.wait_idle(0.8, 10); time.sleep(1)
    check("the active tab shows a close button", "×" in t.line(1), t.line(1))
    check("the address line ends with the ≡ button", t.line(2).rstrip().endswith("≡"), t.line(2))

    # The ≡ menu lists every action with its keys.
    t.click_cell(159, 2); time.sleep(0.6)
    check("≡ opens the menu", t.wait_text("Split right", 5))
    check("menu shows keybinds", find("^B v") is not None and find("Ctrl+Q") is not None)
    t.shot(f"{OUT}/01-main-menu.png")
    click_text("Split right"); time.sleep(1.5)
    check("menu closed after choosing", find("Hard reload") is None)
    check("Split right made a second pane (with a ×)", t.wait_for(lambda: t.line(3).count("×") == 2, 8), t.line(3))
    t.key("escape"); time.sleep(0.3)
    # The second pane's ×: the rightmost one in the header row.
    row3 = t.line(3)
    t.click_cell(row3.rfind("×") + 1, 3); time.sleep(1.5)
    check("the pane header × closes the pane", t.wait_for(lambda: "×" not in t.line(3), 8), t.line(3))

    # Right-click a tab: its menu; Duplicate.
    click_text("menu test", row=1, button=2); time.sleep(0.6)
    check("right-click on a tab opens its menu", t.wait_text("Duplicate", 5))
    check("tab menu shows keys", find("Close other tabs") is not None and find("^B X") is not None)
    t.shot(f"{OUT}/02-tab-menu.png")
    click_text("Duplicate"); time.sleep(2)
    check("Duplicate opens a second tab", t.wait_for(lambda: t.line(1).count("menu test") == 2, 10), t.line(1))

    # Drag the second tab onto the first: they swap.
    first, second = [i for i in range(len(t.line(1))) if t.line(1).startswith(" 1 ", i) or t.line(1).startswith(" 2 ", i)][:2]
    check("before the drag, the second tab is the active one", t.screen.buffer[0][second + 2].bold and not t.screen.buffer[0][first + 2].bold)
    t.mouse((second + 3) * 10 + 5, 10, 0, "press"); time.sleep(0.3)
    for x in range(second + 3, first + 1, -2):
        t.mouse(x * 10 + 5, 10, 0, "drag"); time.sleep(0.05)
    t.mouse((first + 2) * 10 + 5, 10, 0, "release"); time.sleep(0.8)
    bold = lambda col: t.screen.buffer[0][col + 2].bold
    check("dragging a tab reorders it (the dragged, active tab is first now)", bold(first) and not bold(second), t.line(1))

    # Right-click on a tab's ×: the tab's menu.
    click_text("×", row=1, button=2); time.sleep(0.6)
    check("right-click on a tab's × opens the tab menu", t.wait_text("Duplicate", 5))
    t.key("escape"); time.sleep(0.6)

    # The tab's ×.
    click_text("×", row=1); time.sleep(2)
    check("the tab × closes the tab", t.wait_for(lambda: t.line(1).count("menu test") == 1, 10), t.line(1))

    # Right-click on the page: termium's page menu, unless the page has its own.
    t.wait_idle(0.5, 5)
    t.click(220 + 400, 40 + 300, button=2); time.sleep(1)
    check("right-click on the page opens termium's page menu", t.wait_text("Copy page address", 5))
    t.shot(f"{OUT}/03-page-menu.png")
    click_text("Reload"); time.sleep(2); t.wait_idle(0.5, 5)
    t.click(220 + 400, 40 + 300, button=2); time.sleep(1)
    check("after Reload from the page menu, the next right-click opens it again", t.wait_text("Copy page address", 5))
    t.key("escape"); time.sleep(0.6)
    check("Escape closes the menu", find("Copy page address") is None)
    t.click(220 + 500, 40 + 100, button=2); time.sleep(1)
    check("right-click inside an iframe opens the page menu", t.wait_text("Copy page address", 5))
    t.key("escape"); time.sleep(0.6)
    t.click(220 + 60, 40 + 100, button=2); time.sleep(1.2)
    check("a page with its own context menu gets it (termium shows none)", find("Copy page address") is None and evaluate("window.own") == [1],
          evaluate("window.own"))
    t.click(220 + 30, 40 + 28, button=2); time.sleep(1)
    check("right-click on a link offers to open it", t.wait_text("Open link in new tab", 5))
    t.click_cell(1 + 22 + 140, 40); time.sleep(0.6)  # outside the menu
    check("a click outside closes the menu", find("Open link in new tab") is None)

    # A page's confirm(): clickable answers.
    t.click(220 + 35, 40 + 210); time.sleep(1)
    check("dialog shows its buttons", t.wait_text("Cancel  Esc", 5), t.line(2))
    t.shot(f"{OUT}/04-dialog.png")
    click_text("Cancel  Esc", row=2); time.sleep(1)
    check("clicking Cancel answers the dialog", evaluate("window.answer") == [False], evaluate("window.answer"))
    t.click(220 + 35, 40 + 210); time.sleep(1); t.wait_text("OK  Enter", 5)
    click_text("OK  Enter", row=2); time.sleep(1)
    check("clicking OK answers the dialog", evaluate("window.answer") == [True], evaluate("window.answer"))

    # Many tabs: the wheel and the ‹ › arrows scroll the tab bar.
    for _ in range(10):
        click_text(" + ", row=1); time.sleep(0.4); t.key("escape"); time.sleep(0.2)
    time.sleep(1)
    before = t.line(1)
    check("tabs overflow (‹ shown)", "‹" in before, before)
    t.scroll(400, 10, down=False, n=3); time.sleep(0.6)
    check("the wheel scrolls the tab bar", t.line(1) != before and " 1 " in t.line(1), t.line(1))
    click_text("›", row=1); time.sleep(0.6)
    check("› scrolls the tab bar", " 1 " not in t.line(1)[:30], t.line(1))
    click_text("‹", row=1); time.sleep(0.6)
    check("‹ scrolls the tab bar back", " 1 " in t.line(1), t.line(1))

    # A tab closed while it's being dragged: the drag ends, termium carries on.
    at = find(" 2 ", row=1)
    t.mouse(at[0] * 10 + 15, 10, 0, "press"); time.sleep(0.4)
    t.key("ctrl+w"); time.sleep(1.5)
    for x in range(at[0] + 2, 24, -3):
        t.mouse(x * 10, 10, 0, "drag"); time.sleep(0.05)
    t.mouse(250, 10, 0, "release"); time.sleep(0.8)
    check("closing the dragged tab mid-drag doesn't end termium", os.waitpid(t.pid, os.WNOHANG)[0] == 0 and "New Tab" in t.line(1), t.line(1))

    # Spaces: right-click menu; rename.
    click_text("space 1", button=2); time.sleep(0.6)
    check("right-click on a space opens its menu", t.wait_text("Rename space", 5))
    click_text("Rename space"); time.sleep(0.6)
    check("Rename space opens the rename prompt", t.wait_text("Rename space:", 5), t.line(2))
    t.key("escape"); time.sleep(0.4)

    # The sidebar's « hides it; the ≡ menu shows it again; the hint opens the keys.
    t.click_cell(21, 1); time.sleep(0.8)
    check("« hides the sidebar", t.wait_for(lambda: not t.line(1).startswith(" termium"), 5), t.line(1))
    t.click_cell(159, 2); time.sleep(0.6); click_text("Show sidebar"); time.sleep(0.8)
    check("≡ → Show sidebar shows it", t.wait_for(lambda: t.line(1).startswith(" termium"), 5), t.line(1))
    click_text("^B ? for keys", row=t.rows); time.sleep(0.8)
    check("the ^B ? hint opens the keys", t.wait_text("termium keys", 5))
    t.click_cell(80, 20); time.sleep(0.6)
finally:
    t.close()

# Unicode placeholders (as inside tmux): the menu stays on top of the page's cells.
shutil.rmtree(profile, ignore_errors=True); os.makedirs(profile)
t = Term(["bun", os.path.join(ROOT, "src/main.ts"), "-s", "pr14-mouse-ph", "--profile", profile, f"{BASE}/menu.html"],
         cols=160, rows=45, cwd=ROOT, env={"TERMIUM_GRAPHICS": "placeholders"})
try:
    t.wait_text("menu test", 25); t.wait_idle(0.8, 10); time.sleep(1)
    t.click(220 + 400, 40 + 300, button=2); time.sleep(1.5)
    check("placeholders: the page menu shows over the page", t.wait_text("Copy page address", 5))
    t.key("escape"); time.sleep(0.8)
    t.click_cell(159, 2); time.sleep(1)
    check("placeholders: the ≡ menu shows over the page", t.wait_text("Split right", 5) and find("Hard reload") is not None)
finally:
    t.close()

# The update box answers clicks: a newer release (a fake one), its offer opened from ≡, "skip" clicked.
rel = tempfile.mkdtemp(prefix="termium-mouse-rel-")
with open(os.path.join(rel, "latest"), "w") as f:
    f.write('{"tag_name": "v99.0.0"}')
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0)); RPORT = sock.getsockname()[1]
rsrv = subprocess.Popen([PY, "-m", "http.server", str(RPORT), "--bind", "127.0.0.1", "--directory", rel],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.5)
shutil.rmtree(profile, ignore_errors=True); os.makedirs(profile)
t = Term(["bun", os.path.join(ROOT, "src/main.ts"), "-s", "pr14-mouse-up", "--profile", profile, f"{BASE}/menu.html"],
         cols=160, rows=45, cwd=ROOT, env={"TERMIUM_NO_UPDATE_CHECK": "", "CI": "", "TERMIUM_UPDATE_URL": f"http://127.0.0.1:{RPORT}/latest"})
try:
    t.wait_text("menu test", 25); t.wait_idle(0.8, 10)
    check("a newer release is announced", t.wait_text("99.0.0", 20))
    t.click_cell(159, 2); time.sleep(0.6); click_text("Update termium"); time.sleep(1)
    check("≡ → Update termium opens the update box", t.wait_text("skip this version", 5))
    tabs_before = t.line(1).count("menu test")
    t.click_cell(t.line(1).find("×") + 1, 1); time.sleep(1)
    check("with the update box open, the tab bar's × doesn't act (the click only puts the box away)",
          t.line(1).count("menu test") == tabs_before and find("skip this version") is None, t.line(1))
    # A short terminal cuts the choice lines: the footer's keys click instead.
    t.resize(160, 11); time.sleep(1.5)
    t.key("ctrl+b"); t.key("shift+u"); time.sleep(1)  # (opening it isn't what's tested here)
    check("short terminal: the update box footer shows its keys", t.wait_text("s skip", 5))
    click_text("s skip"); time.sleep(1.5)
    check("clicking a key in the update box footer answers it", find("s skip") is None and t.wait_text("skipped", 5))
finally:
    t.close()
    rsrv.terminate()
    shutil.rmtree(rel, ignore_errors=True)
    srv.terminate()
    shutil.rmtree(profile, ignore_errors=True)

print(f"\nscreenshots: {OUT}")
print("FAILED: " + ", ".join(failures) if failures else "ALL PASSED")
sys.exit(1 if failures else 0)
