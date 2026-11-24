#!/usr/bin/env python3
"""Agent control against the real stack (termium + Helium).

A person's terminal (a PTY that answers like Ghostty) is attached to a
session while another process, with no terminal at all, drives it: with
`termium ctl` (tabs, open, snapshot, click, type, key, scroll, text, shot,
eval, wait, dialog, select, close) and as another DevTools client on the
`termium devtools` endpoint (new and closed tabs, viewport overrides).
Checks the page state, that the attached terminal showed the changes and
stayed attached, exit statuses, the endpoint being on loopback only,
`termium start` without a terminal, and `termium --skill`.

Usage: python3 tests/agent.py
"""
import json, os, re, shutil, signal, socket, subprocess, sys, tempfile, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
from drive import Term

failures = []
def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))
    if not cond:
        failures.append(name)

main = os.path.join(ROOT, "src", "main.ts")
tmp = tempfile.mkdtemp(prefix="tag-")
rt = os.path.join(tmp, "run"); os.makedirs(rt)
prof = os.path.join(tmp, "profile")
TMPD = os.path.join(tmp, "t"); os.makedirs(TMPD)
ENV = {"XDG_RUNTIME_DIR": rt, "TMPDIR": TMPD, "TERMIUM_NO_UPDATE_CHECK": "1",
       "XDG_DATA_HOME": os.path.join(tmp, "data"), "XDG_STATE_HOME": os.path.join(tmp, "state")}
sockdir = os.path.join(rt, "termium")

with socket.socket() as so:
    so.bind(("127.0.0.1", 0)); PORT = so.getsockname()[1]
srv = subprocess.Popen([shutil.which("python3") or sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1",
                        "--directory", os.path.join(ROOT, "tests", "fixtures")], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.5)
BASE = f"http://127.0.0.1:{PORT}"

def run(argv, timeout=90):
    # No terminal: stdin from /dev/null, and a new session (no controlling tty), as an agent's tool call.
    return subprocess.run(argv, cwd=ROOT, env=dict(os.environ, **ENV), stdin=subprocess.DEVNULL, capture_output=True, text=True,
                          timeout=timeout, start_new_session=True)

def cli(*args, timeout=90):
    return run(["bun", main, *args], timeout)

def ctl(*args, session="watch", timeout=90):
    return cli("ctl", "-s", session, *args, timeout=timeout)

def ctl_json(*args, session="watch"):
    r = ctl(*args, "--json", session=session)
    try:
        return json.loads(r.stdout)
    except ValueError:
        return {"_error": (r.returncode, r.stdout, r.stderr)}

def ext(*args):
    return run(["bun", os.path.join(ROOT, "tests/support/cdp-ext.ts"), *args], 60)

def page_value(expr, session="watch"):
    return ctl_json("eval", expr, session=session).get("value")

def server_pid(session):
    try:
        pid = int(open(os.path.join(sockdir, f"{session}.pid")).read())
        os.kill(pid, 0)
        return pid
    except (OSError, ValueError):
        return None

def still_running(t):
    try:
        return os.waitpid(t.pid, os.WNOHANG) == (0, 0)
    except ChildProcessError:
        return False

def ref(snapshot, role, name):
    m = re.search(rf'- {role} "{re.escape(name)}" \[(\d+:\d+)\]', snapshot)
    return m.group(1) if m else None

