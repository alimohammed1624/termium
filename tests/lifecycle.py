#!/usr/bin/env python3
"""Startup and shutdown edge cases against the real stack (termium + Helium).

termium runs as a client of a background session server that owns the
browser; "killed outright" below means the server and the client both get
SIGKILL (Term.kill9). Detaching, takeover and the other session cases are in
tests/sessions.py.

Covers: a bad --browser, a profile already in use (under several launch
spellings, the first instance must survive), recovery after termium is
SIGKILLed (persistent and incognito profiles), a terminal without kitty
graphics, a long TMPDIR, garbage input, and Ctrl+Q from the address bar.

Usage: python3 tests/lifecycle.py
"""
import glob, os, shutil, signal, subprocess, sys, tempfile, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
from drive import Term

failures = []
def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))
    if not cond:
        failures.append(name)

def helium_on(profile):
    r = subprocess.run(["pgrep", "-c", "-f", "--", f"user-data-dir={profile}"], capture_output=True, text=True)
    return int(r.stdout.strip() or 0)

def freeze_browser(profile):
    """Stops the browser on a profile (SIGSTOP). Killed outright, a session's
    browser usually exits by itself once its DevTools pipe closes; frozen,
    it stands for one that doesn't, which the next start must stop."""
    r = subprocess.run(["pgrep", "-a", "-f", "--", f"user-data-dir={profile}"], capture_output=True, text=True)
    for line in r.stdout.splitlines():
        pid, _, cmd = line.partition(" ")
        if " --type=" not in f" {cmd}":  # the browser itself, not its renderers and helpers
            os.kill(int(pid), signal.SIGSTOP)

def at_address_bar(t, timeout=25):
    return t.wait_for(lambda: "SPACES" in t.text() and not t.screen.cursor.hidden and t.screen.cursor.y == 1, timeout)

def running(t):
    try:
        return os.waitpid(t.pid, os.WNOHANG)[0] == 0
    except ChildProcessError:
        return False

def output(t):
    return bytes(t.raw).decode(errors="replace")

