#!/usr/bin/env python3
"""termium inside tmux and inside herdr, against the real stack.

The outer terminal is drive.Term (it answers like Ghostty and composites
kitty graphics, including virtual placements shown through unicode
placeholders). Inside it run a private tmux server (its own -L socket and
config) and then a private, uniquely named herdr session; termium runs in
their panes. Neither touches any tmux server or herdr session of the user's.

Checks: the tmux allow-passthrough hint, pictures in a tmux split (through
placeholders, at the pane's position), keyboard input, detach with the
multiplexer's prefix pressed twice, re-attach from another pane of another
size, pane zoom, and the same in herdr (which re-renders images itself).

Usage: python3 tests/multiplexers.py [outdir]   (screenshots land in outdir)
"""
import json, os, shutil, signal, socket, subprocess, sys, tempfile, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
from drive import Term

failures = []
def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))
    if not cond:
        failures.append(name)

main = os.path.join(ROOT, "src", "main.ts")
OUT = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="termium-mux-")
os.makedirs(OUT, exist_ok=True)
tmp = tempfile.mkdtemp(prefix="tmx-")
rt = os.path.join(tmp, "run"); os.makedirs(rt)
ENV = {"XDG_RUNTIME_DIR": rt, "TERMIUM_TEST_DEVTOOLS_PORT": "1"}
sockdir = os.path.join(rt, "termium")
TMUX_SOCK = f"termium-test-{os.getpid()}"
HERDR = shutil.which("herdr") or os.path.expanduser("~/.local/bin/herdr")
HERDR_SESSION = f"termium-test-{os.getpid()}"
BG = (0x33, 0x33, 0xcc)
PAGE = "data:text/html,<body style=\"background:%233333cc;color:white;font:40px sans-serif\"><h1>termium in a pane</h1>"

with socket.socket() as so:
    so.bind(("127.0.0.1", 0)); PORT = so.getsockname()[1]
srv = subprocess.Popen([shutil.which("python3") or sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1",
                        "--directory", os.path.join(ROOT, "tests", "fixtures")], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.5)
BASE = f"http://127.0.0.1:{PORT}"

def cli(*args):
    return subprocess.run(["bun", main, *args], cwd=ROOT, env=dict(os.environ, **ENV), capture_output=True, text=True, timeout=40)

def tmux(*args):
    return subprocess.run(["tmux", "-L", TMUX_SOCK, *args], capture_output=True, text=True)

def server_pid(session="default"):
    try:
        pid = int(open(os.path.join(sockdir, f"{session}.pid")).read())
        os.kill(pid, 0)
        return pid
    except (OSError, ValueError):
        return None

def state(profile):
    r = subprocess.run(["bun", os.path.join(ROOT, "tests/support/cdp-eval.ts"), profile, "window.termiumState ? termiumState() : null"],
                       capture_output=True, text=True, timeout=20)
    for p in json.loads(r.stdout or "[]"):
        if "page.html" in p["url"] and p["value"]:
            return p["value"]
    return None

