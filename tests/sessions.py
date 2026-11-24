#!/usr/bin/env python3
"""Detachable sessions against the real stack (termium + Helium) in PTYs.

Attach, browse, detach (Ctrl+B d), check the browser and the page state
survive, re-attach from a terminal of another size (full redraw, geometry,
input), takeover by a second client, the client's terminal dying, the
server dying, `ls` / `kill`, named sessions and stale socket cleanup.

Usage: python3 tests/sessions.py
"""
import json, os, shutil, signal, socket, stat, subprocess, sys, tempfile, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
from drive import Term

failures = []
def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))
    if not cond:
        failures.append(name)

main = os.path.join(ROOT, "src", "main.ts")
tmp = tempfile.mkdtemp(prefix="tss-")
rt = os.path.join(tmp, "run"); os.makedirs(rt)
prof = os.path.join(tmp, "profile")
TMPD = os.path.join(tmp, "t"); os.makedirs(TMPD)  # the servers' temp dir: leftovers are looked for only here
ENV = {"XDG_RUNTIME_DIR": rt, "TMPDIR": TMPD,
       "XDG_DATA_HOME": os.path.join(tmp, "data"), "XDG_STATE_HOME": os.path.join(tmp, "state")}
sockdir = os.path.join(rt, "termium")

with socket.socket() as so:
    so.bind(("127.0.0.1", 0)); PORT = so.getsockname()[1]
srv = subprocess.Popen([shutil.which("python3") or sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1",
                        "--directory", os.path.join(ROOT, "tests", "fixtures")], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.5)
BASE = f"http://127.0.0.1:{PORT}"

def termium(*args, **kw):
    return Term(["bun", main, *args], cwd=ROOT, env=ENV, **kw)

def cli(*args):
    return subprocess.run(["bun", main, *args], cwd=ROOT, env=dict(os.environ, **ENV), capture_output=True, text=True, timeout=40)

def helium_on(profile):
    r = subprocess.run(["pgrep", "-c", "-f", "--", f"user-data-dir={profile}"], capture_output=True, text=True)
    return int(r.stdout.strip() or 0)

def page_eval(expr, match="page.html", profile=prof):
    r = subprocess.run(["bun", os.path.join(ROOT, "tests/support/cdp-eval.ts"), profile, expr], capture_output=True, text=True, timeout=20)
    for p in json.loads(r.stdout or "[]"):
        if match in p["url"] and "second=1" not in p["url"] and p["value"] is not None:
            return p["value"]
    return None

def state():
    return page_eval("window.termiumState ? termiumState() : null")

def exit_code(t, timeout=10):
    """Waits for the client to exit; its exit status, or None if it's still running."""
    end = time.time() + timeout
    while time.time() < end:
        try:
            pid, st = os.waitpid(t.pid, os.WNOHANG)
        except ChildProcessError:
            return getattr(t, "_code", None)
        if pid:
            t._code = os.waitstatus_to_exitcode(st)
            time.sleep(0.2)  # let the reader thread take the last output
            return t._code
        time.sleep(0.1)
    return None

def output(t):
    return bytes(t.raw).decode(errors="replace")

def restored(t):
    """The client left the alternate screen and popped its keyboard mode."""
    raw = bytes(t.raw)
    return raw.rfind(b"\x1b[?1049l") > raw.rfind(b"\x1b[?1049h") >= 0 and b"\x1b[<u" in raw

def server_pid(session="default"):
    try:
        pid = int(open(os.path.join(sockdir, f"{session}.pid")).read())
        os.kill(pid, 0)
        return pid
    except (OSError, ValueError):
        return None

def at_address_bar(t, timeout=25):
    return t.wait_for(lambda: "SPACES" in t.text() and not t.screen.cursor.hidden and t.screen.cursor.y == 1, timeout)

def newest_image(t):
    with t.lock:
        if not t.placements:
            return None, None
        i = max(t.placements)
        from PIL import Image
        import io
        return t.placements[i], Image.open(io.BytesIO(t.images[i])).size