main = os.path.join(ROOT, "src", "main.ts")
tmp = tempfile.mkdtemp(prefix="tl-")
try:
    # bad --browser
    t = Term(["bun", main, "--incognito", "--browser", "/no/such/helium"], cwd=ROOT)
    t.wait_for(lambda: not running(t), 10)
    check("bad --browser is an error", "--browser /no/such/helium: no such executable" in output(t), output(t)[-200:])

    # profile in use: the second instance refuses, whatever way either was started
    prof = os.path.join(tmp, "p1")
    a = Term(["bun", "./src/main.ts", "--profile", prof], cwd=ROOT)
    check("first instance starts", at_address_bar(a))
    for argv, cwd in ((["bun", "src/main.ts"], ROOT), (["bun", "main.ts"], os.path.join(ROOT, "src")), (["bun", main], "/")):
        b = Term(argv + ["--profile", prof], cwd=cwd)
        b.wait_for(lambda: not running(b), 15)
        check(f"second instance ({' '.join(argv)}) refuses", "is in use" in output(b), output(b)[-200:])
        time.sleep(0.5)
        check(f"first instance survives ({' '.join(argv)})", running(a) and helium_on(prof) > 0)

    # SIGKILL: the next start stops the leftover browser and works
    freeze_browser(prof)
    a.kill9()
    time.sleep(1)
    check("browser outlives a SIGKILLed termium (precondition)", helium_on(prof) > 0)
    c = Term(["bun", main, "--profile", prof], cwd=ROOT)
    check("restart after SIGKILL reaches the address bar", at_address_bar(c))

    # a relative --profile, killed, then reopened by its absolute path, recovers
    rel_parent = tmp
    r1 = Term(["bun", main, "--profile", "p3"], cwd=rel_parent)
    check("relative profile starts", at_address_bar(r1))
    freeze_browser(os.path.join(tmp, "p3"))
    r1.kill9()
    time.sleep(1)
    r2 = Term(["bun", main, "--profile", os.path.join(tmp, "p3") + "/"], cwd="/")
    check("reopened by absolute path after SIGKILL", at_address_bar(r2))
    r2.close()

    # two termiums started at the same moment on one profile: one runs, the
    # other refuses (several tries: the race is timing-dependent)
    for attempt in range(3):
        prof4 = os.path.join(tmp, f"p4-{attempt}")
        x = Term(["bun", main, "--profile", prof4], cwd=ROOT)
        y = Term(["bun", main, "--profile", prof4], cwd=ROOT)
        time.sleep(10)
        alive = [z for z in (x, y) if running(z)]
        check(f"simultaneous start #{attempt + 1}: exactly one survives", len(alive) == 1, [running(x), running(y)])
        if alive:
            check(f"simultaneous start #{attempt + 1}: the survivor works", at_address_bar(alive[0], 5) and helium_on(prof4) > 0)
            loser = y if alive[0] is x else x
            check(f"simultaneous start #{attempt + 1}: the other says why", "in use" in output(loser), output(loser)[-200:])
        for z in (x, y):
            if z.alive:
                z.close()

    # an empty lock file (an older termium interrupted mid-write) doesn't block the profile
    prof6 = os.path.join(tmp, "p6"); os.makedirs(prof6)
    open(os.path.join(prof6, "termium.lock"), "w").close()
    e6 = Term(["bun", main, "--profile", prof6], cwd=ROOT)
    check("an empty lock file doesn't block startup", at_address_bar(e6))
    e6.close()

    # several termiums taking over the same stale lock at once: exactly one gets it
    prof7 = os.path.join(tmp, "p7"); os.makedirs(prof7)
    winners = []
    for trial in range(4):
        with open(os.path.join(prof7, "termium.lock"), "w") as f:
            f.write('{"pid": 999999, "start": "never"}')
        start_at = int(time.time() * 1000) + 1500
        procs = [subprocess.Popen(["bun", os.path.join(ROOT, "tests/support/lock-race.ts"), prof7, str(start_at)],
                                  stdout=subprocess.PIPE, text=True) for _ in range(6)]
        outs = [p.communicate(timeout=30)[0].strip() for p in procs]
        winners.append(outs.count("won"))
        for n in os.listdir(prof7):
            os.remove(os.path.join(prof7, n))
    check("stale lock: exactly one of six racing termiums takes it", winners == [1, 1, 1, 1], winners)

    # option and profile-path errors
    bad = Term(["bun", main, "--incognito", "--profile", os.path.join(tmp, "px")], cwd=ROOT)
    bad.wait_for(lambda: not running(bad), 10)
    check("--incognito with --profile is an error", "can't be used together" in output(bad), output(bad)[-200:])
    blocker = os.path.join(tmp, "afile"); open(blocker, "w").write("x")
    bad2 = Term(["bun", main, "--profile", os.path.join(blocker, "sub")], cwd=ROOT)
    bad2.wait_for(lambda: not running(bad2), 10)
    check("an unusable profile path says so", "can't use that profile directory" in output(bad2), output(bad2)[-200:])

    # killed during startup, after the browser took the profile but before the terminal answered
    class SlowTerminal(Term):
        def _answer_queries(self, data):
            threading.Timer(3.0, Term._answer_queries, (self, data)).start()
    prof5 = os.path.join(tmp, "p5")
    k = SlowTerminal(["bun", main, "--profile", prof5], cwd=ROOT)
    t0 = time.time()
    while time.time() - t0 < 10 and not os.path.lexists(os.path.join(prof5, "SingletonLock")):
        time.sleep(0.05)
    k.kill9()
    time.sleep(1)
    k2 = Term(["bun", main, "--profile", prof5], cwd=ROOT)
    check("killed mid-startup: next start recovers the profile", at_address_bar(k2))
    k2.close()

    # HiDPI cells (scale 2) on a page that never stops redrawing: the picture
    # has the pane's full device resolution, and the page's viewport follows
    # every sidebar toggle, zoom and resize.
    import http.server, functools, socket as _socket
    with _socket.socket() as so:
        so.bind(("127.0.0.1", 0)); hport = so.getsockname()[1]
    hsrv = subprocess.Popen([shutil.which("python3") or sys.executable, "-m", "http.server", str(hport), "--bind", "127.0.0.1",
                             "--directory", os.path.join(ROOT, "tests", "fixtures")], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(0.5)
    hprof = os.path.join(tmp, "hidpi")
    hd = Term(["bun", main, "--profile", hprof, f"http://127.0.0.1:{hport}/anim.html"], cwd=ROOT, cols=100, rows=30, cell_w=20, cell_h=40,
              env={"TERMIUM_TEST_DEVTOOLS_PORT": "1"})
    def viewport():
        r = subprocess.run(["bun", os.path.join(ROOT, "tests/support/cdp-eval.ts"), hprof, "[innerWidth, innerHeight, devicePixelRatio]"],
                           capture_output=True, text=True, timeout=20)
        import json as _json
        vals = [p["value"] for p in _json.loads(r.stdout or "[]") if p["value"]]
        return vals[0] if vals else None
    hd.wait_frames(1, 25); time.sleep(5)
    img = hd.latest_image()
    want = ((100 - 22) * 20, (30 - 2) * 40)
    check("HiDPI frames at full device resolution", img is not None and img.size == want, (img and img.size, want))
    ok = True
    steps = []
    def expect(cols, rows, zoom, sidebar=True):
        dsf = round(2 * zoom * 100) / 100
        pane_cols = cols - (22 if sidebar and cols >= 52 else 0)
        return [round(pane_cols * 20 / dsf), round((rows - 2) * 40 / dsf), dsf]
    for action, exp in (
        (lambda: (hd.key("ctrl+b"), hd.key("b")), expect(100, 30, 1, sidebar=False)),
        (lambda: (hd.key("ctrl+b"), hd.key("b")), expect(100, 30, 1)),
        (lambda: hd.key("alt+="), expect(100, 30, 1.1)),
        (lambda: hd.key("alt+0"), expect(100, 30, 1)),
        (lambda: hd.resize(80, 24), expect(80, 24, 1)),
        (lambda: hd.resize(100, 30), expect(100, 30, 1)),
    ):
        action(); time.sleep(2.5)
        got = viewport()
        steps.append((got, exp))
        if not got or abs(got[0] - exp[0]) > 1 or abs(got[1] - exp[1]) > 1 or abs(got[2] - exp[2]) > 0.02:
            ok = False
    check("busy HiDPI page's viewport follows every change", ok, steps)

    # a page that is merely busy for a few seconds is reloaded, not replaced
    def page_eval(expr):
        r = subprocess.run(["bun", os.path.join(ROOT, "tests/support/cdp-eval.ts"), hprof, expr], capture_output=True, text=True, timeout=20)
        import json as _json
        vals = [p["value"] for p in _json.loads(r.stdout or "[]") if p.get("answered", True) and p["value"] is not None]
        return vals[0] if vals else None
    hd.key("ctrl+l"); hd.key("ctrl+a"); hd.key("ctrl+k"); hd.type(f"http://127.0.0.1:{hport}/anim.html?second=1"); hd.key("enter"); time.sleep(3)
    hist = page_eval("history.length")
    page_eval("setTimeout(() => { const t = Date.now(); while (Date.now() - t < 4000) {} }, 100)")
    time.sleep(0.3)
    hd.key("f5"); time.sleep(14)
    check("busy page is reloaded, not replaced", hist is not None and page_eval("history.length") == hist, (hist, page_eval("history.length")))
    hd.close()
    hsrv.terminate()

    # HiDPI: one scroll of a static page is one picture, not a storm of identical ones
    sprof = os.path.join(tmp, "static")
    st_ = Term(["bun", main, "--profile", sprof, "data:text/html,<div style='height:4000px;font:40px sans-serif'>static page</div>"],
               cwd=ROOT, cols=100, rows=30, cell_w=20, cell_h=40)
    st_.wait_frames(1, 25); time.sleep(5)
    before = st_.frames
    st_.scroll(600, 600, down=True, n=1); time.sleep(6)
    check("HiDPI: one scroll, a handful of frames", st_.frames - before <= 6, st_.frames - before)
    st_.close()

    # quitting asks when an edited form lives in a same-site, cross-origin iframe
    with _socket.socket() as so:
        so.bind(("127.0.0.1", 0)); hport2 = so.getsockname()[1]
    hsrv1 = subprocess.Popen([shutil.which("python3") or sys.executable, "-m", "http.server", str(hport), "--bind", "127.0.0.1",
                              "--directory", os.path.join(ROOT, "tests", "fixtures")], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    hsrv2 = subprocess.Popen([shutil.which("python3") or sys.executable, "-m", "http.server", str(hport2), "--bind", "127.0.0.1",
                              "--directory", os.path.join(ROOT, "tests", "fixtures")], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(0.5)
    qprof = os.path.join(tmp, "samesite")
    q = Term(["bun", main, "--profile", qprof, f"http://127.0.0.1:{hport}/samesite.html?port={hport2}"], cwd=ROOT,
             env={"TERMIUM_TEST_DEVTOOLS_PORT": "1"})
    q.wait_frames(1, 25); time.sleep(5)
    def q_state():
        r = subprocess.run(["bun", os.path.join(ROOT, "tests/support/cdp-eval.ts"), qprof, "window.termiumState ? termiumState() : null"],
                           capture_output=True, text=True, timeout=20)
        import json as _json
        vals = [p["value"] for p in _json.loads(r.stdout or "[]") if p["value"]]
        return vals[0] if vals else None
    q.wait_for(lambda: ((q_state() or {}).get("frame") or {}).get("textRect", [0])[0] > 0, 15)
    qs = q_state() or {"at": [0, 0], "frame": {"textRect": [0, 0]}}
    q.click(222 + int(qs["at"][0] + 1 + qs["frame"]["textRect"][0]), 40 + int(qs["at"][1] + 1 + qs["frame"]["textRect"][1])); time.sleep(0.3)
    q.type("draft"); time.sleep(0.5)
    q.key("ctrl+q")
    check("quit asks about an edited same-site iframe", q.wait_text("Quit anyway?", 8), q.line(2))
    q.key("escape"); time.sleep(0.5)
    q.close()
    hsrv1.terminate(); hsrv2.terminate()

    # paste into a page without an http origin still fires its paste event
    dprof = os.path.join(tmp, "datap")
    dp = Term(["bun", main, "--profile", dprof,
               "data:text/html,<input id=i autofocus onpaste=\"event.preventDefault(); this.value = event.clipboardData.getData('text').toUpperCase()\">"],
              cwd=ROOT, env={"TERMIUM_TEST_DEVTOOLS_PORT": "1"})
    dp.wait_frames(1, 25); time.sleep(4)
    dp.click(222 + 30, 40 + 15); time.sleep(0.3)
    dp.paste("hello paste"); time.sleep(1.0)
    r = subprocess.run(["bun", os.path.join(ROOT, "tests/support/cdp-eval.ts"), dprof, "document.getElementById('i').value"],
                       capture_output=True, text=True, timeout=20)
    check("paste on a data: page fires its paste event", '"HELLO PASTE"' in r.stdout, r.stdout[-200:])
    dp.close()

    # ...including in a focused same-origin iframe
    fprof = os.path.join(tmp, "datapf")
    inner = "<input id=j autofocus onpaste=&quot;event.preventDefault(); this.value = event.clipboardData.getData('text').toUpperCase()&quot;>"
    fp = Term(["bun", main, "--profile", fprof, f'data:text/html,<iframe id=f srcdoc="{inner}" width=300 height=60></iframe>'],
              cwd=ROOT, env={"TERMIUM_TEST_DEVTOOLS_PORT": "1"})
    fp.wait_frames(1, 25); time.sleep(4)
    fp.click(222 + 40, 40 + 25); time.sleep(0.3)
    fp.paste("token"); time.sleep(1.0)
    r = subprocess.run(["bun", os.path.join(ROOT, "tests/support/cdp-eval.ts"), fprof,
                        "document.getElementById('f').contentDocument.getElementById('j').value"], capture_output=True, text=True, timeout=20)
    check("fallback paste reaches a focused same-origin iframe", '"TOKEN"' in r.stdout, r.stdout[-200:])
    fp.close()

    # garbage input doesn't crash it
    c.write("\x1b[1114112u\x1b[99999999;5u\x1b[;;u\x1b[;;;;;;;u\x1b[<;;M\x1b_Gq=1\x1b\\")
    time.sleep(1.5)
    check("survives garbage input", running(c))

    # Ctrl+Q from the address bar
    c.key("ctrl+q")
    c.wait_for(lambda: not running(c), 10)
    check("ctrl+q quits from the address bar", not running(c) and helium_on(prof) == 0)

    # SIGKILLed incognito session: the next start removes its profile and browser
    # (a temp dir of the test's own, so the leftovers looked for are only these)
    itmp = os.path.join(tmp, "t"); os.makedirs(itmp)
    i1 = Term(["bun", main, "--incognito"], cwd=ROOT, env={"TMPDIR": itmp})
    check("incognito starts", at_address_bar(i1))
    inc = [d for d in glob.glob(os.path.join(itmp, f"termium-incognito-{i1.server_pid()}-*"))]
    check("incognito profile is in the temp dir", len(inc) == 1, inc)
    freeze_browser(inc[0]) if inc else None
    i1.kill9()
    time.sleep(1)
    i2 = Term(["bun", main, "--incognito"], cwd=ROOT, env={"TMPDIR": itmp})
    check("next start after a killed incognito session works", at_address_bar(i2))
    check("killed incognito session's profile removed", inc and not os.path.exists(inc[0]), inc)
    check("killed incognito session's browser stopped", inc and helium_on(inc[0]) == 0)
    i2.close()

    # a leftover whose termium is a zombie (dead, not yet reaped: how a killed session server
    # looks until something reaps it) is cleaned up like any other
    zpid = os.fork()
    if zpid == 0:
        os._exit(0)
    time.sleep(0.3)  # now a zombie: this process doesn't reap it yet
    zdir = os.path.join(itmp, f"termium-incognito-{zpid}-zombie")
    os.makedirs(os.path.join(zdir, "Default")); open(os.path.join(zdir, "Default", "x"), "w").write("x")
    z = Term(["bun", main, "--incognito"], cwd=ROOT, env={"TMPDIR": itmp})
    check("a session's start cleans up after a zombie termium", at_address_bar(z) and not os.path.exists(zdir), os.path.exists(zdir))
    z.close()
    os.waitpid(zpid, 0)

    # terminal without kitty graphics: refuses and leaves no browser behind
    class NoGraphics(Term):
        def _answer_queries(self, data):
            if b"\x1b[c" in data:
                self.write(b"\x1b[?62;22c")
    prof2 = os.path.join(tmp, "p2")
    n = NoGraphics(["bun", main, "--profile", prof2], cwd=ROOT)
    n.wait_for(lambda: not running(n), 15)
    time.sleep(1)
    check("no kitty graphics: clear refusal", "does not support the kitty graphics protocol" in output(n), output(n)[-200:])
    check("no kitty graphics: no browser left", helium_on(prof2) == 0)

    # a long TMPDIR (Chromium's socket path limit) still starts
    long_tmp = os.path.join(tmp, "x" * 60)
    os.makedirs(long_tmp)
    l = Term(["bun", main, "--incognito"], cwd=ROOT, env={"TMPDIR": long_tmp})
    check("starts with a long TMPDIR", at_address_bar(l))
    l.close()
finally:
    for t in [x for x in globals().values() if isinstance(x, Term)]:
        if t.alive:
            t.close()
    # Nothing frozen may outlive the run.
    subprocess.run(["pkill", "-KILL", "-f", "--", f"user-data-dir={tmp}"])
    for d in globals().get("inc") or []:
        subprocess.run(["pkill", "-KILL", "-f", "--", f"user-data-dir={d}"])
    shutil.rmtree(tmp, ignore_errors=True)

print("FAILED: " + ", ".join(failures) if failures else "ALL PASSED")
sys.exit(1 if failures else 0)
