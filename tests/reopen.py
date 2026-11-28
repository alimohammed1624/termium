#!/usr/bin/env python3
"""Undo close: a closed tab or space comes back where it was, with its
address and history, from the toast's Undo or from Ctrl+Shift+T / Ctrl+B u.
Real termium + real headless Helium in a Ghostty-like PTY.

Usage: python3 tests/reopen.py
"""
import functools, http.server, json, os, shutil, socket, subprocess, sys, tempfile, threading, time
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
from drive import Term

tmp = tempfile.mkdtemp(prefix="termium-reopen-")
profile = os.path.join(tmp, "profile")
# The fixtures, where an address with "slow" in it answers SLOW seconds late,
# and one with "nocontent" answers 204 (No Content: the page stays) while NOCONTENT is set.
SLOW = 0
NOCONTENT = False
class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if "slow" in self.path and SLOW:
            time.sleep(SLOW)
        if "nocontent" in self.path and NOCONTENT:
            self.send_response(204); self.end_headers(); return
        super().do_GET()
    def log_message(self, *a):
        pass
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Handler, directory=os.path.join(ROOT, "tests", "fixtures")))
srv.daemon_threads = True
PORT = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
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

    def new_tab(url):
        t.key("ctrl+t"); time.sleep(0.6); t.type(url); t.key("enter")
        return wait(lambda: active()[2] == url.split("?", 1)[-1])

    # 5. A history entry that doesn't answer in time: the page still ends up where it was.
    new_tab(f"{BASE}?f=1"); go(f"{BASE}?slow=1"); wait(lambda: active()[2] == "slow=1")
    go(f"{BASE}?f=cur"); wait(lambda: active()[2] == "f=cur")
    SLOW = 12  # longer than a step may take, shorter than two
    t.key("ctrl+w"); wait(lambda: all(x[2] != "f=cur" for x in tabs()))
    t.key("ctrl+shift+t")
    check("a slow history entry: the page still comes back on its address", wait(lambda: active()[2] == "f=cur", 25), active())
    SLOW = 0

    # 6. Something else navigating the page while its history is rebuilt wins.
    new_tab(f"{BASE}?g=1"); go(f"{BASE}?slow=2"); wait(lambda: active()[2] == "slow=2")
    go(f"{BASE}?g=cur"); wait(lambda: active()[2] == "g=cur")
    SLOW = 4
    t.key("ctrl+w"); wait(lambda: all(x[2] != "g=cur" for x in tabs()))
    t.key("ctrl+shift+t")
    wait(lambda: active()[2] == "slow=2", 10); time.sleep(1)
    ctl("eval", "location.href = '?person'; 1")
    check("a link followed during the rebuild is where the page goes", wait(lambda: active()[2] == "person", 10), active())
    time.sleep(8)
    check("...and stays", active()[2] == "person", active())
    SLOW = 0

    # 6b. ...going back between #fragments too.
    new_tab(f"{BASE}?fr=1"); go(f"{BASE}?fr=1#one"); time.sleep(0.5); go(f"{BASE}?slow=3"); wait(lambda: active()[2] == "slow=3")
    go(f"{BASE}?fr=cur"); wait(lambda: active()[2] == "fr=cur")
    SLOW = 5
    t.key("ctrl+w"); wait(lambda: all(x[2] != "fr=cur" for x in tabs()))
    t.key("ctrl+shift+t")
    wait(lambda: active()[2] == "slow=3", 10); time.sleep(1)
    t.key("alt+left")
    time.sleep(10)
    # (The browser may still finish loading the step under way; the rebuild goes no further.)
    check("Alt+Left during the rebuild (to another #fragment) stops it", active()[2] in ("fr=1", "slow=3"), active())
    SLOW = 0

    # 6c. An entry that doesn't load (204 No Content) isn't there: the page still ends up where it was.
    new_tab(f"{BASE}?n=1"); go(f"{BASE}?n=cur"); wait(lambda: active()[2] == "n=cur")
    go(f"{BASE}?nocontent=1"); wait(lambda: active()[2] == "nocontent=1")
    t.key("alt+left"); wait(lambda: active()[2] == "n=cur")
    NOCONTENT = True
    t.key("ctrl+w"); wait(lambda: all(x[2] != "n=cur" for x in tabs()))
    t.key("ctrl+shift+t")
    time.sleep(6)
    check("a forward entry that doesn't load: the page is on its address", wait(lambda: active()[2] == "n=cur", 15), active())
    NOCONTENT = False

    # 6d. Undo on an older toast, then the newer: both back in their order.
    for r in ("o=a", "o=b", "o=c"):
        new_tab(f"{BASE}?{r}")
    order = tabs()
    num = {x[2]: x[1] for x in order}
    t.key("ctrl+b"); t.key(str(num["o=a"])); wait(lambda: active()[2] == "o=a")
    t.key("ctrl+w"); wait(lambda: all(x[2] != "o=a" for x in tabs()))
    t.key("ctrl+b"); t.key(str(num["o=b"] - 1)); wait(lambda: active()[2] == "o=b")
    t.mouse(5, 5, action="move")
    t.key("ctrl+w"); wait(lambda: all(x[2] != "o=b" for x in tabs()))
    t.wait_for(lambda: t.text().count("Undo") == 2, 3)
    col, row = toast_cell("Undo")  # the older toast is the upper one
    t.click(col * t.cell_w + 3, (row - 1) * t.cell_h + 8)
    wait(lambda: any(x[2] == "o=a" for x in tabs()))
    t.key("ctrl+shift+t")
    check("older Undo, then the newer: both back in their order", wait(lambda: tabs() == order, 20), (tabs(), order))

    # 7. A tab closed from a space that was then closed and reopened goes back into that space.
    t.key("ctrl+b"); t.key("shift+n"); time.sleep(0.6); t.type(f"{BASE}?y=1"); t.key("enter")
    wait(lambda: active()[2] == "y=1")
    new_tab(f"{BASE}?y=2")
    space2 = active()[0]
    t.key("ctrl+w"); wait(lambda: all(x[2] != "y=2" for x in tabs()))
    t.key("ctrl+b"); t.key("shift+d"); wait(lambda: all(x[0] != space2 for x in tabs()))
    t.key("ctrl+b"); t.key("u"); wait(lambda: (space2, 1, "y=1") in tabs())
    t.key("ctrl+b"); t.key("w"); time.sleep(0.3); t.key("1"); wait(lambda: active()[0] != space2)
    t.key("ctrl+shift+t")
    check("...the tab goes back into its reopened space, in its place", wait(lambda: (space2, 2, "y=2") in tabs()), tabs())

    # 8. Ctrl+Shift+T works with the address bar open (closing the last tab opens a blank one, editing its address).
    for _ in range(5):
        names = {x[0] for x in tabs()}
        if len(names) == 1: break
        t.key("ctrl+b"); t.key("shift+d"); wait(lambda: len({x[0] for x in tabs()}) < len(names))
    last = tabs()
    t.key("ctrl+b"); t.key("shift+d")
    check("closing the only space leaves a blank tab", wait(lambda: len(tabs()) == 1), tabs())
    t.key("ctrl+shift+t")
    check("Ctrl+Shift+T from the blank tab's address bar reopens the space", wait(lambda: len(tabs()) == len(last) + 1, 30), (tabs(), last))

    # 9. A split tab: its pane sizes, focus and zoom come back.
    new_tab(f"{BASE}?z=a")
    t.key("ctrl+b"); t.key("v"); time.sleep(0.6); t.type(f"{BASE}?z=b"); t.key("enter"); wait(lambda: active()[2] == "z=b")
    t.key("ctrl+b"); t.key("r")
    for _ in range(4): t.key("l"); time.sleep(0.1)
    t.key("escape"); time.sleep(0.8)
    width = lambda: ctl("eval", "innerWidth").get("value")
    w1 = width()
    t.key("ctrl+b"); t.key("z"); time.sleep(0.5)
    t.key("ctrl+b"); t.key("shift+x"); wait(lambda: all(x[2] != "z=b" for x in tabs()))
    t.key("ctrl+shift+t")
    zoomed = lambda: sorted((x["url"].split("?")[-1], x["visible"]) for x in ctl("tabs") if "z=" in x["url"])
    check("split: both panes back, zoomed on the focused one", wait(lambda: zoomed() == [("z=a", False), ("z=b", True)], 20), zoomed())
    t.key("ctrl+b"); t.key("z"); time.sleep(0.8)
    check("...with the pane sizes it had", wait(lambda: active()[2] == "z=b" and abs(width() - w1) <= 12, 5), (w1, width()))

    # 10. Several reopened at once (keys in one burst) each go back to their own place.
    for r in ("r=1", "r=2", "r=3"):
        new_tab(f"{BASE}?{r}")
    order = tabs()
    for r in ("r=3", "r=2", "r=1"):
        t.key("ctrl+w"); wait(lambda: all(x[2] != r for x in tabs()))
    t.write("\x1b[116;6u\x1b[116;6u\x1b[116;6u")
    check("three at once come back in their order", wait(lambda: tabs() == order, 30), (tabs(), order))
finally:
    t.close()
    srv.shutdown()
    shutil.rmtree(tmp, ignore_errors=True)

print(f"\n{len(failures)} failure(s)" if failures else "\nall passed")
sys.exit(1 if failures else 0)
