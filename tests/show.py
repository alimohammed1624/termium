#!/usr/bin/env python3
"""`termium ctl show` against the real stack (termium + Helium).

A person's terminal (a PTY answering like Ghostty) is attached to a session
while an agent, with no terminal, shows an HTML file it wrote: it opens in a
pane beside the person's (whose focus stays put), showing it again with the
same name updates that pane instead of opening another, and changing the
file reloads it. Also HTML piped from stdin, --new-tab, and usage errors.

Usage: python3 tests/show.py [SESSION]   (SESSION defaults to "show")
"""
import json, os, shutil, signal, subprocess, sys, tempfile, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
from drive import Term

failures = []
def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))
    if not cond:
        failures.append(name)

SESSION = sys.argv[1] if len(sys.argv) > 1 else "show"
main = os.path.join(ROOT, "src", "main.ts")
tmp = tempfile.mkdtemp(prefix="tshow-")
rt = os.path.join(tmp, "run"); os.makedirs(rt)
work = os.path.join(tmp, "work"); os.makedirs(work)
TMPD = os.path.join(tmp, "t"); os.makedirs(TMPD)
ENV = {"XDG_RUNTIME_DIR": rt, "TMPDIR": TMPD, "TERMIUM_NO_UPDATE_CHECK": "1",
       "XDG_DATA_HOME": os.path.join(tmp, "data"), "XDG_STATE_HOME": os.path.join(tmp, "state")}

def ctl(*args, stdin=None):
    return subprocess.run(["bun", main, "ctl", "-s", SESSION, *args], cwd=work, env=dict(os.environ, **ENV),
                          input=stdin, stdin=None if stdin is not None else subprocess.DEVNULL,
                          capture_output=True, text=True, timeout=90, start_new_session=True)

def ctl_json(*args, stdin=None):
    r = ctl(*args, "--json", stdin=stdin)
    try:
        return json.loads(r.stdout)
    except ValueError:
        return {"_error": (r.returncode, r.stdout, r.stderr)}

def page_text(tab):
    return ctl_json("eval", "document.body.innerText", str(tab)).get("value")

def wait_until(pred, timeout):
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(0.3)
    return False

def write(path, body):
    with open(path, "w") as f:
        f.write(f"<!doctype html><title>Plan</title><h1>{body}</h1>")

