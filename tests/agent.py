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
import json, os, re, shutil, signal, socket, stat, subprocess, sys, tempfile, time

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

def wait_until(pred, timeout):
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(0.3)
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
    check("help lists every exit status (ctl's 5, check-update's 2)", "5 partly done" in cli("ctl", "--help").stdout and "2: bad usage" in cli("--help").stdout)
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

    # --- typing only ever goes where it was asked to, and never shows what was typed
    snap = ctl("snapshot").stdout
    off_id, pw_id = ref(snap, "textbox", "Locked"), ref(snap, "textbox", "Secret")
    ctl("type", name_id, "first field")
    r = ctl("type", off_id, "xyz")
    check("type into a disabled field: exit 1, nothing typed anywhere",
          r.returncode == 1 and "disabled" in r.stderr and page_value("[document.getElementById('name').value, document.getElementById('off').value]") == ["first field", ""],
          (r.returncode, r.stderr, page_value("[document.getElementById('name').value, document.getElementById('off').value]")))
    r = ctl("type", pw_id, "EXAMPLE-SECRET-1")
    shown = h.wait_for(lambda: "password field" in h.line(2), 5)
    log = open(os.path.join(tmp, "state", "termium", "termium.log")).read()
    check("type into a password field: typed, but the text is shown nowhere (status, output, log)",
          r.returncode == 0 and page_value("document.getElementById('pw').value") == "EXAMPLE-SECRET-1" and shown
          and "EXAMPLE" not in h.text() and "EXAMPLE" not in r.stdout + r.stderr and "EXAMPLE" not in log, (r.stdout, h.line(2)))
    ctl("type", name_id, "")  # (empty again for what follows)
    r = ctl("open", f"{BASE}/agent.html#termium-heading", "--timeout", "10")
    check("open a page with a real #termium-... fragment: loads, no timeout", r.returncode == 0, (r.returncode, r.stderr))
    r = ctl("wait", "text", "Agent fixture", "--timeout", "0.1")
    check("wait with a tiny timeout still looks once (the text is there: exit 0)", r.returncode == 0, (r.returncode, r.stderr))
    r = ctl("wait", "load", "--timeout", "0.1")
    check("wait load with a tiny timeout still looks once", r.returncode == 0, (r.returncode, r.stderr))

    # --- select never throws away what the person is typing in the address bar
    r = ctl_json("open", f"{BASE}/page.html", "--new-tab", "--background")
    second = r.get("id")
    h.key("ctrl+l"); h.key("ctrl+a"); h.type("half-typed"); time.sleep(0.5)
    r = ctl("select", str(second), "--timeout", "2")
    check("select while the person edits the address: waits, then gives up (exit 4), their edit intact",
          r.returncode == 4 and "busy" in r.stderr and "half-typed" in h.line(2) and [t["active"] for t in ctl_json("tabs")] == [True, False],
          (r.returncode, r.stderr, h.line(2)))
    p = subprocess.Popen(["bun", main, "ctl", "-s", "watch", "select", str(second), "--timeout", "15", "--json"], cwd=ROOT,
                         env=dict(os.environ, **ENV), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    time.sleep(1.5)
    h.key("escape")
    out, err = p.communicate(timeout=30)
    check("...and once they're done, the waiting select switches", p.returncode == 0 and json.loads(out or "{}").get("waitedForPerson", 0) > 500
          and [t["active"] for t in ctl_json("tabs")] == [False, True], (p.returncode, out, err))
    ctl("close", str(second)); ctl("select", str(first))

    # --- a new tab never takes the person's address-bar draft or keystrokes
    h.key("ctrl+l"); h.key("ctrl+a"); h.type("draft"); time.sleep(0.3)
    r = ctl_json("open", f"{BASE}/page.html?bg=1", "--new-tab")
    h.type("X"); time.sleep(0.5)
    rp = ctl("open", f"{BASE}/page.html?bgplain=1", "--new-tab")
    check("...and the plain output says so too", "opened in the background" in rp.stdout, rp.stdout)
    for t in ctl_json("tabs"):
        if "bgplain" in t["url"]:
            ctl("close", str(t["id"]), "--force")
    check("open --new-tab while the person edits the address: opened in the background, said so; their draft intact",
          "background" in r and "draftX" in h.line(2) and [t["active"] for t in ctl_json("tabs")] == [True, False], (r, h.line(2)))
    h.key("escape"); ctl("close", str(r.get("id"))); time.sleep(2)
    ctl("eval", "scrollTo(0, 0)"); time.sleep(0.5)
    box = page_value("(() => { const r = document.getElementById('city').getBoundingClientRect(); return [r.x + 10, r.y + r.height / 2]; })()")
    h.click(220 + int(box[0]), 40 + int(box[1])); time.sleep(0.3)
    opener = subprocess.Popen(["bun", main, "ctl", "-s", "watch", "open", f"{BASE}/agent.html?auto=1", "--new-tab", "--json"], cwd=ROOT,
                              env=dict(os.environ, **ENV), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    for ch in "abcdef":
        h.type(ch); time.sleep(0.25)
    out, _ = opener.communicate(timeout=60)
    time.sleep(0.5)
    check("the person typing into a page isn't interrupted by a new tab (it opens behind)",
          page_value("document.getElementById('city').value") == "abcdef" and [t["active"] for t in ctl_json("tabs")][0],
          (page_value("document.getElementById('city').value"), out[-200:]))
    ctl("close", str(json.loads(out or "{}").get("id"))); time.sleep(2)
    ctl("type", name_id, ""); ctl("type", ref(ctl("snapshot").stdout, "textbox", "City"), "")

    # --- agents' typing never interleaves (acting commands run one at a time)
    snap = ctl("snapshot").stdout
    city_id = ref(snap, "textbox", "City")
    mixed = []
    for _ in range(4):
        ps = [subprocess.Popen(["bun", main, "ctl", "-s", "watch", "type", fid, txt], cwd=ROOT, env=dict(os.environ, **ENV), stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for fid, txt in ((name_id, "AAAAAAAA"), (city_id, "BBBBBBBB"))]
        for p_ in ps:
            p_.communicate(timeout=60)
        mixed.append(page_value("[document.getElementById('name').value, document.getElementById('city').value]"))
    check("two agents typing into two fields at once: each field gets its own text, every time",
          all(m == ["AAAAAAAA", "BBBBBBBB"] for m in mixed), mixed)

    # --- what can't be typed into isn't changed; labels never show what was typed; shadow DOM
    snap = ctl("snapshot").stdout
    offsel_id, notes_id, shadow_id = ref(snap, "combobox", "Frozen list"), ref(snap, "textbox", "Notes"), ref(snap, "textbox", "Shadow field")
    r = ctl("type", offsel_id, "Banana")
    check("type into a disabled select: exit 1, unchanged", r.returncode == 1 and "disabled" in r.stderr
          and page_value("document.getElementById('offsel').value") == "a", (r.returncode, r.stderr))
    r = ctl("type", notes_id, "sample-draft")
    shown = h.wait_for(lambda: "typed into" in h.line(2), 5)
    check("type into a contenteditable: typed, and the status names it without its text",
          r.returncode == 0 and page_value("document.getElementById('ed').innerText.trim()") == "sample-draft" and shown and "sample-draft" not in h.text(),
          (r.returncode, r.stderr, h.line(2)))
    r = ctl("type", shadow_id, "in the shadow")
    check("type into an input inside a shadow root works", r.returncode == 0 and
          page_value("document.getElementById('host').shadowRoot.getElementById('sin').value") == "in the shadow", (r.returncode, r.stderr))

    # --- a command that started runs to its end or stops itself, saying how far it got; nothing goes on after the reply
    snap = ctl("snapshot").stdout
    city_id = ref(snap, "textbox", "City")
    ctl("type", city_id, ""); ctl("click", city_id); time.sleep(1.6)
    r = ctl("key", *(["x"] * 3000), "--timeout", "0.15")
    m = re.search(r"pressed (\d+) of 3000 keys", r.stderr)
    n_now = len(page_value("document.getElementById('city').value") or "")
    time.sleep(2)
    n_later = len(page_value("document.getElementById('city').value") or "")
    check("key with a timeout too short for 3000 keys: stops, says how many it pressed, and none land after",
          r.returncode == 4 and m and int(m.group(1)) == n_now == n_later and 0 < n_later < 3000, (r.returncode, r.stderr[:200], n_now, n_later))
    ctl("type", city_id, ""); time.sleep(1.6)
    r = ctl("type", city_id, "late text", "--timeout", "0.05")
    v_now = page_value("document.getElementById('city').value"); time.sleep(2)
    v_later = page_value("document.getElementById('city').value")
    check("type with a tiny timeout: either typed (exit 0) or nothing typed (exit 4), and nothing changes after",
          v_now == v_later and ((r.returncode == 0 and v_later == "late text") or (r.returncode == 4 and "nothing was typed" in r.stderr and v_later == "")),
          (r.returncode, r.stderr, v_now, v_later))
    ctl("type", city_id, "")
    # The page moves focus away: as the field gets it, or a moment later.
    jl, jn = ref(snap, "textbox", "Jumpy later"), ref(snap, "textbox", "Jumpy now")
    r = ctl("type", jl, "TWELVE CHARS")
    check("type into a field whose page moves focus a moment later: the text still goes into it (and says so truthfully)",
          r.returncode == 0 and page_value("[document.getElementById('jumpy').value, document.getElementById('city').value]") == ["TWELVE CHARS", ""],
          (r.returncode, r.stderr, page_value("[document.getElementById('jumpy').value, document.getElementById('city').value]")))
    r = ctl("type", jn, "NOT HERE")
    check("type into a field that hands focus elsewhere at once: exit 1 naming why, nothing typed anywhere",
          r.returncode == 1 and page_value("[document.getElementById('jumpnow').value, document.getElementById('city').value]") == ["", ""],
          (r.returncode, r.stderr, page_value("[document.getElementById('jumpnow').value, document.getElementById('city').value]")))

    # --- type succeeds only with exactly the text asked for; --submit only the target's own form, only if all's well
    snap = ctl("snapshot").stdout
    short_id, mover_id, alerter_id = ref(snap, "textbox", "Short field"), ref(snap, "textbox", "Mover field"), ref(snap, "button", "Alert me")
    r = ctl("type", short_id, "London", "--submit")
    check("type into a maxlength=4 field: exit 1 saying it was cut, not submitted",
          r.returncode == 1 and "cut it to 4 of 6" in r.stderr and page_value("window.f2sub === undefined") is True, (r.returncode, r.stderr))
    ctl("type", short_id, "same")
    r = ctl("type", short_id, "same")
    check("type the value a field already holds: success", r.returncode == 0, (r.returncode, r.stderr))
    r = ctl("type", mover_id, "x", "--submit")
    check("--submit after the page moved focus to another form: not submitted (either form), exit 1",
          r.returncode == 1 and "moved focus" in r.stderr and page_value("[window.f3sub, window.f4sub]") == [None, None], (r.returncode, r.stderr, page_value("[window.f3sub, window.f4sub]")))
    ctl("type", short_id, "ok")
    r = ctl("type", short_id, "ok", "--submit")
    check("--submit with the text right and focus kept: its own form is submitted", r.returncode == 0 and page_value("window.f2sub") == "ok", (r.returncode, r.stderr))
    # A click that opens an alert: back at once with the dialog; the queue isn't held.
    t0 = time.time()
    r = ctl_json("click", alerter_id, "--timeout", "5")
    took = time.time() - t0
    r2 = ctl("open", f"{BASE}/page.html?after-alert=1", "--new-tab", "--background", "--timeout", "10")
    check(f"a click that opens alert() returns at once reporting it ({took:.1f}s), and the next command runs",
          took < 3 and (r.get("dialog") or {}).get("message") == "clicked" and r2.returncode == 0, (took, r, r2.returncode, r2.stderr))
    ctl("dialog", "accept")
    for t in ctl_json("tabs"):
        if "after-alert" in t["url"]:
            ctl("close", str(t["id"]), "--force")
    # scroll waits while the person is busy (help open here) on their tab; scrolling to an element too.
    ctl("eval", "scrollTo(0, 0)")
    bottom_id = ref(ctl("snapshot").stdout, "heading", "A heading whose id starts with termium-")
    h.key("ctrl+b"); h.key("question"); time.sleep(0.5)
    r = ctl("scroll", "down", "260", "--timeout", "1")
    r2 = ctl("scroll", bottom_id, "down", "--timeout", "1")
    check("scroll (and scroll to an element) while the person reads help on that tab: waits, then exit 4, not scrolled at all",
          r.returncode == 4 and r2.returncode == 4 and page_value("scrollY") == 0, (r.returncode, r2.returncode, r2.stderr, page_value("scrollY")))
    h.key("escape"); time.sleep(1.6)
    # A select with --submit: the choice, then its own form.
    snap = ctl("snapshot").stdout
    r = ctl("type", ref(snap, "combobox", "Pick one"), "Bee", "--submit")
    check("type into a select with --submit: chosen, and its form submitted", r.returncode == 0 and page_value("window.f5sub") == "b", (r.returncode, r.stderr))
    # An element something covers: not clicked (nor the cover), saying what covers it.
    r = ctl("click", ref(snap, "button", "Under button"))
    check("click on a covered element: exit 1 naming the cover, nothing clicked",
          r.returncode == 1 and "covered by div#cover" in r.stderr and page_value("[window.underClicked, window.coverClicked]") == [None, None],
          (r.returncode, r.stderr, page_value("[window.underClicked, window.coverClicked]")))

    # --- ids only for the document their snapshot saw
    st = ctl_json("open", f"{BASE}/agent.html?stale=1", "--new-tab", "--background").get("id")
    old_greet = ref(ctl("snapshot", str(st)).stdout, "button", "Greet")
    ctl("open", f"http://localhost:{PORT}/agent.html?stale=2", "--tab", str(st))
    r = ctl("click", old_greet)
    out_now = ctl_json("eval", "document.getElementById('out').textContent", "--tab", str(st)).get("value")
    check("an id from before a navigation is stale (exit 1), and nothing on the new page is clicked",
          r.returncode == 1 and "stale" in r.stderr and out_now != "Hello,  (r)", (r.returncode, r.stderr, out_now))
    new_greet = ref(ctl("snapshot", str(st)).stdout, "button", "Greet")
    check("...a new snapshot's id works", ctl("click", new_greet).returncode == 0)
    # Frames: a cover over a frame is seen from the top; a frame's own button works.
    fsnap = ctl("snapshot", str(st)).stdout
    r = ctl("click", ref(fsnap, "button", "Covered frame button"))
    fv = lambda: ctl_json("eval", "[window.frameBtn, window.frameCover, window.frameBtn2]", "--tab", str(st)).get("value")
    check("click on a frame's button under a page overlay: exit 1 naming the cover, nothing clicked",
          r.returncode == 1 and "div#frcover" in r.stderr and fv() == [None, None, None], (r.returncode, r.stderr, fv()))
    r = ctl("click", ref(fsnap, "button", "Open frame button"))
    check("...an uncovered frame's button is clicked", r.returncode == 0 and fv() == [None, None, 1], (r.returncode, r.stderr, fv()))
    # A page slow to take the pointer: the click stops at its deadline, not clicking later.
    r = ctl("click", ref(fsnap, "button", "Slow to hover"), "--timeout", "0.25")
    time.sleep(2.5)
    check("a click whose page is slow to take the pointer: exit 4 at its deadline, never clicked after",
          r.returncode == 4 and ctl_json("eval", "window.slowClicked", "--tab", str(st)).get("value") is None, (r.returncode, r.stderr))
    # A submit whose handler alerts: back at once with the dialog, the queue moves on.
    t0 = time.time()
    r = ctl_json("type", ref(fsnap, "textbox", "Validated field"), "x", "--submit", "--timeout", "5")
    took = time.time() - t0
    # (Another site: a page of the same site shares the renderer the alert holds, as in any Chromium.)
    r2 = ctl("open", f"http://localhost:{PORT}/page.html?after-submit=1", "--new-tab", "--background", "--timeout", "10")
    check(f"type --submit whose form alerts: back at once reporting it ({took:.1f}s), the next command runs",
          took < 3 and (r.get("dialog") or {}).get("message") == "check it" and r2.returncode == 0, (took, r, r2.returncode))
    ctl("dialog", "accept", "--tab", str(st))
    # A disabled option isn't chosen.
    r = ctl("type", ref(fsnap, "combobox", "Grouped list"), "Zed")
    check("type a disabled option (disabled group): exit 1, choice unchanged",
          r.returncode == 1 and "disabled" in r.stderr and ctl_json("eval", "document.getElementById('grp').value", "--tab", str(st)).get("value") == "a",
          (r.returncode, r.stderr))
    for t in ctl_json("tabs"):
        if t["id"] != first:
            ctl("close", str(t["id"]), "--force")

    # --- a queued command whose time runs out is answered at once, and never runs
    hang = socket.socket(); hang.bind(("127.0.0.1", 0)); hang.listen(8)  # accepts nothing: a page that never loads
    HANG = f"http://127.0.0.1:{hang.getsockname()[1]}/never"
    victim = ctl_json("open", f"{BASE}/page.html?victim=1", "--new-tab", "--background").get("id")
    staller = subprocess.Popen(["bun", main, "ctl", "-s", "watch", "open", HANG, "--new-tab", "--background", "--timeout", "8"], cwd=ROOT,
                               env=dict(os.environ, **ENV), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    time.sleep(1.5)
    t0 = time.time()
    r = ctl("close", str(victim), "--timeout", "0.3")
    took = time.time() - t0
    staller.communicate(timeout=60)
    time.sleep(1.5)
    check(f"a close queued behind a stalled open times out at once ({took:.1f}s, exit 4) and never runs later",
          r.returncode == 4 and took < 3 and any(t["id"] == victim for t in ctl_json("tabs")), (r.returncode, r.stderr, took))
    for t in ctl_json("tabs"):
        if t["id"] != first:
            ctl("close", str(t["id"]), "--force")
    hang.close()

    # --- close never asks the person: unsaved changes go back to the agent
    bgt = ctl_json("open", f"{BASE}/page.html?unsaved=1", "--new-tab", "--background").get("id")
    ctl("eval", "window.onbeforeunload = (e) => { e.preventDefault(); return ''; }; 1", "--tab", str(bgt))
    h.key("ctrl+l"); h.key("ctrl+a"); h.type("my draft"); time.sleep(0.3)
    r = ctl("close", str(bgt))
    time.sleep(1)
    check("close of a background tab with unsaved changes: not closed (exit 1, says --force), the person's tab and draft untouched",
          r.returncode == 1 and "--force" in r.stderr and "my draft" in h.line(2) and "Leave this page" not in h.text()
          and any(t["id"] == bgt for t in ctl_json("tabs")) and [t["active"] for t in ctl_json("tabs")][0], (r.returncode, r.stderr, h.line(2)))
    r = ctl("close", str(bgt), "--force")
    time.sleep(0.5)
    check("close --force discards them, still without asking the person", r.returncode == 0 and len(ctl_json("tabs")) == 1
          and "my draft" in h.line(2) and "Leave this page" not in h.text(), (r.returncode, r.stderr, h.line(2)))
    h.key("escape"); time.sleep(1.6)

    # --- a tab another DevTools client opens while the person edits the address: behind, draft intact
    h.key("ctrl+l"); h.key("ctrl+a"); h.type("ext draft"); time.sleep(0.3)
    r = ext("create", f"http://127.0.0.1:{port}", f"{BASE}/page.html?extbusy=1")
    time.sleep(1.5)
    tabs_now = ctl_json("tabs")
    check("a tab another client opens while the person is busy: in the background, their draft intact",
          any("extbusy=1" in t["url"] and not t["active"] for t in tabs_now) and "ext draft" in h.line(2), (h.line(2), [(t["url"][-20:], t["active"]) for t in tabs_now]))
    h.key("escape"); time.sleep(1.6)
    for t in ctl_json("tabs"):
        if "extbusy" in t["url"]:
            ctl("close", str(t["id"]), "--force")

    # --- a background tab that was shown keeps its size after another client's override on it goes away
    hid = ctl_json("open", f"{BASE}/page.html?hid=1", "--new-tab", "--background").get("id")
    ctl("select", str(hid)); time.sleep(1.5); ctl("select", str(first)); time.sleep(1)
    want = page_value("[innerWidth, innerHeight]")
    r = ext("viewport", f"http://127.0.0.1:{port}", "hid=1", "500", "400", "1")
    hid_size = lambda: ctl_json("eval", "[innerWidth, innerHeight]", "--tab", str(hid)).get("value")
    check("a hidden tab gets its size back once another client lets go of it",
          json.loads(r.stdout or "[]") == [500, 400] and wait_until(lambda: hid_size() == want, 10), (r.stdout, hid_size(), want))
    ctl("close", str(hid), "--force")

    # --- a tab another client opens while the person is typing into the page: behind, their keys stay put
    ctl("eval", "scrollTo(0, 0)")
    cb = page_value("(() => { const r = document.getElementById('city').getBoundingClientRect(); return [r.x + 10, r.y + r.height / 2]; })()")
    ctl("type", ref(ctl("snapshot").stdout, "textbox", "City"), "")
    h.click(220 + int(cb[0]), 40 + int(cb[1])); time.sleep(0.3)
    h.type("a")
    creator = subprocess.Popen(["bun", os.path.join(ROOT, "tests/support/cdp-ext.ts"), "create", f"http://127.0.0.1:{port}", f"{BASE}/page.html?typing=1"],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    time.sleep(0.4)
    h.type("b")
    creator.communicate(timeout=30); time.sleep(0.8)
    check("a tab another client opens just after the person typed: behind, their next key lands where they type",
          page_value("document.getElementById('city').value") == "ab" and [t["active"] for t in ctl_json("tabs")][0],
          (page_value("document.getElementById('city').value"), [(t["url"][-12:], t["active"]) for t in ctl_json("tabs")]))
    for t in ctl_json("tabs"):
        if "typing=1" in t["url"]:
            ctl("close", str(t["id"]), "--force")

    # --- screenshots: private files; tall pages whole (in tiles), or said to be cut
    sp = os.path.join(tmp, "private.png")
    old_umask = os.umask(0o022)
    r = ctl("shot", "-o", sp)
    os.umask(old_umask)
    check("shot files are readable only by you (0600, whatever the umask)", r.returncode == 0 and stat.S_IMODE(os.stat(sp).st_mode) == 0o600, oct(os.stat(sp).st_mode))
    tall = ctl_json("open", "data:text/html,<body style='margin:0'><div style='height:18000px;background:linear-gradient(red,blue)'></div>", "--new-tab", "--background")
    tp = os.path.join(tmp, "tall.png")
    r = ctl("shot", str(tall.get("id")), "--full", "-o", tp)
    from PIL import Image as _I
    check("shot --full of an 18000 px page: all of it (tiled)", r.returncode == 0 and _I.open(tp).size[1] == 18000, (r.returncode, r.stderr, _I.open(tp).size if os.path.exists(tp) else None))
    ctl("open", "data:text/html,<body style='margin:0'><div style='height:60000px'></div>", "--tab", str(tall.get("id")))
    r = ctl("shot", str(tall.get("id")), "--full", "-o", tp)
    check("shot --full of a page over the limit: the top part saved, exit 5, said on stderr",
          r.returncode == 5 and "captured the top" in r.stderr and 0 < _I.open(tp).size[1] < 60000, (r.returncode, r.stderr))
    ctl("close", str(tall.get("id")), "--force")

    # --- a page that shows a dialog while it loads: open returns at once, and dialog answers it
    t0 = time.time()
    r = ctl_json("open", "data:text/html,<title>alerting</title><script>alert('loaded')</script>", "--new-tab", "--background", "--timeout", "20")
    took = time.time() - t0
    check(f"open of a page that alerts while loading returns at once, reporting the dialog ({took:.1f}s)",
          took < 6 and (r.get("dialog") or {}).get("message") == "loaded", (took, r))
    rd = ctl("dialog", "accept", "--tab", str(r.get("id")))
    check("...and dialog answers it", rd.returncode == 0, (rd.returncode, rd.stderr))
    ctl("close", str(r.get("id")), "--force")

    # --- a hello and no request: the session lets go of the connection
    import struct
    so = socket.socket(socket.AF_UNIX); so.connect(os.path.join(sockdir, "watch.sock"))
    hello = json.dumps({"t": "hello", "v": 1, "kind": "ctl"}).encode()
    so.sendall(bytes([1]) + struct.pack(">I", len(hello)) + hello)
    so.settimeout(15)
    got = b""
    t0 = time.time()
    try:
        while True:
            chunk = so.recv(4096)
            if not chunk:
                break
            got += chunk
    except socket.timeout:
        pass
    so.close()
    check(f"an agent connection that sends no request is let go ({time.time() - t0:.0f}s)", b"no request came" in got and time.time() - t0 < 14, got[:200])

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
    # Held for a while on a page that keeps changing: no periodic freezes (termium trying its own size now and then).
    ctl("open", f"{BASE}/anim.html")
    time.sleep(2)
    holder = subprocess.Popen(["bun", os.path.join(ROOT, "tests/support/cdp-ext.ts"), "viewport", url, "anim.html", "500", "400", "15"],
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    holder.stdout.readline(); time.sleep(1)
    samples = []
    t_end = time.time() + 12
    while time.time() < t_end:
        samples.append((time.time(), h.frames)); time.sleep(0.1)
    holder.communicate(timeout=30)
    gaps, last_t, last_f = [], samples[0][0], samples[0][1]
    for ts, fr in samples:
        if fr != last_f:
            gaps.append(ts - last_t); last_t, last_f = ts, fr
    gaps.append(samples[-1][0] - last_t)
    check("a viewport held by another client: the pane keeps updating (no freeze over 1 s in 12 s)", max(gaps) < 1.0, round(max(gaps), 2))
    ctl("open", f"{BASE}/agent.html")
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
    # Typed and pasted text never reaches the debug log (TERMIUM_DEBUG traces DevTools traffic).
    dbg = Term(["bun", main, "-s", "dbg", "--incognito", f"{BASE}/agent.html"], cwd=ROOT, env=dict(ENV, TERMIUM_DEBUG="1"))
    dbg.wait_text("Agent fixture", 30); dbg.wait_idle(0.8, 10)
    dsnap = ctl("snapshot", session="dbg").stdout
    ctl("type", ref(dsnap, "textbox", "Secret"), "AGENT-SECRET-77", session="dbg")
    ctl("type", ref(dsnap, "textbox", "City"), "AGENT-CITY-77", session="dbg")
    dbox = page_value("(() => { const r = document.getElementById('name').getBoundingClientRect(); return [r.x + 10, r.y + r.height / 2]; })()", session="dbg")
    dbg.click(220 + int(dbox[0]), 40 + int(dbox[1])); time.sleep(0.3)
    dbg.type("humansecret"); dbg.paste("PASTED-SECRET-77"); time.sleep(1)
    # (Read the log first: an agent's own eval reading the fields back is traced, as evals are.)
    dlog = open(os.path.join(tmp, "state", "termium", "termium.log")).read()
    typed = page_value("[document.getElementById('pw').value, document.getElementById('name').value]", session="dbg")
    check("TERMIUM_DEBUG: what agents and the person type or paste is never logged (but the log traces DevTools)",
          typed == ["AGENT-SECRET-77", "humansecretPASTED-SECRET-77"] and "-> {" in dlog
          and not any(x in dlog for x in ("AGENT-SECRET", "AGENT-CITY", "humansecret", "PASTED-SECRET")), typed)
    dbg.close()

    # Another browser holds the profile: start says why.
    helium = shutil.which("helium-browser") or shutil.which("helium")
    held = os.path.join(tmp, "held-profile"); os.makedirs(held)
    hb = subprocess.Popen([helium, "--headless=new", f"--user-data-dir={held}", "--no-first-run", "about:blank"],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    time.sleep(3)
    r = cli("start", "-s", "heldp", "--profile", held)
    os.killpg(hb.pid, signal.SIGTERM); hb.wait(timeout=20)
    check("start on a profile another browser holds: fails saying why (not 'without answering')",
          r.returncode != 0 and "without answering" not in r.stderr and len(r.stderr.strip()) > 20, (r.returncode, r.stderr))

    # A short override (let go 0.4 s after setting it): the page still gets its size back.
    r = ext("viewport", json.loads(cli("devtools", "bg", "--json").stdout or "{}").get("browserURL", ""), "agent.html", "444", "333", "0.4")
    check("detached: a viewport another client holds only briefly still gives way to 1280x800",
          json.loads(r.stdout or "[]") == [444, 333] and wait_until(lambda: page_value("[innerWidth, innerHeight]", session="bg") == [1280, 800], 10),
          (r.stdout, page_value("[innerWidth, innerHeight]", session="bg")))
    # close re-checks its time and the person after its (slow) unsaved-changes probe, just before closing.
    sp_ = Term(["bun", main, "-s", "slowp", "--incognito", f"{BASE}/agent.html"], cwd=ROOT, env=dict(ENV, TERMIUM_TEST_SLOW_PROBE_MS="2000"))
    sp_.wait_text("Agent fixture", 30); sp_.wait_idle(0.8, 10); time.sleep(1.6)
    other = ctl_json("open", f"{BASE}/page.html?probe=1", "--new-tab", "--background", session="slowp").get("id")
    t0 = time.time()
    r = ctl("close", str(other), "--timeout", "0.5", session="slowp")
    check(f"close whose time runs out during its probe: exit 4, tab kept ({time.time() - t0:.1f}s)",
          r.returncode == 4 and any(t["id"] == other for t in ctl_json("tabs", session="slowp")), (r.returncode, r.stderr))
    mine = ctl_json("tabs", session="slowp")[0]["id"]
    closer = subprocess.Popen(["bun", main, "ctl", "-s", "slowp", "close", str(mine), "--timeout", "10"], cwd=ROOT, env=dict(os.environ, **ENV),
                              stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    time.sleep(0.8)
    sp_.key("ctrl+l"); sp_.key("ctrl+a"); sp_.type("draft during probe"); time.sleep(0.3)
    out, err = closer.communicate(timeout=30)
    check("close of the person's tab when they start editing during the probe: exit 4, tab and draft intact",
          closer.returncode == 4 and "draft during probe" in sp_.line(2) and any(t["id"] == mine for t in ctl_json("tabs", session="slowp")),
          (closer.returncode, err, sp_.line(2)))
    sp_.close()

    # A detached page that another client resized, then let go: back to its size (1280x800 here).
    bg_url = json.loads(cli("devtools", "bg", "--json").stdout or "{}").get("browserURL", "")
    r = ext("viewport", bg_url, "agent.html", "500", "400", "2")
    check("detached: another client's viewport, once let go, gives way to 1280x800 again",
          json.loads(r.stdout or "[]") == [500, 400] and wait_until(lambda: page_value("[innerWidth, innerHeight]", session="bg") == [1280, 800], 10),
          (r.stdout, page_value("[innerWidth, innerHeight]", session="bg")))
    r = cli("kill", "bg")
    check("kill ends it", r.returncode == 0 and server_pid("bg") is None, (r.returncode, r.stderr))
    # kill takes a session's restart snapshot with it (running or not).
    os.makedirs(sockdir, exist_ok=True)
    snap_path = os.path.join(sockdir, "gone.restore")
    open(snap_path, "w").write("{}"); os.chmod(snap_path, 0o600)
    r = cli("kill", "gone")
    check("kill removes a session's restart snapshot", r.returncode == 0 and not os.path.exists(snap_path) and "snapshot" in r.stderr, (r.returncode, r.stderr))
    # Started without a URL: wait load is done at once.
    cli("start", "-s", "blank", "--incognito")
    r = ctl("wait", "load", "--timeout", "5", session="blank")
    check("wait load on a session started without a URL: done", r.returncode == 0, (r.returncode, r.stderr))
    cli("kill", "blank")
    # ctl while a session is still starting (reopening a restart snapshot without a terminal): it waits, never "couldn't start".
    layout = {"spaces": [{"name": "kept", "active": 0, "tabs": [{"root": {"url": f"{BASE}/agent.html?r={i}"}, "focus": 0, "zoomed": False} for i in range(6)]}],
              "activeSpace": 0, "sidebar": True, "zoom": 1}
    rp = os.path.join(sockdir, "rest.restore")
    json.dump({"v": 1, "at": int(time.time() * 1000), "from": "0.3.0", "layout": layout,
               "launch": {"incognito": True, "scale": None, "search": "https://duckduckgo.com/?q=%s"}}, open(rp, "w"))
    os.chmod(rp, 0o600)
    starter = subprocess.Popen(["bun", main, "start", "-s", "rest"], cwd=ROOT, env=dict(os.environ, **ENV), stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
    codes = []
    end = time.time() + 40
    while time.time() < end and starter.poll() is None:
        q = ctl("tabs", session="rest")
        if q.returncode != 3:
            codes.append((q.returncode, q.stderr.strip()[:80]))
    starter.communicate(timeout=60)
    final = ctl_json("tabs", session="rest")
    check("ctl during a restore waits for it (no 'couldn't start' failures), and sees every tab",
          all(c == 0 for c, _ in codes) and isinstance(final, list) and len(final) == 6, (codes, final if not isinstance(final, list) else len(final)))
    cli("kill", "rest")
    # Two starts of one name at once, each with a URL: one session, both URLs open.
    starts = [subprocess.Popen(["bun", main, "start", "-s", "race", "--incognito", f"{BASE}/{f}"], cwd=ROOT, env=dict(os.environ, **ENV),
                               stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
              for f in ("agent.html?one=1", "page.html?two=1")]
    outs = [p.communicate(timeout=90) for p in starts]
    urls = [t["url"] for t in ctl_json("tabs", session="race")] if server_pid("race") else []
    check("two starts at once: both exit 0, one session, both URLs open", all(p.returncode == 0 for p in starts)
          and any("one=1" in u for u in urls) and any("two=1" in u for u in urls), (outs, urls))
    cli("kill", "race")
finally:
    for t in [x for x in globals().values() if isinstance(x, Term)]:
        if t.alive:
            try:
                t.close()
            except Exception:
                pass
    for name in ("watch", "bg", "race", "blank", "rest", "dbg", "heldp", "slowp"):
        pid = server_pid(name)
        if pid:
            os.kill(pid, signal.SIGTERM)
    time.sleep(2)
    srv.terminate()
    shutil.rmtree(tmp, ignore_errors=True)

print("FAILED: " + ", ".join(failures) if failures else "ALL PASSED")
sys.exit(1 if failures else 0)