try:
    # --- the skill
    r = cli("--skill")
    skill = r.stdout
    fm = re.match(r"---\n(.*?)\n---\n", skill, re.S)
    fields = dict(l.split(": ", 1) for l in fm.group(1).splitlines() if ": " in l) if fm else {}
    check("--skill prints a SKILL.md with YAML frontmatter (name, description)",
          r.returncode == 0 and fields.get("name") == "termium" and len(fields.get("description", "")) > 40, skill[:200])
    known = {"tabs", "open", "select", "close", "snapshot", "text", "click", "type", "key", "scroll", "shot", "eval", "wait", "dialog"}
    used = set(re.findall(r"termium ctl (?:-s \S+ )?([a-z]+)", skill))
    check("the skill only names ctl commands that exist", used and used <= known, used - known)
    check("the skill covers start, devtools and the CDP clients",
          all(s in skill for s in ("termium start", "termium devtools", "--browser-url", "connectOverCDP", "browserURL")))

    # --- a person watching session "watch"
    h = Term(["bun", main, "-s", "watch", "--profile", prof, f"{BASE}/agent.html"], cwd=ROOT, env=ENV)
    check("the person's terminal shows the page", h.wait_frames(1, 40) and h.wait_text("Agent fixture", 20))
    h.wait_idle(0.8, 10)

    # --- the DevTools endpoint
    r = cli("devtools", "watch")
    m = re.fullmatch(r"http://127\.0\.0\.1:(\d+)\n", r.stdout)
    check("devtools prints http://127.0.0.1:PORT", r.returncode == 0 and m, (r.returncode, r.stdout, r.stderr))
    port = m.group(1) if m else "0"
    j = json.loads(cli("devtools", "-s", "watch", "--json").stdout or "{}")
    check("devtools --json gives name, pid, browserURL and webSocketDebuggerUrl",
          j.get("name") == "watch" and j.get("pid") == server_pid("watch") and j.get("browserURL") == f"http://127.0.0.1:{port}"
          and str(j.get("webSocketDebuggerUrl", "")).startswith(f"ws://127.0.0.1:{port}/devtools/browser/"), j)
    ss = subprocess.run(["ss", "-ltnH", f"sport = :{port}"], capture_output=True, text=True).stdout.split("\n")
    addrs = [l.split()[3] for l in ss if l.strip()]
    check("the endpoint listens on 127.0.0.1 only", addrs == [f"127.0.0.1:{port}"], addrs)

    # --- ctl: tabs, snapshot
    tabs = ctl_json("tabs")
    check("ctl tabs lists the page, focused and shown", isinstance(tabs, list) and len(tabs) == 1 and tabs[0]["active"]
          and tabs[0]["visible"] and tabs[0]["url"].endswith("/agent.html") and tabs[0]["title"] == "Agent fixture", tabs)
    first = tabs[0]["id"] if isinstance(tabs, list) and tabs else 1
    r = ctl("snapshot")
    snap = r.stdout
    name_id, colour_id = ref(snap, "textbox", "Name"), ref(snap, "combobox", "Colour")
    agree_id, greet_id, later_id = ref(snap, "checkbox", "Agree"), ref(snap, "button", "Greet"), ref(snap, "button", "Load later")
    check("snapshot gives elements with ids", r.returncode == 0 and all((name_id, colour_id, agree_id, greet_id, later_id))
          and snap.startswith(f"tab {first}: Agent fixture"), snap[:600])
    check("snapshot ids are stable", ctl("snapshot").stdout == snap)

    # --- acting, seen by the person, who stays attached
    f0 = h.frames
    r1 = ctl("type", name_id, "Ada Lovelace")
    r2 = ctl("type", colour_id, "Green")
    r3 = ctl("click", agree_id)
    r4 = ctl("click", greet_id)
    check("type, choose, click succeed", all(x.returncode == 0 for x in (r1, r2, r3, r4)), [(x.returncode, x.stderr) for x in (r1, r2, r3, r4)])
    r = ctl("wait", "text", "Hello, Ada Lovelace (g)", "--timeout", "10")
    check("wait text sees the result", r.returncode == 0, (r.returncode, r.stdout, r.stderr))
    st = page_value("[document.getElementById('name').value, document.getElementById('color').value, document.getElementById('agree').checked, document.getElementById('out').textContent]")
    check("the page state changed", st == ["Ada Lovelace", "g", True, "Hello, Ada Lovelace (g)"], st)
    check("the person's pane showed the changes (new frames)", h.wait_for(lambda: h.frames > f0, 5), (f0, h.frames))
    check("the person's terminal stayed attached", still_running(h) and "attached" in cli("ls").stdout)
    t = ctl("text")
    check("text gives the readable text", t.returncode == 0 and "Hello, Ada Lovelace (g)" in t.stdout and "Agent fixture" in t.stdout, t.stdout[:300])
    r = ctl("type", name_id, "Grace", "--append")
    check("type --append adds to the field", page_value("document.getElementById('name').value") == "Ada LovelaceGrace", r.stderr)
    ctl("click", name_id); r = ctl("key", "ctrl+a", "Backspace")
    check("key presses keys (ctrl+a, Backspace)", r.returncode == 0 and page_value("document.getElementById('name').value") == "", r.stderr)
    ctl("click", later_id)
    r = ctl("wait", "selector", "#late", "--timeout", "10")
    check("wait selector waits for an element that comes later", r.returncode == 0, (r.returncode, r.stderr))
    r = ctl("wait", "selector", "#late", "--gone", "--timeout", "1")
    check("wait --gone times out (exit 4) while it's still there", r.returncode == 4, (r.returncode, r.stderr))
    r = ctl("scroll", "down", "600")
    check("scroll scrolls the page", r.returncode == 0 and (page_value("scrollY") or 0) > 300, (r.stdout, r.stderr))
    r = ctl("eval", "({a: 1, b: [document.title]})")
    check("eval prints JSON", r.returncode == 0 and json.loads(r.stdout) == {"a": 1, "b": ["Agent fixture"]}, r.stdout)
    r = ctl("eval", "new Promise(r => setTimeout(() => r(42), 100))", "--json")
    check("eval awaits promises", json.loads(r.stdout or "{}").get("value") == 42, r.stdout)
    shot = os.path.join(tmp, "shot.png")
    r = ctl("shot", "-o", shot)
    from PIL import Image
    size = page_value("[innerWidth * devicePixelRatio, innerHeight * devicePixelRatio]")
    ok = r.returncode == 0 and r.stdout.strip() == shot and os.path.exists(shot)
    check("shot saves a PNG of the page", ok and list(Image.open(shot).size) == [round(x) for x in size], (r.stdout, r.stderr, size))
    check("the person's terminal still attached after the screenshot", still_running(h))

    # --- tabs: open, select, close (the person sees each)
    r = ctl("open", f"{BASE}/page.html", "--new-tab", "--json")
    new = json.loads(r.stdout or "{}")
    check("open --new-tab opens and loads a tab", r.returncode == 0 and new.get("url", "").endswith("/page.html") and new.get("active"), (r.stdout, r.stderr))
    check("...which shows in the person's tab bar", h.wait_for(lambda: " 2 " in h.line(1), 10), h.line(1))
    r = ctl("select", str(first))
    check("select shows a tab", r.returncode == 0 and [t["active"] for t in ctl_json("tabs")] == [True, False])
    r = ctl("open", f"{BASE}/agent.html#again", "--tab", str(new.get("id", 0)))
    check("open --tab navigates that tab", r.returncode == 0 and ctl_json("tabs")[1]["url"].endswith("#again"), (r.stdout, r.stderr))
    r = ctl("close", str(new.get("id", 0)))
    check("close closes a tab", r.returncode == 0 and len(ctl_json("tabs")) == 1, (r.stdout, r.stderr))
    check("...and it leaves the person's tab bar", h.wait_for(lambda: " 2 " not in h.line(1), 10), h.line(1))

    # --- dialogs
    ctl("eval", "setTimeout(() => window.answer = confirm('Sure?'), 0)")
    time.sleep(0.5)
    r = ctl("text")
    check("a command on a page showing a dialog says so (exit 1)", r.returncode == 1 and "dialog" in r.stderr, (r.returncode, r.stderr))
    r = ctl("dialog", "accept")
    check("dialog accept answers it", r.returncode == 0 and page_value("window.answer") is True, (r.stdout, r.stderr))

    # --- errors and exit statuses
    r = ctl("click", f"{first}:999999")
    check("an element that's gone: exit 1, says to snapshot again", r.returncode == 1 and "snapshot" in r.stderr, (r.returncode, r.stderr))
    r = ctl("click", "nonsense")
    check("a malformed element id: exit 2", r.returncode == 2, (r.returncode, r.stderr))
    r = ctl("snapshot", "99")
    check("no such tab: exit 1", r.returncode == 1 and "no tab 99" in r.stderr, (r.returncode, r.stderr))
    r = ctl("tabs", session="nosuch")
    check("no such session: exit 3", r.returncode == 3 and "termium start" in r.stderr, (r.returncode, r.stderr))
    r = ctl("wait", "text", "never there", "--timeout", "1")
    check("a wait that times out: exit 4", r.returncode == 4, (r.returncode, r.stderr))
    r = ctl("frobnicate")
    check("an unknown command: exit 2", r.returncode == 2, (r.returncode, r.stderr))
    r = ctl("eval", "nope.nope")
    check("a script error: exit 1 with the message", r.returncode == 1 and "ReferenceError" in r.stderr, (r.returncode, r.stderr))

    # --- another DevTools client on the endpoint
    url = f"http://127.0.0.1:{port}"
    r = ext("create", url, f"{BASE}/page.html?ext=1")
    target = r.stdout.strip()
    check("a tab another client creates shows in termium", h.wait_for(lambda: any("ext=1" in t["url"] for t in ctl_json("tabs")), 10)
          and h.wait_for(lambda: " 2 " in h.line(1), 10), (r.stderr, h.line(1)))
    r = ext("close", url, target)
    check("a tab it closes goes away cleanly", h.wait_for(lambda: len(ctl_json("tabs")) == 1 and " 2 " not in h.line(1), 10), h.line(1))
    ctl("select", str(first))
    before = page_value("[innerWidth, innerHeight]")
    f1 = h.frames
    r = ext("viewport", url, "agent.html", "500", "400", "3")
    check("another client can change the viewport", r.returncode == 0 and json.loads(r.stdout or "[]") == [500, 400], (r.stdout, r.stderr))
    check("...and termium's size comes back once it lets go",
          h.wait_for(lambda: page_value("[innerWidth, innerHeight]") == before, 10), (before, page_value("[innerWidth, innerHeight]")))
    check("termium kept drawing meanwhile", h.frames > f1)
    # The person's own input still works.
    box = page_value("(() => { const r = document.getElementById('name').getBoundingClientRect(); return [r.x + 10, r.y + r.height / 2]; })()")
    ctl("scroll", "up", "5000")
    box = page_value("(() => { const r = document.getElementById('name').getBoundingClientRect(); return [r.x + 10, r.y + r.height / 2]; })()")
    h.click(220 + int(box[0]), 40 + int(box[1])); time.sleep(0.3)
    h.type("typed by hand"); time.sleep(0.5)
    check("the person's typing still reaches the page", page_value("document.getElementById('name').value") == "typed by hand",
          page_value("document.getElementById('name').value"))
    check("the person's terminal stayed attached throughout", still_running(h))

    # --- a session started without a terminal
    r = cli("start", "-s", "bg", "--incognito", f"{BASE}/agent.html")
    check("start starts a session without a terminal", r.returncode == 0 and 'started session "bg"' in r.stdout and "127.0.0.1" in r.stdout,
          (r.returncode, r.stdout, r.stderr))
    tabs = ctl_json("tabs", session="bg")
    check("...with its page open (not shown: nothing is attached)", isinstance(tabs, list) and len(tabs) == 1
          and tabs[0]["url"].endswith("/agent.html") and not tabs[0]["visible"], tabs)
    check("...at a desktop size", page_value("[innerWidth, innerHeight]", session="bg") == [1280, 800])
    r = cli("start", "-s", "bg")
    check("start on a running session says so and exits 0", r.returncode == 0 and "already running" in r.stdout, (r.returncode, r.stdout))
    r = cli("ls")
    check("ls shows it detached", re.search(r"^bg\s+\d+\s+detached", r.stdout, re.M), r.stdout)
    time.sleep(31)
    check("it isn't ended for want of a terminal", server_pid("bg") is not None)
    r = cli("kill", "bg")
    check("kill ends it", r.returncode == 0 and server_pid("bg") is None, (r.returncode, r.stderr))
finally:
    for t in [x for x in globals().values() if isinstance(x, Term)]:
        if t.alive:
            try:
                t.close()
            except Exception:
                pass
    for name in ("watch", "bg"):
        pid = server_pid(name)
        if pid:
            os.kill(pid, signal.SIGTERM)
    time.sleep(2)
    srv.terminate()
    shutil.rmtree(tmp, ignore_errors=True)

print("FAILED: " + ", ".join(failures) if failures else "ALL PASSED")
sys.exit(1 if failures else 0)