plan = os.path.join(work, "plan.html")
write(plan, "Plan v1")
h = None
try:
    h = Term(["bun", main, "-s", SESSION, "--profile", os.path.join(tmp, "profile"), "about:blank"], cwd=ROOT, env=ENV)
    check("the person's terminal is up", h.wait_frames(1, 40))
    h.wait_idle(0.8, 10)
    before = ctl_json("tabs")
    person = before[0]["id"] if isinstance(before, list) and before else None

    # --- show: a pane beside the person's, their focus kept
    r = ctl_json("show", "plan.html")
    tab = r.get("id")
    check("show opens the file in a new pane", r.get("pane") == 2 and r.get("url", "").endswith("/plan.html")
          and r.get("reused") is False and r.get("title") == "Plan", r)
    tabs = ctl_json("tabs")
    check("one tab with two panes; the person's pane keeps the focus",
          isinstance(tabs, list) and len(tabs) == 2 and {t["tab"] for t in tabs} == {1}
          and next(t for t in tabs if t["id"] == person)["active"], tabs)
    check("the pane shows the file", page_text(tab) == "Plan v1")
    check("both panes are on screen", all(t["visible"] for t in tabs) and wait_until(lambda: h.frames >= 2, 10), tabs)

    # --- show again: the same pane, updated
    write(plan, "Plan v2")
    r = ctl_json("show", plan)
    check("show again (same file) reuses that pane", r.get("id") == tab and r.get("reused") is True, r)
    check("and shows the new content at once", page_text(tab) == "Plan v2")
    check("still just two panes", len(ctl_json("tabs")) == 2)

    # --- the file changes: the pane reloads by itself
    write(plan, "Plan v3, rewritten")
    check("a changed file reloads its pane", wait_until(lambda: page_text(tab) == "Plan v3, rewritten", 10))
    os.replace(plan, plan + ".old")
    write(plan + ".new", "Plan v4, replaced")
    os.replace(plan + ".new", plan)
    check("a file replaced (renamed over) reloads too", wait_until(lambda: page_text(tab) == "Plan v4, replaced", 10))

    # Another file renamed over it with the same size and modification time: still noticed.
    st = os.stat(plan)
    write(plan + ".new", "Plan v5, replaced")  # (same length as v4)
    os.utime(plan + ".new", ns=(st.st_atime_ns, st.st_mtime_ns))
    os.replace(plan + ".new", plan)
    check("a file renamed over it with the same size and time reloads too", wait_until(lambda: page_text(tab) == "Plan v5, replaced", 10))

    # --- the person typing in that pane: no reload under their keys, one once they stop
    ctl("select", str(tab))
    write(plan, "Plan v6, while typing")
    t0 = time.time()
    while time.time() - t0 < 2.5:
        h.type("x"); time.sleep(0.25)
    check("no reload while the person types in the pane", page_text(tab) == "Plan v5, replaced")
    check("it reloads once they stop", wait_until(lambda: page_text(tab) == "Plan v6, while typing", 10))
    ctl("select", str(person))

    # --- a dialog open on the pane: its answer is the person's (or an agent's), not a reload's
    ctl("eval", "setTimeout(() => alert('wait'), 10); 1", str(tab))
    dialog_of = lambda: next((t.get("dialog") for t in ctl_json("tabs") if t["id"] == tab), None)
    check("the pane shows a dialog", wait_until(lambda: dialog_of() is not None, 5))
    write(plan, "Plan v7, after dialog")
    time.sleep(2)
    check("no reload while it shows a dialog", dialog_of() is not None)
    ctl("dialog", "accept", "--tab", str(tab))
    check("it reloads once the dialog is answered", wait_until(lambda: page_text(tab) == "Plan v7, after dialog", 10))

    # --- --name: another file into the same pane
    other = os.path.join(work, "report.html")
    write(other, "Report")
    r = ctl_json("show", other, "--name", plan)
    check("--name puts another file in that named pane", r.get("id") == tab and r.get("url", "").endswith("/report.html"), r)
    check("still just two panes after --name", len(ctl_json("tabs")) == 2)
    write(other, "Report, rewritten")
    check("the named pane now follows the other file", wait_until(lambda: page_text(tab) == "Report, rewritten", 10))

    # --- HTML from stdin
    r = ctl_json("show", "-", "--name", "piped", stdin="<title>Piped</title><p>from stdin 1</p>")
    piped = r.get("id")
    check("show - shows piped HTML in a new pane", piped not in (None, tab) and r.get("title") == "Piped"
          and page_text(piped) == "from stdin 1", r)
    w = ctl_json("eval", "[innerWidth, innerHeight]", str(person)).get("value") or [0, 0]
    pw = ctl_json("eval", "[innerWidth, innerHeight]", str(piped)).get("value") or [0, 0]
    check("a second shown pane goes below the first, not beside the person's", abs(w[0] - pw[0]) < 40 and pw[1] < w[1], (w, pw))
    r = ctl_json("show", "-", "--name", "piped", stdin="<title>Piped</title><p>from stdin 2</p>")
    check("piped again with the same name updates that pane", r.get("id") == piped and page_text(piped) == "from stdin 2", r)
    tmpfile = r.get("url", "")[len("file://"):]
    check("piped HTML's file is readable only by you, in the session's temp dir",
          os.path.exists(tmpfile) and (os.stat(tmpfile).st_mode & 0o777) == 0o600
          and os.path.basename(os.path.dirname(os.path.dirname(tmpfile))).startswith("tmb-"), tmpfile)

    ctl("close", str(piped))
    check("closing a piped pane removes its file", wait_until(lambda: not os.path.exists(tmpfile), 5), tmpfile)
    r = ctl_json("show", "-", "--name", "piped2", stdin="<p>piped, then left</p>")
    away_file = r.get("url", "")[len("file://"):]
    ctl("open", "file://" + other, "--tab", str(r.get("id")))
    check("a piped pane navigated elsewhere drops its file", wait_until(lambda: not os.path.exists(away_file), 5), away_file)
    ctl("close", str(r.get("id")))

    # --- --new-tab
    r = ctl_json("show", other, "--new-tab")
    check("--new-tab opens it in a tab behind", r.get("tab") == 2 and r.get("pane") == 1 and not r.get("active"), r)

    # --- closed pane: a new one next time
    ctl("close", str(tab))
    r = ctl_json("show", plan)
    check("after its pane is closed, show opens a new one", r.get("id") not in (None, tab) and page_text(r.get("id")) == "Plan v7, after dialog", r)

    # --- a pane already showing the file, not from show (as after a restart): adopted, not duplicated
    lone = os.path.join(work, "lone.html")
    write(lone, "Lone")
    opened = ctl_json("open", "file://" + lone, "--new-tab", "--background").get("id")
    r = ctl_json("show", lone)
    check("show adopts a pane already showing that file", opened and r.get("id") == opened and r.get("reused") is True, (opened, r))
    write(lone, "Lone, rewritten")
    check("and follows the file from then on", wait_until(lambda: page_text(opened) == "Lone, rewritten", 10))
    r = ctl_json("show", lone, "--new-tab", "--name", "elsewhere")
    check("--new-tab never adopts: a tab of its own", r.get("id") not in (None, opened) and r.get("reused") is False, r)

    # --- errors
    r = ctl("show", "nope.html")
    check("a missing file is exit 1", r.returncode == 1 and "no such file" in r.stderr, (r.returncode, r.stderr))
    r = ctl("show")
    check("show without a file is exit 2", r.returncode == 2, (r.returncode, r.stderr))
    check("the person's terminal stayed attached", h.alive and os.waitpid(h.pid, os.WNOHANG) == (0, 0))
    if os.environ.get("SHOW_SHOT"):
        h.wait_idle(1.0, 10)
        h.shot(os.environ["SHOW_SHOT"])
finally:
    if h and h.alive:
        try:
            h.close()
        except Exception:
            pass
    try:
        pid = int(open(os.path.join(rt, "termium", f"{SESSION}.pid")).read())
        os.kill(pid, signal.SIGTERM)
    except (OSError, ValueError):
        pass
    time.sleep(1.5)
    shutil.rmtree(tmp, ignore_errors=True)

print("FAILED: " + ", ".join(failures) if failures else "ALL PASSED")
sys.exit(1 if failures else 0)
