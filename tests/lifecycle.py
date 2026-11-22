#!/usr/bin/env python3
"""Startup and shutdown edge cases against the real stack (termium + Helium).

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
    os.kill(a.pid, signal.SIGKILL); os.waitpid(a.pid, 0); a.alive = False
    time.sleep(1)
    check("browser outlives a SIGKILLed termium (precondition)", helium_on(prof) > 0)
    c = Term(["bun", main, "--profile", prof], cwd=ROOT)
    check("restart after SIGKILL reaches the address bar", at_address_bar(c))

    # a relative --profile, killed, then reopened by its absolute path, recovers
    rel_parent = tmp
    r1 = Term(["bun", main, "--profile", "p3"], cwd=rel_parent)
    check("relative profile starts", at_address_bar(r1))
    os.kill(r1.pid, signal.SIGKILL); os.waitpid(r1.pid, 0); r1.alive = False
    time.sleep(1)
    r2 = Term(["bun", main, "--profile", os.path.join(tmp, "p3") + "/"], cwd="/")
    check("reopened by absolute path after SIGKILL", at_address_bar(r2))
    r2.close()

    # two termiums started at the same moment on one profile: one runs, the other refuses
    prof4 = os.path.join(tmp, "p4")
    x = Term(["bun", main, "--profile", prof4], cwd=ROOT)
    y = Term(["bun", main, "--profile", prof4], cwd=ROOT)
    time.sleep(12)
    alive = [z for z in (x, y) if running(z)]
    check("simultaneous start: exactly one survives", len(alive) == 1, [running(x), running(y)])
    if alive:
        check("simultaneous start: the survivor works", at_address_bar(alive[0], 5) and helium_on(prof4) > 0)
        loser = y if alive[0] is x else x
        check("simultaneous start: the other says why", "in use" in output(loser), output(loser)[-200:])
        alive[0].close()

    # killed during startup, after the browser took the profile but before the terminal answered
    class SlowTerminal(Term):
        def _answer_queries(self, data):
            threading.Timer(3.0, Term._answer_queries, (self, data)).start()
    prof5 = os.path.join(tmp, "p5")
    k = SlowTerminal(["bun", main, "--profile", prof5], cwd=ROOT)
    t0 = time.time()
    while time.time() - t0 < 10 and not os.path.lexists(os.path.join(prof5, "SingletonLock")):
        time.sleep(0.05)
    os.kill(k.pid, signal.SIGKILL); os.waitpid(k.pid, 0); k.alive = False
    time.sleep(1)
    k2 = Term(["bun", main, "--profile", prof5], cwd=ROOT)
    check("killed mid-startup: next start recovers the profile", at_address_bar(k2))
    k2.close()

    # HiDPI cells: the picture has the pane's full device resolution
    hd = Term(["bun", main, "--incognito", "data:text/html,<h1>sharp</h1>"], cwd=ROOT, cols=100, rows=30, cell_w=20, cell_h=40)
    hd.wait_frames(1, 25); time.sleep(3)
    img = hd.latest_image()
    want = ((100 - 22) * 20, (30 - 2) * 40)
    check("HiDPI frames at full device resolution", img is not None and img.size == want, (img and img.size, want))
    hd.close()

    # garbage input doesn't crash it
    c.write("\x1b[1114112u\x1b[99999999;5u\x1b[;;u\x1b[;;;;;;;u\x1b[<;;M\x1b_Gq=1\x1b\\")
    time.sleep(1.5)
    check("survives garbage input", running(c))

    # Ctrl+Q from the address bar
    c.key("ctrl+q")
    c.wait_for(lambda: not running(c), 10)
    check("ctrl+q quits from the address bar", not running(c) and helium_on(prof) == 0)

    # SIGKILLed incognito session: the next start removes its profile and browser
    i1 = Term(["bun", main, "--incognito"], cwd=ROOT)
    check("incognito starts", at_address_bar(i1))
    inc = [d for d in glob.glob(f"/tmp/termium-incognito-{i1.pid}-*")]
    check("incognito profile is in the temp dir", len(inc) == 1, inc)
    os.kill(i1.pid, signal.SIGKILL); os.waitpid(i1.pid, 0); i1.alive = False
    time.sleep(1)
    i2 = Term(["bun", main, "--incognito"], cwd=ROOT)
    check("next start after a killed incognito session works", at_address_bar(i2))
    check("killed incognito session's profile removed", inc and not os.path.exists(inc[0]), inc)
    check("killed incognito session's browser stopped", inc and helium_on(inc[0]) == 0)
    i2.close()

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
    shutil.rmtree(tmp, ignore_errors=True)

print("FAILED: " + ", ".join(failures) if failures else "ALL PASSED")
sys.exit(1 if failures else 0)
