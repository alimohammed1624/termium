#!/usr/bin/env python3
"""The agent-driven mark, against the real stack (termium + Helium).

While `termium ctl` acts on a tab, a "●" marks that tab (in the tab bar)
and its space (in the sidebar), including a background tab and a tab in
a space the person isn't on; it clears a few seconds after the agent
stops. Reading commands (snapshot, text) don't mark anything.

Usage: python3 tests/agent-indicator.py
"""
import json, os, re, shutil, socket, subprocess, sys, tempfile, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
from drive import Term

failures = []
def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))
    if not cond:
        failures.append(name)

main = os.path.join(ROOT, "src", "main.ts")
tmp = tempfile.mkdtemp(prefix="termium-indicator-")
rt = os.path.join(tmp, "run"); os.makedirs(rt)
TMPD = os.path.join(tmp, "t"); os.makedirs(TMPD)
ENV = {"XDG_RUNTIME_DIR": rt, "TMPDIR": TMPD, "TERMIUM_NO_UPDATE_CHECK": "1",
       "XDG_DATA_HOME": os.path.join(tmp, "data"), "XDG_STATE_HOME": os.path.join(tmp, "state")}
SESSION = os.environ.get("TERMIUM_TEST_SESSION", "indicator")

with socket.socket() as so:
    so.bind(("127.0.0.1", 0)); PORT = so.getsockname()[1]
srv = subprocess.Popen([shutil.which("python3") or sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1",
                        "--directory", os.path.join(ROOT, "tests", "fixtures")], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.5)
BASE = f"http://127.0.0.1:{PORT}"

def ctl(*args):
    return subprocess.run(["bun", main, "ctl", "-s", SESSION, *args], cwd=ROOT, env=dict(os.environ, **ENV), stdin=subprocess.DEVNULL,
                          capture_output=True, text=True, timeout=90, start_new_session=True)

def ref(snapshot, role, name):
    m = re.search(rf'- {role} "{re.escape(name)}" \[(\d+:\d+@\d+)\]', snapshot)
    return m.group(1) if m else None

