#!/usr/bin/env python3
"""End-to-end check of the back/forward history menu (issue #19): real termium
+ real headless Helium in a Ghostty-like PTY. Visits five local pages, then
right-clicks ← and → and jumps several entries at a time with the mouse.

Usage: python3 tests/history.py [outdir]
"""
import json, os, shutil, socket, subprocess, sys, tempfile, time
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
from drive import Term

OUT = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="termium-history-")
os.makedirs(OUT, exist_ok=True)
profile = tempfile.mkdtemp(prefix="termium-history-profile-")
site = tempfile.mkdtemp(prefix="termium-history-site-")
for n in range(1, 6):
    with open(os.path.join(site, f"h{n}.html"), "w") as f:
        f.write(f"<!doctype html><title>Hist {n}</title><h1 style='font-size:80px'>History page {n}</h1>")
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0)); PORT = sock.getsockname()[1]
PY = shutil.which("python3") or sys.executable
srv = subprocess.Popen([PY, "-m", "http.server", str(PORT), "--bind", "127.0.0.1", "--directory", site],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.5)
BASE = f"http://127.0.0.1:{PORT}"

failures = []
def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))
    if not cond: failures.append(name)

def location():
    r = subprocess.run(["bun", os.path.join(ROOT, "tests/support/cdp-eval.ts"), profile, "location.href"],
                       capture_output=True, text=True, timeout=20)
    pages = [p["value"] for p in json.loads(r.stdout or "[]") if f":{PORT}/" in (p["value"] or "")]
    return pages[0] if len(pages) == 1 else pages

def find(text, rows=None):
    """1-based (col, row) of the first cell showing `text` (on `rows`, or anywhere)."""
    for r in rows or range(1, t.rows + 1):
        i = t.line(r).find(text)
        if i >= 0:
            return i + 1, r
    return None

def menu_rows():
    """The menu's item titles, top to bottom (rows under the address bar)."""
    return [r for r in range(3, t.rows + 1) if "Hist " in t.line(r)]

def menu_titles():
    out = []
    for r in menu_rows():
        line = t.line(r)
        i = line.find("Hist ")
        out.append(line[i:i + 6])
    return out

def right_click(arrow):
    at = find(arrow, [2])
    assert at, f"{arrow!r} not on the address line: {t.line(2)!r}"
    t.click_cell(at[0], 2, 2)
    return t.wait_for(lambda: find("Back" if arrow == "←" else "Forward", range(3, t.rows + 1)) is not None, 5)

def pick(title):
    at = find(title, range(3, t.rows + 1))
    assert at, f"{title!r} not in the menu"
    t.click_cell(at[0], at[1])

def landed(n):
    want = f"{BASE}/h{n}.html"
    ok = t.wait_for(lambda: location() == want, 10)
    ok = ok and t.wait_for(lambda: f"h{n}.html" in t.line(2), 5)
    return ok

t = Term(["bun", os.path.join(ROOT, "src/main.ts"), "-s", "pr19-history", "--profile", profile, f"{BASE}/h1.html"],
         cols=160, rows=45, cwd=ROOT)
try:
    t.wait_text("Hist 1", 25); t.wait_idle(0.8, 10); time.sleep(0.5)
    for n in range(2, 6):
        t.key("ctrl+l"); time.sleep(0.2)
        t.type(f"{BASE}/h{n}.html"); t.key("enter")
        t.wait_for(lambda: location() == f"{BASE}/h{n}.html", 10); time.sleep(0.3)
    check("visited five pages", landed(5), str(location()))

    check("right-click ← opens the Back menu", right_click("←"))
    check("the Back menu lists earlier pages, nearest first", menu_titles() == ["Hist 4", "Hist 3", "Hist 2", "Hist 1"], str(menu_titles()))
    check("rows show the host", all(f"127.0.0.1:{PORT}" in t.line(r) for r in menu_rows()))
    t.shot(f"{OUT}/back-menu.png")
    pick("Hist 2")
    check("clicking Hist 2 jumps three back (page and address bar)", landed(2), f"{location()} | {t.line(2)}")
    check("the menu closed", not menu_rows())

    check("right-click → opens the Forward menu", right_click("→"))
    check("the Forward menu lists later pages, nearest first", menu_titles() == ["Hist 3", "Hist 4", "Hist 5"], str(menu_titles()))
    t.shot(f"{OUT}/forward-menu.png")
    pick("Hist 5")
    check("clicking Hist 5 jumps three forward", landed(5), f"{location()} | {t.line(2)}")

    right_click("→")
    check("at the newest page, → shows no later pages", find("No later pages", range(3, t.rows + 1)) is not None)
    pick("No later pages")
    time.sleep(0.5)
    check("the disabled row does nothing", find("No later pages", range(3, t.rows + 1)) is not None and location() == f"{BASE}/h5.html")
    t.key("escape"); time.sleep(0.3)
    check("Escape closes the menu", find("No later pages", range(3, t.rows + 1)) is None)

    right_click("←")
    pick("Hist 1")
    check("clicking Hist 1 jumps four back", landed(1), f"{location()} | {t.line(2)}")

    # Every tab starts on a blank page: the one entry before the first site.
    right_click("←")
    check("at the first site, ← lists only the tab's blank start page", find("New Tab", range(3, t.rows + 1)) is not None and not menu_rows())
    pick("New Tab")
    check("clicking New Tab goes to the blank page (empty address bar)",
          t.wait_for(lambda: str(location()) == "[]" or str(location()).startswith("about:blank"), 10) and t.wait_for(lambda: "h1.html" not in t.line(2), 5),
          f"{location()} | {t.line(2)}")
    right_click("←")
    check("at the oldest entry, ← shows no earlier pages", find("No earlier pages", range(3, t.rows + 1)) is not None)
    t.click_cell(100, 30); time.sleep(0.4)
    check("a click outside closes the menu", find("No earlier pages", range(3, t.rows + 1)) is None)

    # A plain left-click still steps one entry.
    t.click_cell(find("→", [2])[0], 2)
    check("left-click → still goes forward one", landed(1), f"{location()} | {t.line(2)}")
finally:
    t.close()
    srv.terminate()
    shutil.rmtree(profile, ignore_errors=True)
    shutil.rmtree(site, ignore_errors=True)

print(f"\nscreenshots: {OUT}")
print("FAILED: " + ", ".join(failures) if failures else "ALL PASSED")
sys.exit(1 if failures else 0)
