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
ENV = {"XDG_RUNTIME_DIR": rt, "TERMIUM_TEST_DEVTOOLS_PORT": "1"}
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
    time.sleep(1)
    check("the server survives the detach", server_pid() == spid)
    check("the browser survives the detach", helium_on(prof) > 0)
    check("page state is kept while detached", (state() or {}).get("inp") == "kept text", state() and state().get("inp"))
    r = cli("ls")
    check("ls shows the detached session", r.returncode == 0 and "default" in r.stdout and "detached" in r.stdout and str(spid) in r.stdout,
          (r.returncode, r.stdout, r.stderr))

    # --- re-attach at another size (and another cell size)
    b = termium("attach", cols=100, rows=30, cell_w=12, cell_h=24)
    check("re-attach draws the page", b.wait_frames(1, 15))
    b.wait_idle(0.8, 10); time.sleep(1.5)
    check("re-attach starts from a clean screen", b"\x1b_Ga=d,d=A" in bytes(b.raw) and b"\x1b[2J" in bytes(b.raw))
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
    u = termium(f"{BASE}/page.html?second=1")
    check("a URL given to a running session opens in a new tab", u.wait_for(lambda: "2 pages" in cli("ls").stdout, 20), (u.line(1), cli("ls").stdout))
    check("...and took over the earlier client", exit_code(f) == 0)

    # --- kill
    r = cli("kill")
    check("kill ends the session", r.returncode == 0, (r.returncode, r.stderr))
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

    # --- a stale socket from a server that never cleaned up
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
    for name in ("default", "one", "two", "stale"):
        pid = server_pid(name)
        if pid:
            os.kill(pid, signal.SIGTERM)
    time.sleep(2)
    srv.terminate()
    shutil.rmtree(tmp, ignore_errors=True)

print("FAILED: " + ", ".join(failures) if failures else "ALL PASSED")
sys.exit(1 if failures else 0)
