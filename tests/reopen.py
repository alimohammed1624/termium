#!/usr/bin/env python3
"""Undo close: a closed tab or space comes back where it was, with its
address and history, from the toast's Undo or from Ctrl+Shift+T / Ctrl+B u.
Real termium + real headless Helium in a Ghostty-like PTY.

Usage: python3 tests/reopen.py
"""
import json, os, shutil, socket, subprocess, sys, tempfile, time
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
from drive import Term

tmp = tempfile.mkdtemp(prefix="termium-reopen-")
profile = os.path.join(tmp, "profile")
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0)); PORT = sock.getsockname()[1]
PY = shutil.which("python3") or sys.executable
srv = subprocess.Popen([PY, "-m", "http.server", str(PORT), "--bind", "127.0.0.1",
                        "--directory", os.path.join(ROOT, "tests", "fixtures")],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.5)
BASE = f"http://127.0.0.1:{PORT}/page.html"
SESSION = "pr22-reopen"

failures = []
def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))
    if not cond: failures.append(name)

COLS, ROWS = 120, 36
main = os.path.join(ROOT, "src/main.ts")
t = Term(["bun", main, "-s", SESSION, "--profile", profile, f"{BASE}?t=1"], cols=COLS, rows=ROWS, cwd=ROOT)
ENV = dict(os.environ, XDG_RUNTIME_DIR=t.runtime_dir, XDG_DATA_HOME=os.path.join(t.own_root, "data"),
           XDG_STATE_HOME=os.path.join(t.own_root, "state"), TERMIUM_NO_UPDATE_CHECK="1")

def ctl(*args):
    r = subprocess.run(["bun", main, "ctl", "-s", SESSION, *args, "--json"], cwd=ROOT, env=ENV, stdin=subprocess.DEVNULL,
                       capture_output=True, text=True, timeout=60, start_new_session=True)
    try:
        return json.loads(r.stdout)
    except ValueError:
        return {"_error": (r.returncode, r.stdout, r.stderr)}

def tabs():
    ts = ctl("tabs")
    return [(x["spaceName"], x["tab"], x["url"].split("?", 1)[-1]) for x in ts] if isinstance(ts, list) else ts

def active():
    ts = ctl("tabs")
    a = [x for x in ts if x.get("active")] if isinstance(ts, list) else []
    return (a[0]["spaceName"], a[0]["tab"], a[0]["url"].split("?", 1)[-1]) if a else ts

def go(url):
    t.key("ctrl+l"); time.sleep(0.2); t.type(url); t.key("enter")

def history():
    v = ctl("eval", "history.length")
    return v.get("value") if isinstance(v, dict) else v

def wait(pred, timeout=15):
    end = time.time() + timeout
    while time.time() < end:
        try:
            if pred(): return True
        except Exception:
            pass
        time.sleep(0.3)
    return False

def toast_cell(s):
    for i, l in enumerate(t.screen.display):
        if s in l:
            return l.index(s) + 1, i + 1
    return None

try:
    t.wait_text("termium test page", 40); t.wait_idle(0.8, 10)
    # Three tabs; the middle one with a history: t=2 -> t=2b -> t=2c, back to t=2b.
    t.key("ctrl+t"); time.sleep(0.5); t.type(f"{BASE}?t=2"); t.key("enter")
    check("second tab", wait(lambda: active()[2] == "t=2"), active())
    go(f"{BASE}?t=2b"); wait(lambda: active()[2] == "t=2b")
    go(f"{BASE}?t=2c"); wait(lambda: active()[2] == "t=2c")
    t.key("alt+left"); wait(lambda: active()[2] == "t=2b")
    t.key("ctrl+t"); time.sleep(0.5); t.type(f"{BASE}?t=3"); t.key("enter")
    check("three tabs", wait(lambda: len(tabs()) == 3 and active()[2] == "t=3"), tabs())
    t.key("ctrl+b"); t.key("2")
    check("middle tab is on t=2b", wait(lambda: active()[2] == "t=2b"), active())
    before, depth = tabs(), history()
    check("...with its history", depth >= 3, depth)

    # 1. Close it; Undo on the toast brings it back, in its place.
    t.key("ctrl+b"); t.key("shift+x")
    check("closed", wait(lambda: len(tabs()) == 2), tabs())
    check("toast says what closed, with Undo", t.wait_text("Undo", 5) and "Closed" in t.text(), t.text()[-500:])
    col, row = toast_cell("Undo")
    t.click((col) * t.cell_w + 3, (row - 1) * t.cell_h + 8)
    check("Undo reopens it in its old place, focused", wait(lambda: tabs() == before and active()[1] == before[1][1]), (tabs(), before))
    check("...on the entry it was on, with its history", wait(lambda: active()[2] == "t=2b" and history() == depth, 20), (active(), history()))
    check("...and the toast is gone", wait(lambda: "Undo" not in t.text(), 3))
    t.key("alt+left")
    check("back goes to t=2", wait(lambda: active()[2] == "t=2"), active())
    t.key("alt+right"); wait(lambda: active()[2] == "t=2b")
    t.key("alt+right")
    check("forward goes to t=2c", wait(lambda: active()[2] == "t=2c"), active())
    t.key("alt+left"); wait(lambda: active()[2] == "t=2b")

    # 2. Close it with Ctrl+W; once the toast is gone, Ctrl+Shift+T reopens it.
    t.mouse(5, 5, action="move")  # (a toast under the pointer waits)
    t.key("ctrl+w")
    check("closed again", wait(lambda: len(tabs()) == 2), tabs())
    check("toast shows", t.wait_text("Undo", 5))
    check("...and goes by itself", t.wait_for(lambda: "Undo" not in t.text(), 10))
    t.key("ctrl+shift+t")
    check("Ctrl+Shift+T reopens it in its place", wait(lambda: tabs() == before, 20), (tabs(), before))
    check("...with its history", wait(lambda: active()[2] == "t=2b" and history() == depth, 20), (active(), history()))

    # 3. A space: two tabs in a second space, closed with Ctrl+B D, back with Ctrl+B u.
    t.key("ctrl+b"); t.key("shift+n"); time.sleep(0.6); t.type(f"{BASE}?s=1"); t.key("enter")
    check("second space", wait(lambda: active()[2] == "s=1"), active())
    t.key("ctrl+t"); time.sleep(0.5); t.type(f"{BASE}?s=2"); t.key("enter")
    wait(lambda: active()[2] == "s=2")
    t.key("ctrl+b"); t.key("1")
    wait(lambda: active()[2] == "s=1")
    space_before = tabs()
    name = active()[0]
    check("two tabs in it", [x for x in space_before if x[0] == name] == [(name, 1, "s=1"), (name, 2, "s=2")], space_before)
    t.key("ctrl+b"); t.key("shift+d")
    check("the space closed", wait(lambda: all(x[0] != name for x in tabs())), tabs())
    check("toast names the space", t.wait_text("Closed space", 5), t.text()[-500:])
    t.key("ctrl+b"); t.key("u")
    check("Ctrl+B u reopens the space with its tabs, in order", wait(lambda: tabs() == space_before, 20), (tabs(), space_before))
    check("...on the tab that was shown", wait(lambda: active() == (name, 1, "s=1")), active())

    # 4. Nothing left: says so.
    t.key("ctrl+shift+t")
    check("nothing to reopen says so", t.wait_text("Nothing closed to reopen", 5), t.text()[-400:])
finally:
    t.close()
    srv.terminate()
    shutil.rmtree(tmp, ignore_errors=True)

print(f"\n{len(failures)} failure(s)" if failures else "\nall passed")
sys.exit(1 if failures else 0)