def shows_page(t, rect, path):
    """The composited screen has the test page's colour in the middle of rect (row, col, cols, rows)."""
    t.shot(path)
    from PIL import Image
    im = Image.open(path).convert("RGB")
    row, col, cols, rows = rect
    x = (col - 1 + cols // 2) * t.cell_w
    y = (row - 1 + rows // 2) * t.cell_h
    px = im.getpixel((x, y))
    return all(abs(a - b) < 12 for a, b in zip(px, BG)), px

def newest_placement(t):
    with t.lock:
        return t.placements[max(t.placements)] if t.placements else None

def run_in(t, cmd):
    """Types a shell command into the focused pane."""
    t.write(cmd + "\r")

try:
    # ------------------------------------------------------------- tmux
    conf = os.path.join(tmp, "tmux.conf")
    with open(conf, "w") as f:
        f.write("set -g status off\nset -g escape-time 10\n")
    prof = os.path.join(tmp, "tmux-profile")
    t = Term(["tmux", "-L", TMUX_SOCK, "-f", conf, "new-session", "-s", "main", "-x", "160", "-y", "45"],
             cols=160, rows=45, env=ENV)
    time.sleep(1.5)

    tmux("send-keys", "-t", "main", f"cd {ROOT} && bun src/main.ts --profile {prof}; echo EXIT=$?", "Enter")
    check("tmux: passthrough off gives a clear hint", t.wait_text("allow-passthrough", 15) and t.wait_text("EXIT=2", 10),
          tmux("capture-pane", "-p", "-t", "main").stdout[-400:])
    check("tmux: ...and starts no session", server_pid() is None)
    tmux("send-keys", "-t", "main", "clear", "Enter"); time.sleep(0.5)

    tmux("set", "-g", "allow-passthrough", "on")
    tmux("split-window", "-h", "-t", "main")
    tmux("select-pane", "-t", "main.0")
    panes = tmux("list-panes", "-t", "main", "-F", "#{pane_left} #{pane_width} #{pane_height}").stdout.split("\n")
    (l0, w0, h0), (l1, w1, h1) = [tuple(map(int, p.split())) for p in panes[:2]]
    tmux("send-keys", "-t", "main.0", f"bun src/main.ts --profile {prof} '{PAGE}'", "Enter")
    check("tmux: frames arrive through passthrough", t.wait_frames(1, 40))
    want = (3, l0 + 1 + 22, w0 - 22, h0 - 2)
    check("tmux: the page is drawn through placeholders in its pane", t.wait_for(lambda: want in t.placeholder_images().values(), 15),
          (t.placeholder_images(), want))
    time.sleep(1)
    ok, px = shows_page(t, want, f"{OUT}/tmux-split.png")
    check("tmux: the placeholders show the page's picture", ok, px)
    check("tmux: no image is placed at a cell (only virtual placements)", not t.placements, t.placements)

    # keyboard through tmux: address bar, then a page with state
    t.write("\x0c"); time.sleep(0.4)  # Ctrl+L
    t.write(f"{BASE}/page.html\r")
    check("tmux: keyboard input reaches termium", t.wait_for(lambda: state(prof) is not None, 25))

    # detach with tmux's prefix pressed twice (tmux sends one Ctrl+B through)
    spid = server_pid()
    t.write("\x02"); time.sleep(0.2); t.write("\x02"); time.sleep(0.2); t.write("d")
    check("tmux: Ctrl+B Ctrl+B d detaches termium", t.wait_text("[detached (from session default)]", 10),
          tmux("capture-pane", "-p", "-t", "main.0").stdout[-300:])
    check("tmux: the session survives", server_pid() == spid and "detached" in cli("ls").stdout)

    # re-attach from the other pane, which is a different size
    tmux("select-pane", "-t", "main.1")
    tmux("send-keys", "-t", "main.1", f"cd {ROOT} && bun src/main.ts attach", "Enter")
    want = (3, l1 + 1 + 22, w1 - 22, h1 - 2)
    check("tmux: re-attach in another pane draws there at its size", t.wait_for(lambda: want in t.placeholder_images().values(), 20),
          (t.placeholder_images(), want, tmux("capture-pane", "-p", "-t", "main.1").stdout[-600:]))
    check("tmux: re-attach redraws the chrome", t.wait_text("termium test page", 10))
    time.sleep(1.5)
    t.shot(f"{OUT}/tmux-reattached.png")

    tmux("resize-pane", "-Z", "-t", "main.1")
    want = (3, 23, 160 - 22, 45 - 2)
    check("tmux: zooming the pane resizes the page", t.wait_for(lambda: want in t.placeholder_images().values(), 15),
          (t.placeholder_images(), want))
    zoomed = lambda: (state(prof) or {}).get("w") == 160 * 10 - 220 and (state(prof) or {}).get("h") == 43 * 20
    check("tmux: the viewport follows the zoomed pane", t.wait_for(zoomed, 10, 0.5), state(prof) and (state(prof)["w"], state(prof)["h"]))
    t.shot(f"{OUT}/tmux-zoomed.png")

    r = cli("kill")
    check("tmux: kill ends the session", r.returncode == 0 and server_pid() is None, r.stderr)
    tmux("kill-server")
    t.close()

    # ------------------------------------------------------------- herdr
    if not os.path.exists(HERDR):
        print("SKIP herdr: not installed")
    else:
        hprof = os.path.join(tmp, "herdr-profile")
        h = Term([HERDR, "--session", HERDR_SESSION], cols=160, rows=45, env=ENV)
        time.sleep(4)
        run_in(h, f"cd {ROOT} && bun src/main.ts --profile {hprof} '{PAGE}'")
        check("herdr: frames reach the outer terminal", h.wait_frames(1, 40))
        time.sleep(1.5)
        pl = newest_placement(h)
        ok, px = shows_page(h, pl, f"{OUT}/herdr.png") if pl else (False, None)
        check("herdr: the page's picture is placed in the pane", ok, (pl, px))
        spid = server_pid()
        h.write("\x02"); time.sleep(0.3); h.write("\x02"); time.sleep(0.3); h.write("d")
        check("herdr: Ctrl+B Ctrl+B d detaches termium", h.wait_text("[detached (from session default)]", 10), h.text()[:600])
        check("herdr: the session survives", server_pid() == spid and "detached" in cli("ls").stdout)
        hc = lambda *a: subprocess.run([HERDR, "--session", HERDR_SESSION, *a], capture_output=True, text=True)
        import re as _re
        panes = json.loads(hc("pane", "list").stdout or "{}").get("result", {}).get("panes", [])
        first = next((p["pane_id"] for p in panes if p.get("focused")), panes[0]["pane_id"] if panes else "")
        r = hc("pane", "split", first, "--direction", "down", "--cwd", ROOT)
        new = [x for x in _re.findall(r'"pane_id":"([^"]+)"', r.stdout) if x != first]
        time.sleep(2)
        before = h.frames
        hc("pane", "run", new[0] if new else first, "bun src/main.ts attach")
        check("herdr: re-attach from a new, smaller pane draws", h.wait_for(lambda: h.frames > before, 25), r.stdout[-300:] + r.stderr[-300:])
        time.sleep(1.5)
        pl2 = newest_placement(h)
        check("herdr: ...at the new pane's size", pl and pl2 and pl2[3] < pl[3] and pl2[0] > pl[0], (pl, pl2, r.stdout[-300:], r.stderr[-300:], h.text()[-1500:]))
        ok, px = shows_page(h, pl2, f"{OUT}/herdr-reattached.png") if pl2 else (False, None)
        check("herdr: ...showing the page", ok, px)
        r = cli("kill")
        check("herdr: kill ends the session", r.returncode == 0 and server_pid() is None, r.stderr)
finally:
    tmux("kill-server")
    if os.path.exists(HERDR):
        subprocess.run([HERDR, "session", "stop", HERDR_SESSION], capture_output=True)
        time.sleep(1)
        subprocess.run([HERDR, "session", "delete", HERDR_SESSION], capture_output=True)
    for x in [x for x in globals().values() if isinstance(x, Term)]:
        if x.alive:
            try:
                x.close()
            except Exception:
                pass
    pid = server_pid()
    if pid:
        os.kill(pid, signal.SIGTERM)
        time.sleep(3)
    srv.terminate()
    shutil.rmtree(tmp, ignore_errors=True)

print("FAILED: " + ", ".join(failures) if failures else "ALL PASSED")
sys.exit(1 if failures else 0)