h = None
try:
    h = Term(["bun", main, "-s", SESSION, "--incognito", f"{BASE}/agent.html"], cwd=ROOT, env=ENV)
    check("the person's terminal shows the page", h.wait_frames(1, 40) and h.wait_text("Agent fixture", 20))
    h.wait_idle(0.8, 10)

    tab_bar = lambda: h.line(1)
    space_row = lambda n: next((l for l in h.text().split("\n") if re.match(rf"^ [●▸ ] {n} ", l)), "")
    space_dot = lambda n: re.search(r"● \d+\s*$", space_row(n)[:22]) is not None
    tab_dot = lambda n: re.search(rf"(^|[│ ]) {n} ● ", tab_bar()) is not None

    check("nothing is marked before an agent acts", not tab_dot(1) and not space_dot(1), (tab_bar(), space_row(1)))

    # --- a background tab in the person's space
    r = ctl("open", f"{BASE}/page.html", "--new-tab", "--background", "--json")
    bg = json.loads(r.stdout or "{}").get("id")
    check("ctl opens a background tab", r.returncode == 0 and bg and h.wait_text("termium test page", 10), (r.returncode, r.stdout, r.stderr))
    check("opening it marks it (tab 2) and its space", h.wait_for(lambda: tab_dot(2) and space_dot(1), 3), (tab_bar(), space_row(1)))
    check("the mark clears soon after the agent stops", h.wait_for(lambda: not tab_dot(2) and not space_dot(1), 6), (tab_bar(), space_row(1)))

    snap = ctl("snapshot", str(bg)).stdout
    time.sleep(0.5)
    check("a snapshot (reading) marks nothing", not tab_dot(2) and not space_dot(1), (tab_bar(), space_row(1)))
    btn, inp = ref(snap, "button", "Click me"), ref(snap, "textbox", "type here")
    r = ctl("click", btn)
    check("ctl clicks in the background tab", r.returncode == 0, (r.returncode, r.stdout, r.stderr))
    check("clicking marks the background tab and its space", h.wait_for(lambda: tab_dot(2) and space_dot(1), 3), (tab_bar(), space_row(1)))
    check("the foreground tab isn't marked", not tab_dot(1), tab_bar())
    r = ctl("type", inp, "hello")
    check("ctl types in the background tab", r.returncode == 0, (r.returncode, r.stdout, r.stderr))
    check("still marked while it types", tab_dot(2) and space_dot(1), (tab_bar(), space_row(1)))
    check("the mark clears after typing ends", h.wait_for(lambda: not tab_dot(2) and not space_dot(1), 6), (tab_bar(), space_row(1)))

    # --- a click that opens a dialog: both its "!" and the agent's "●"
    r = ctl("click", ref(snap, "button", "Alert"))
    check("ctl clicks a button that alerts", r.returncode == 0, (r.returncode, r.stdout, r.stderr))
    check("the tab shows the dialog and the agent together", h.wait_for(lambda: re.search(r" 2 !● ", tab_bar()) and space_dot(1), 3), tab_bar())
    check("then only the dialog", h.wait_for(lambda: re.search(r" 2 ! ", tab_bar()) and not space_dot(1), 6), tab_bar())
    r = ctl("dialog", "dismiss")
    check("the agent dismisses it", r.returncode == 0 and h.wait_for(lambda: not re.search(r" 2 !", tab_bar()), 5), (r.stdout, r.stderr, tab_bar()))

    # --- a tab in a space the person isn't on
    h.key("ctrl+b"); h.key("shift+n"); time.sleep(0.8); h.key("escape"); time.sleep(0.5)
    check("the person moved to a new space", space_row(2).startswith(" ● 2"), space_row(2))
    r = ctl("type", inp, " again", "--append")
    check("ctl types in a tab of the other space", r.returncode == 0, (r.returncode, r.stdout, r.stderr))
    check("that space is marked, the person's isn't", h.wait_for(lambda: space_dot(1), 3) and not space_dot(2), (space_row(1), space_row(2)))
    check("and the mark clears", h.wait_for(lambda: not space_dot(1), 6), space_row(1))
    val = json.loads(ctl("eval", "document.getElementById('inp').value", str(bg), "--json").stdout or "{}").get("value")
    check("the agent's typing landed", val == "hello again", val)

    # --- a title that starts with "●" isn't taken for the agent's mark
    def fg_at(text):
        line = tab_bar(); col = line.find(text)
        with h.lock:
            return str(h.screen.buffer[0][col].fg).lower() if col >= 0 else None
    ctl("select", "1")
    check("the agent's own dot is in the accent colour", h.wait_for(lambda: fg_at("● Agent") == "cba6f7", 3), (tab_bar(), fg_at("● Agent")))
    h.wait_for(lambda: "Agent fixture" in tab_bar() and not tab_dot(1), 6)
    ctl("eval", "document.title = '● not an agent'", "1")
    h.wait_text("● not an agent", 5); time.sleep(0.5)
    check("an idle tab's own ● keeps the title's colour", fg_at("● not") not in (None, "cba6f7"), (tab_bar(), fg_at("● not")))

    ctl("eval", "document.title = 'Agent fixture'", "1")

    # --- a stale id is refused before anything is done: nothing marked
    old_btn = btn
    ctl("eval", "location.reload()", str(bg)); time.sleep(1.5)
    r = ctl("click", old_btn)
    check("a stale id is refused", r.returncode != 0 and "stale id" in r.stderr, (r.returncode, r.stdout, r.stderr))
    time.sleep(0.4)
    check("and doesn't mark the tab", not tab_dot(2) and not space_dot(1), (tab_bar(), space_row(1)))

    # --- input still being handled after the command's time is up keeps the mark
    ctl("eval", "document.body.insertAdjacentHTML('afterbegin', `<button onclick=\"const e = Date.now() + 6000; while (Date.now() < e); window.slowDone = 1\">Very slow</button>`)", "1")
    slow = ref(ctl("snapshot", "1").stdout, "button", "Very slow")
    time.sleep(3.5)  # (the snapshot is reading, but earlier marks on tab 1 must be gone)
    t0 = time.time()
    r = ctl("click", slow, "--timeout", "1")
    returned = time.time() - t0
    check("the click returns before the page has handled it", returned < 4, (returned, r.returncode, r.stderr))
    time.sleep(max(0, 4.5 - returned))
    check("the tab is still marked while the page handles it (4.5 s in)", tab_dot(1) and space_dot(1), (tab_bar(), space_row(1)))
    check("the mark clears a few seconds after the page is done", h.wait_for(lambda: not tab_dot(1) and not space_dot(1), 8), (tab_bar(), space_row(1)))
finally:
    if h:
        h.stop_server(SESSION)
        h.close()
    srv.terminate()
    shutil.rmtree(tmp, ignore_errors=True)

print(f"\n{'FAILED: ' + ', '.join(failures) if failures else 'all passed'}")
sys.exit(1 if failures else 0)