try:
    # --- attach, browse
    a = termium("--profile", prof, f"{BASE}/page.html")
    check("first attach starts the session and loads the page", a.wait_for(lambda: state() is not None, 30) and a.wait_text("termium test page", 15))
    spid = server_pid()
    check("a session server runs apart from the client", spid is not None and spid != a.pid)
    st_ = os.stat(sockdir); ss = os.stat(os.path.join(sockdir, "default.sock"))
    check("socket dir is 0700 and the socket 0600", stat.S_IMODE(st_.st_mode) == 0o700 and stat.S_IMODE(ss.st_mode) == 0o600,
          (oct(st_.st_mode), oct(ss.st_mode)))
    a.wait_idle(0.8, 10)
    inp = page_eval("(() => { const r = document.getElementById('inp').getBoundingClientRect(); return [r.x + 10, r.y + r.height/2]; })()")
    a.click(220 + int(inp[0]), 40 + int(inp[1])); time.sleep(0.3)
    a.type("kept text"); time.sleep(0.5)
    check("typing before detaching", (state() or {}).get("inp") == "kept text", state() and state().get("inp"))
    a.key("ctrl+b"); a.key("question")
    check("help lists the detach key", a.wait_text("detach", 5))
    a.key("escape"); time.sleep(0.5)

    # --- detach
    a.key("ctrl+b"); a.key("d")
    code = exit_code(a)
    check("Ctrl+B d detaches: the client exits 0", code == 0, code)
    check("detaching restores the terminal and says so", restored(a) and "[detached (from session default)]" in output(a), output(a)[-200:])
    check("only its own pictures are ever deleted (no delete-all)", b"a=d,d=A" not in bytes(a.raw))
    time.sleep(1)
    check("the server survives the detach", server_pid() == spid)
    check("the browser survives the detach", helium_on(prof) > 0)
    check("page state is kept while detached", (state() or {}).get("inp") == "kept text", state() and state().get("inp"))
    t0 = time.time(); r = cli("ls"); took = time.time() - t0
    check("ls returns as soon as the session answered", took < 2, round(took, 2))
    check("ls shows the detached session", r.returncode == 0 and "default" in r.stdout and "detached" in r.stdout and str(spid) in r.stdout,
          (r.returncode, r.stdout, r.stderr))

    # --- re-attach at another size (and another cell size)
    b = termium("attach", cols=100, rows=30, cell_w=12, cell_h=24)
    check("re-attach draws the page", b.wait_frames(1, 15))
    b.wait_idle(0.8, 10); time.sleep(1.5)
    check("re-attach starts from a clean screen (without deleting anyone else's pictures)",
          b"\x1b[2J" in bytes(b.raw) and b"\x1b_Ga=d,d=A" not in bytes(b.raw))
    check("re-attach redraws the chrome", "termium test page" in b.line(1) and "SPACES" in b.text(), b.line(1))
    pl, size = newest_image(b)
    check("re-attach places the page in the new pane", pl == (3, 23, 78, 28), pl)
    # (±1: at a fractional scale the CSS viewport rounds, 538 x 1.25 = 672.5)
    check("re-attach frames have the new device size", size and abs(size[0] - 78 * 12) <= 1 and abs(size[1] - 28 * 24) <= 1, size)
    s = state() or {}
    dsf = 1.25  # cell height 24
    check("the page's viewport follows the new terminal", abs(s.get("w", 0) - 78 * 12 / dsf) <= 1 and abs(s.get("h", 0) - 28 * 24 / dsf) <= 1,
          (s.get("w"), s.get("h")))
    inp = page_eval("(() => { const r = document.getElementById('inp').getBoundingClientRect(); return [r.x + r.width - 5, r.y + r.height/2]; })()")
    b.click(22 * 12 + int(inp[0] * dsf), 2 * 24 + int(inp[1] * dsf)); time.sleep(0.3)
    b.key("end"); b.type(" more"); time.sleep(0.6)
    check("input works after re-attaching", (state() or {}).get("inp") == "kept text more", state() and state().get("inp"))
    b.resize(110, 32); time.sleep(2.5)
    s = state() or {}
    check("resizing the re-attached terminal resizes the page", abs(s.get("w", 0) - 88 * 12 / dsf) <= 1, (s.get("w"), s.get("h")))

    # --- no frame without its picture: every clear or image delete is inside a synchronized update
    mark = len(b.raw)
    b.key("ctrl+t"); time.sleep(1); b.type(f"{BASE}/page.html?second=1"); b.key("enter"); time.sleep(3)
    for k in ("n", "n", "b", "b", "z"):
        b.key("ctrl+b"); b.key(k); time.sleep(0.8)
    b.key("ctrl+w"); time.sleep(1.5)
    check("tab switches, sidebar, new and closed tabs never clear outside a synchronized update", not b.unsynced_clears(mark),
          b.unsynced_clears(mark)[:5])
    check("...and the whole attached session neither", not b.unsynced_clears(), b.unsynced_clears()[:5])

    # --- takeover by a second client
    c = termium("attach", cols=120, rows=36)
    code = exit_code(b)
    check("a second attach takes over: the first client exits 0", code == 0, code)
    check("the first client is told why", restored(b) and "attached from another terminal" in output(b), output(b)[-200:])
    check("the new client draws", c.wait_frames(1, 15))
    time.sleep(1)
    pl, size = newest_image(c)
    check("the new client has its own geometry", pl == (3, 23, 98, 34) and size == (980, 680), (pl, size))
    c.type("!"); time.sleep(0.6)
    check("input goes to the new client's session", (state() or {}).get("inp", "").endswith("!"), state() and state().get("inp"))

    # --- the client's terminal dies (pane closed: hangup)
    os.close(c.fd)
    code = exit_code(c)
    check("a client whose terminal closed exits", code is not None, code)
    time.sleep(1)
    check("the server survives its client's terminal closing", server_pid() == spid and helium_on(prof) > 0)
    r = cli("ls")
    check("...and is detached", "detached" in r.stdout, r.stdout)
    d = termium("attach")
    check("re-attach after a hangup works", d.wait_frames(1, 15))
    os.kill(d.pid, signal.SIGKILL); os.waitpid(d.pid, 0); d.alive = False
    time.sleep(1)
    check("the server survives its client being SIGKILLed", server_pid() == spid and "detached" in cli("ls").stdout)

    # --- the server dies under an attached client
    e = termium("attach")
    check("attach before killing the server", e.wait_frames(1, 15))
    os.kill(spid, signal.SIGKILL)
    code = exit_code(e)
    check("a client whose server died exits with an error", code == 1, code)
    check("...restores the terminal and says what happened", restored(e) and "lost the session" in output(e), output(e)[-300:])
    check("the dead server left its socket behind (precondition)", os.path.exists(os.path.join(sockdir, "default.sock")))
    r = cli("ls")
    check("ls cleans up a dead server's socket", r.returncode == 1 and "no sessions" in r.stderr
          and not os.path.exists(os.path.join(sockdir, "default.sock")) and not os.path.exists(os.path.join(sockdir, "default.pid")),
          (r.returncode, r.stdout, r.stderr))
    f = termium("--profile", prof)
    check("a new session starts on the profile the dead server left", at_address_bar(f))
    fpid = server_pid()

    # --- options and errors
    g = termium("--incognito")
    check("launch options can't change a running session", exit_code(g, 15) == 2 and "already running" in output(g), output(g)[-300:])
    h = termium("attach", "nope")
    check("attaching to a missing session is an error", exit_code(h, 15) == 1 and 'no session "nope"' in output(h), output(h)[-300:])
    u = termium(f"127.0.0.1:{PORT}/page.html?second=1")  # a bare host, as typed
    check("a URL given to a running session opens in a new tab", u.wait_for(lambda: "2 pages" in cli("ls").stdout, 20), (u.line(1), cli("ls").stdout))
    def second_loaded():
        r = subprocess.run(["bun", os.path.join(ROOT, "tests/support/cdp-eval.ts"), prof, "document.title"], capture_output=True, text=True, timeout=20)
        return any("second=1" in p["url"] and p["value"] == "termium test page" for p in json.loads(r.stdout or "[]"))
    check("...and a bare host:port/path loads (as on a fresh start)", u.wait_for(second_loaded, 20, 0.5))
    check("...and took over the earlier client", exit_code(f) == 0)

    # --- kill
    t0 = time.time(); r = cli("kill"); took = time.time() - t0
    check("kill ends the session", r.returncode == 0, (r.returncode, r.stderr))
    check("kill returns once the session has ended (no idle wait)", took < 10, round(took, 2))
    code = exit_code(u)
    check("the attached client exits when its session is killed", code == 0 and restored(u), code)
    check("kill stops the browser", helium_on(prof) == 0)
    check("kill removes the socket", server_pid() is None and not os.path.exists(os.path.join(sockdir, "default.sock")))
    r = cli("kill")
    check("kill of a missing session is an error", r.returncode == 1 and "no session" in r.stderr, (r.returncode, r.stderr))

    # --- named sessions side by side
    one = termium("-s", "one", "--incognito")
    two = termium("-s", "two", "--incognito")
    check("two named sessions run at once", at_address_bar(one) and at_address_bar(two))
    one.key("ctrl+b"); one.key("d"); exit_code(one)
    r = cli("ls")
    lines = r.stdout.strip().splitlines()
    check("ls lists both, one detached and one attached", len(lines) == 2 and lines[0].startswith("one") and "detached" in lines[0]
          and lines[1].startswith("two") and "attached" in lines[1] and "(incognito)" in lines[1], r.stdout)
    check("kill NAME ends only that session", cli("kill", "one").returncode == 0 and server_pid("one") is None and server_pid("two") is not None)
    two.close()
    check("Ctrl+Q ends the session", server_pid("two") is None and not os.path.exists(os.path.join(sockdir, "two.sock")), os.listdir(sockdir))

    # --- several termiums starting the same session at once: one server, the others attach to it
    import glob
    leftovers = lambda: set(glob.glob(os.path.join(TMPD, "tmb-*")) + glob.glob(os.path.join(TMPD, "termium-incognito-*")))
    before_tmp = leftovers()
    RACE = f"race{os.getpid()}"  # unique: the pgrep below can only match this run's server
    racers = [termium("-s", RACE, "--incognito") for _ in range(3)]
    time.sleep(12)
    servers = subprocess.run(["pgrep", "-f", "--", f"__server --session {RACE} "], capture_output=True, text=True).stdout.split()
    check("racing starts: exactly one server", len(servers) == 1, servers)
    check("racing starts: its socket, pid file and lock are in place", all(os.path.exists(os.path.join(sockdir, f"{RACE}.{x}")) for x in ("sock", "pid", "lock"))
          and server_pid(RACE) == (int(servers[0]) if servers else None))
    check("racing starts: ls lists it", RACE in cli("ls").stdout)
    errs = [output(x)[-300:] for x in racers if "termium:" in output(x)]
    check("racing starts: no client failed", not errs, errs)
    live = [x for x in racers if exit_code(x, 0.5) is None]
    check("racing starts: one client is attached and draws, the others were taken over", len(live) == 1 and live[0].frames > 0,
          [(exit_code(x, 0.1), x.frames) for x in racers])
    check("kill race", cli("kill", RACE).returncode == 0 and server_pid(RACE) is None)
    time.sleep(1)
    check("racing starts: no temp dirs left behind", not (leftovers() - before_tmp), leftovers() - before_tmp)

    # --- a hung (stopped) server never traps a terminal, and ls/kill say so
    hz = termium("-s", "hung", "--incognito")
    check("hung: session starts", at_address_bar(hz))
    hpid = server_pid("hung")
    os.kill(hpid, signal.SIGSTOP)
    try:
        t0 = time.time(); r = cli("ls"); took = time.time() - t0
        check("hung: ls reports it as not responding", "hung" in r.stdout and "not responding" in r.stdout and took < 6, (r.stdout, r.stderr, took))
        hz.key("ctrl+b"); hz.key("d")
        code = exit_code(hz, 8)
        check("hung: Ctrl+B d still lets the terminal go", code == 1 and restored(hz) and "isn't responding" in output(hz), (code, output(hz)[-200:]))
        h2 = termium("attach", "hung")
        code = exit_code(h2, 12)
        check("hung: attach gives up with a clear error", code == 1 and restored(h2) and "isn't responding" in output(h2), (code, output(h2)[-200:]))
        t0 = time.time(); r = cli("kill", "hung"); took = time.time() - t0
        check("hung: kill ends it anyway", r.returncode == 0 and "wasn't responding" in r.stderr and took < 10, (r.returncode, r.stderr, took))
        time.sleep(0.5)
        check("hung: its server is gone and its files removed", server_pid("hung") is None
              and not any(os.path.exists(os.path.join(sockdir, f"hung.{x}")) for x in ("sock", "pid", "lock")), os.listdir(sockdir))
    finally:
        try:
            os.kill(hpid, signal.SIGKILL)
        except OSError:
            pass

    # --- a message the session can't handle is logged, not a reason to drop the terminal
    hv = termium("-s", "handler", "--incognito")
    check("handler: session starts", at_address_bar(hv))
    import struct as _struct
    def frame(msg):
        b = json.dumps(msg).encode()
        return bytes([1]) + _struct.pack(">I", len(b)) + b
    so = socket.socket(socket.AF_UNIX); so.connect(os.path.join(sockdir, "handler.sock")); so.settimeout(5)
    so.sendall(frame({"t": "hello", "v": 1, "kind": "attach", "cols": 100, "rows": 30, "cellW": 10, "cellH": 20}))
    so.sendall(frame({"t": "input", "ev": {"type": "key"}}))  # no mods, no key: the handler throws
    so.sendall(frame({"t": "input", "ev": {"type": "mouse"}}))
    # an attach this big (4096 x 4096 cells of 256 px) is drawn for at a capped size, not tried
    so.sendall(frame({"t": "hello", "v": 1, "kind": "attach", "cols": 4096, "rows": 4096, "cellW": 256, "cellH": 256}))
    so.sendall(frame({"t": "ping"}))
    got = b""
    end = time.time() + 5
    while b'"pong"' not in got and time.time() < end:
        try:
            chunk = so.recv(1 << 20)
        except socket.timeout:
            break
        if not chunk:
            break
        got += chunk
    check("handler: a bad input event doesn't drop the client", b'"pong"' in got)
    so.close()
    t0 = time.time(); r = cli("ls")
    check("handler: a huge attach doesn't stall the session", "handler" in r.stdout and "not responding" not in r.stdout and time.time() - t0 < 5, r.stdout)
    check("kill handler", cli("kill", "handler").returncode == 0)

    # --- named sessions have their own profiles: `termium -s NAME` runs next to the default one
    d0 = termium()
    check("profiles: the default session starts", at_address_bar(d0))
    w1 = termium("-s", "work")
    check("profiles: `-s work` starts while the default runs", at_address_bar(w1) and exit_code(w1, 0.5) is None, output(w1)[-300:])
    r = cli("ls")
    check("profiles: each session uses its own profile",
          os.path.join(tmp, "data", "termium", "profile") in r.stdout and os.path.join(tmp, "data", "termium", "profiles", "work") in r.stdout, r.stdout)
    w1.close(); d0.close()

    # --- a terminal that can't show pictures never ends a session another terminal uses
    class Silent(Term):
        """A terminal that never answers (so its client gives up only after its timeout)."""
        def _answer_queries(self, data):
            pass
    ng = Silent(["bun", main, "-s", "shared", "--incognito"], cwd=ROOT, env=ENV)
    other = termium("-s", "shared", "--incognito")  # started at the same moment: attaches to the same session
    check("abandon: another terminal attaches while the first is still checking", other.wait_frames(1, 30) or at_address_bar(other, 5))
    code = exit_code(ng, 15)
    check("abandon: the terminal without graphics gives up", code == 1 and "kitty graphics" in output(ng), (code, output(ng)[-200:]))
    check("abandon: (the other terminal attached to that session)", "shared" in cli("ls").stdout and "attached" in cli("ls").stdout)
    time.sleep(2)
    check("abandon: ...without ending the session the other terminal uses", server_pid("shared") is not None and exit_code(other, 0.5) is None)
    other.close()

    # --- a URL from a client racing the session's start isn't lost
    first = termium("-s", "urlrace")
    time.sleep(0.12)
    second = termium("-s", "urlrace", f"{BASE}/page.html?third=1")
    check("url race: the second client's URL opens as a tab", second.wait_for(lambda: "2 pages" in cli("ls").stdout, 30), cli("ls").stdout)
    for x in (first, second):
        if x.alive and exit_code(x, 0.1) is None:
            x.close()
    cli("kill", "urlrace")

    # --- takeover doesn't inherit the old terminal's half-typed prefix
    p1 = termium("-s", "prefix", "--incognito")
    check("prefix: session starts", at_address_bar(p1))
    p1.key("escape"); time.sleep(0.3)
    p1.key("ctrl+b"); time.sleep(0.5)  # prefix pending on terminal 1
    p2 = termium("attach", "prefix")
    check("prefix: takeover draws", p2.wait_for(lambda: "SPACES" in p2.text(), 20))
    time.sleep(1)
    p2.key("d"); time.sleep(2.5)
    check("prefix: a plain d on the new terminal doesn't detach it", exit_code(p2, 0.5) is None, output(p2)[-200:])
    p2.close()

    # ================================================================ terminals coming and going mid-input
    r3prof = os.path.join(tmp, "r3prof")
    r3state = lambda: page_eval("window.termiumState ? termiumState() : null", profile=r3prof)
    dir_a = os.path.join(tmp, "dir-a"); dir_b = os.path.join(tmp, "dir-b")
    os.makedirs(dir_a); os.makedirs(dir_b)
    open(os.path.join(dir_b, "only-in-b.txt"), "w").write("b")
    c1 = Term(["bun", main, "-s", "r3", "--profile", r3prof, f"{BASE}/page.html"], cwd=dir_a, env=ENV)
    check("r3: session starts", c1.wait_for(lambda: r3state() is not None, 30))
    c1.wait_idle(0.8, 10); time.sleep(1)
    check("r3: the session's pid file is private (0600)", stat.S_IMODE(os.stat(os.path.join(sockdir, "r3.pid")).st_mode) == 0o600)
    inp = page_eval("(() => { const r = document.getElementById('inp').getBoundingClientRect(); return [r.x + 10, r.y + r.height/2]; })()", profile=r3prof)
    c1.click(220 + int(inp[0]), 40 + int(inp[1])); time.sleep(0.3)
    clicks0 = (r3state() or {}).get("clicks", 0)
    btn = page_eval("(() => { const r = document.getElementById('btn').getBoundingClientRect(); return [r.x + r.width/2, r.y + r.height/2]; })()", profile=r3prof)
    c1.key("q", release=False); time.sleep(0.3)  # held
    c1.mouse(220 + int(btn[0]), 40 + int(btn[1]), 0, "press"); time.sleep(0.3)  # held
    check("r3: (precondition) the page saw the key go down", "down q" in (r3state() or {}).get("log", ""))
    c2 = Term(["bun", main, "attach", "r3"], cwd=dir_b, env=ENV)  # takes over, from another directory
    check("r3: takeover attaches", c2.wait_frames(1, 20))
    time.sleep(1)
    st3 = r3state() or {}
    check("r3: a key held on the old terminal is released on the page", "up q" in st3.get("log", ""), st3.get("log", "")[-120:])
    check("r3: a mouse button held on the old terminal is released on the page", st3.get("clicks", 0) == clicks0 + 1, (clicks0, st3.get("clicks")))
    fl = page_eval("(() => { const r = document.getElementById('file').getBoundingClientRect(); return [r.x + 10, r.y + r.height/2]; })()", profile=r3prof)
    c2.click(220 + int(fl[0]), 40 + int(fl[1]))
    check("r3: file chooser on the new terminal", c2.wait_text("Upload file:", 5), c2.line(2))
    c2.key("ctrl+a"); c2.key("ctrl+k"); c2.type("only-in-b.txt"); c2.key("enter"); time.sleep(1)
    check("r3: a relative upload path is relative to the attached terminal's directory", (r3state() or {}).get("file") == "only-in-b.txt",
          ((r3state() or {}).get("file"), c2.line(2)))

    # a stuck terminal (it never acknowledges a frame) taken over by one of the same size: the page keeps moving
    c2.key("ctrl+l"); c2.key("ctrl+a"); c2.key("ctrl+k"); c2.type(f"{BASE}/anim.html"); c2.key("enter")
    c2.wait_frames(5, 20)
    stuck_pid = c2.pid
    os.kill(stuck_pid, signal.SIGSTOP)
    time.sleep(3)
    c3 = Term(["bun", main, "attach", "r3"], cwd=dir_b, env=ENV)
    f0 = c3.frames
    check("r3: after taking over from a stuck terminal, frames keep coming", c3.wait_for(lambda: c3.frames - f0 >= 10, 15), c3.frames - f0)
    os.kill(stuck_pid, signal.SIGKILL); os.waitpid(stuck_pid, 0); c2.alive = False

    # re-attaching smaller after the page changed while detached: no stale or wrong-size picture first
    c3.key("ctrl+l"); c3.key("ctrl+a"); c3.key("ctrl+k"); c3.type(f"{BASE}/page.html?r3=1"); c3.key("enter")
    c3.wait_for(lambda: any("r3=1" in p["url"] and p["value"] for p in json.loads(subprocess.run(
        ["bun", os.path.join(ROOT, "tests/support/cdp-eval.ts"), r3prof, "1"], capture_output=True, text=True, timeout=20).stdout or "[]")), 20)
    time.sleep(2)
    c3.key("ctrl+b"); c3.key("d"); exit_code(c3)
    page_eval("(() => { document.body.innerHTML = ''; document.body.style.background = 'rgb(200, 0, 0)'; return 1; })()", profile=r3prof)
    c4 = Term(["bun", main, "attach", "r3"], cwd=dir_b, env=ENV, cols=100, rows=30)
    c4.wait_frames(1, 20); time.sleep(1.5)
    def first_picture(t):
        """The first picture the terminal was sent, decoded."""
        import base64 as _b64, io as _io, re as _re
        from PIL import Image as _Image
        raw = bytes(t.raw)
        m = _re.search(rb"\x1b_Ga=T[^;\x1b]*;([^\x1b]*)\x1b\\", raw)
        if not m:
            return None
        data, pos = bytearray(_b64.b64decode(m.group(1))), m.end()
        if b"m=1" in m.group(0)[:60]:
            for c in _re.finditer(rb"\x1b_Gm=(\d);([^\x1b]*)\x1b\\", raw[pos:]):
                data += _b64.b64decode(c.group(2))
                if c.group(1) == b"0":
                    break
        return _Image.open(_io.BytesIO(bytes(data))).convert("RGB")
    im = first_picture(c4)
    check("r3: the first picture after re-attaching is current and at the new size",
          im is not None and im.size == (78 * 10, 28 * 20) and im.getpixel((im.width // 2, im.height // 2))[0] > 150,
          im and (im.size, im.getpixel((im.width // 2, im.height // 2))))
    c4.close()

    # a slow browser start: the first terminal's queued Ctrl+B d isn't replayed on the one that took over
    helium = shutil.which("helium-browser") or shutil.which("helium")
    slow = os.path.join(tmp, "slow-browser")
    with open(slow, "w") as f:
        f.write(f'#!/bin/sh\nsleep 5\nexec "{helium}" "$@"\n')
    os.chmod(slow, 0o755)
    q1 = termium("-s", "r3b", "--incognito", "--browser", slow)
    q1.wait_for(lambda: server_pid("r3b") is not None and os.path.exists(os.path.join(sockdir, "r3b.sock")), 15); time.sleep(1.5)
    q1.key("ctrl+b"); q1.key("d"); time.sleep(0.5)  # queued: the browser isn't up yet
    q2 = termium("attach", "r3b")
    time.sleep(12)
    check("r3: input queued by the old terminal during startup isn't replayed on the new one",
          exit_code(q2, 0.5) is None and "SPACES" in q2.text(), output(q2)[-200:])
    q2.close()

    # kill when both the server and its browser are stopped
    k1 = termium("-s", "r3k", "--incognito")
    check("r3: session to kill starts", at_address_bar(k1))
    kpid = server_pid("r3k")
    ps = subprocess.run(["ps", "-A", "-o", "pid=,ppid="], capture_output=True, text=True).stdout.split("\n")
    kids = {}
    for line in ps:
        parts = line.split()
        if len(parts) == 2:
            kids.setdefault(int(parts[1]), []).append(int(parts[0]))
    family, todo = [], [kpid]
    while todo:
        x = todo.pop(); family.append(x); todo += kids.get(x, [])
    for x in family:
        os.kill(x, signal.SIGSTOP)
    t0 = time.time(); r = cli("kill", "r3k"); took = time.time() - t0
    def alive_pid(x):
        try:
            os.kill(x, 0); return True
        except OSError:
            return False
    time.sleep(0.5)
    check("r3: kill ends a stopped server and its stopped browser", r.returncode == 0 and not any(alive_pid(x) for x in family) and took < 15,
          (r.returncode, r.stderr, [x for x in family if alive_pid(x)], took))
    check("r3: ...and says what it had to do", "killed its server" in r.stderr, r.stderr)
    exit_code(k1, 5)

    # picture files of a client killed outright are cleaned up; those of live ones aren't
    shm = "/dev/shm" if os.path.isdir("/dev/shm") else tempfile.gettempdir()
    dead = os.path.join(shm, "termium-tty-graphics-protocol-999999-" + "ab" * 16)
    live = os.path.join(shm, f"termium-tty-graphics-protocol-{os.getpid()}-" + "cd" * 16)
    for f in (dead, live):
        open(f, "w").close()
    cli("ls")
    check("r3: a dead client's picture files are removed, a live one's kept", not os.path.exists(dead) and os.path.exists(live))
    os.remove(live)

    # a big frame before hello is refused (the connection dropped), and the session carries on
    bf = termium("-s", "r3f", "--incognito")
    check("r3: a session for the oversized frame", at_address_bar(bf))
    big = socket.socket(socket.AF_UNIX); big.connect(os.path.join(sockdir, "r3f.sock")); big.settimeout(5)
    import struct as _st
    big.sendall(bytes([1]) + _st.pack(">I", 50_000_000) + b"x" * 1000)
    try:
        closed = big.recv(10) == b""
    except (socket.timeout, ConnectionResetError):
        closed = False
    big.close()
    check("r3: a frame of 50 MB before hello closes that connection", closed)
    check("r3: ...and the session still answers", "r3f" in cli("ls").stdout and exit_code(bf, 0.5) is None)
    bf.close()

    # --- a screencast that fails to start (Chrome: "not attached to an active page", mid-replacement)
    # is started again: the pane still shows the page and its changes
    page_turns_blue = "data:text/html,<body style='background:rgb(0,200,0)'><script>setTimeout(() => document.body.style.background = 'rgb(0,0,200)', 4000)</script>"
    fc = Term(["bun", main, "-s", "castfail", "--incognito", page_turns_blue], cwd=ROOT, env=dict(ENV, TERMIUM_TEST_FAIL_CASTS="3"))
    centre = lambda: (lambda im: im.getpixel((im.width // 2, im.height // 2)) if im else None)(fc.latest_image())
    check("cast retry: the page shows although the first screencast starts failed", fc.wait_for(lambda: (centre() or (0, 0, 0))[1] > 150, 30), centre())
    check("cast retry: ...and its later changes show (the screencast runs)", fc.wait_for(lambda: (centre() or (0, 0, 0))[2] > 150, 15), centre())
    fc.close()

    # --- frames of every shape and scale are shown, not taken for stale ones (fractional scales,
    # very wide and short or tall and narrow panes, zoom, HiDPI): a page's change always shows
    for i, (cols, rows, cw, ch, extra, zoom) in enumerate([
            (160, 4, 10, 20, ["--scale", "0.75"], False), (160, 4, 10, 20, ["--scale", "0.5"], False),
            (30, 60, 10, 20, ["--scale", "1.25"], False), (30, 60, 10, 20, ["--scale", "1.5"], False),
            (120, 30, 10, 20, ["--scale", "1.5"], True), (200, 6, 20, 40, [], False), (24, 50, 20, 40, [], True)]):
        sh = Term(["bun", main, "-s", f"shape{i}", "--incognito", *extra, page_turns_blue], cwd=ROOT, env=ENV, cols=cols, rows=rows, cell_w=cw, cell_h=ch)
        mid = lambda: (lambda im: im.getpixel((im.width // 2, im.height // 2)) if im else None)(sh.latest_image())
        shown = sh.wait_for(lambda: (mid() or (0, 0, 0))[1] > 150, 30)
        if zoom:
            sh.key("alt+equal"); time.sleep(0.5)
        what = f"{cols}x{rows} cell {cw}x{ch} {' '.join(extra) or 'default scale'}{' zoomed' if zoom else ''}"
        check(f"shapes: {what}: the page shows, then its change", shown and sh.wait_for(lambda: (mid() or (0, 0, 0))[2] > 150, 15), mid())
        sh.close()

    # --- a stale socket from a server that never cleaned up (and an error file of a client killed outright)
    open(os.path.join(sockdir, "gone.999999.err"), "w").write("x")
    cli("ls")
    check("ls removes error files of clients that are gone", not os.path.exists(os.path.join(sockdir, "gone.999999.err")))
    stale = os.path.join(sockdir, "stale.sock")
    so = socket.socket(socket.AF_UNIX); so.bind(stale); so.close()
    open(os.path.join(sockdir, "stale.pid"), "w").write("999999\n")
    s1 = termium("-s", "stale", "--incognito")
    check("a session starts over a stale socket", at_address_bar(s1))
    check("...and answers on it", "stale" in cli("ls").stdout)
    s1.close()
finally:
    for t in [x for x in globals().values() if isinstance(x, Term)]:
        if t.alive:
            try:
                t.close()
            except Exception:
                pass
    for name in ("default", "one", "two", "stale", "hung", "handler", "work", "shared", "urlrace", "prefix", "r3", "r3b", "r3k", "r3f", "castfail", *(f"shape{i}" for i in range(7)), f"race{os.getpid()}"):
        pid = server_pid(name)
        if pid:
            os.kill(pid, signal.SIGTERM)
    time.sleep(2)
    srv.terminate()
    shutil.rmtree(tmp, ignore_errors=True)

print("FAILED: " + ", ".join(failures) if failures else "ALL PASSED")
sys.exit(1 if failures else 0)
