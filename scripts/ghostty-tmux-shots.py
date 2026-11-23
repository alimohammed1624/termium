#!/usr/bin/env python3
"""Screenshots of termium inside tmux, in a real Ghostty window.

    scripts/screenshots.sh tmux      # opens Ghostty and runs this inside it

Runs inside the Ghostty window: starts a private tmux server (its own -L
socket and config, allow-passthrough on) with termium in a split next to a
shell, takes tmux-split.png, detaches termium (Ctrl+B Ctrl+B d), re-attaches
it from a second tmux window of another size and takes tmux-reattach.png.
The tmux server, the session and the profile are removed afterwards.
"""
import fcntl, json, os, shutil, struct, subprocess, sys, tempfile, termios, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)
SOCK = f"termium-shots-{os.getpid()}"
tmp = tempfile.mkdtemp(prefix="termium-tmux-shots-")
profile = os.path.join(tmp, "profile")
conf = os.path.join(tmp, "tmux.conf")
with open(conf, "w") as f:
    f.write("set -g allow-passthrough on\nset -g status-style 'bg=#313244,fg=#cdd6f4'\nset -g escape-time 10\n")
env = dict(os.environ, XDG_RUNTIME_DIR=os.path.join(tmp, "run"))
os.makedirs(env["XDG_RUNTIME_DIR"], mode=0o700)
env.pop("TMUX", None)

rows, cols, xpix, ypix = struct.unpack("HHHH", fcntl.ioctl(0, termios.TIOCGWINSZ, b"\0" * 8))

def tmux(*args):
    return subprocess.run(["tmux", "-L", SOCK, *args], env=env, capture_output=True, text=True)

# `termium` in the panes must be this checkout, never an installed binary
# that the shell's startup files may put first on PATH.
USE_CHECKOUT = f"termium() {{ bun '{ROOT}/src/main.ts' \"$@\"; }}; clear"

def run(pane, cmd):
    tmux("send-keys", "-t", pane, cmd, "Enter")

class WrongWindow(Exception):
    pass

def activate():
    """Asks KWin (if there is one) to give this window focus: Spectacle captures the active window."""
    if not shutil.which("qdbus6"):
        return
    path = os.path.join(tmp, "activate.js")
    with open(path, "w") as f:
        f.write("for (const w of workspace.windowList()) { if (w.caption.indexOf(%s) >= 0) { workspace.activeWindow = w; } }"
                % json.dumps("termium screenshots"))
    q = lambda *a: subprocess.run(["qdbus6", "org.kde.KWin", "/Scripting", *a], capture_output=True, text=True)
    name = f"termium-shots-{os.getpid()}"
    q("org.kde.kwin.Scripting.unloadScript", name)
    q("org.kde.kwin.Scripting.loadScript", path, name)
    q("org.kde.kwin.Scripting.start")
    time.sleep(0.3)
    q("org.kde.kwin.Scripting.unloadScript", name)

def shot(name):
    """Captures the active window, and keeps it only if it is this Ghostty window (see ghostty-shots.py)."""
    activate()
    time.sleep(0.6)
    path = os.path.join(OUT, name)
    tmp_png = path + ".new.png"
    subprocess.run(["spectacle", "-b", "-n", "-a", "-o", tmp_png], check=False)
    time.sleep(0.4)
    from PIL import Image
    try:
        w, h = Image.open(tmp_png).size
    except OSError:
        raise WrongWindow(f"no capture for {name}")
    if not (xpix <= w <= xpix + 120 and ypix <= h <= ypix + 160):
        os.remove(tmp_png)
        raise WrongWindow(f"{name}: captured a {w}x{h} window, expected about {xpix}x{ypix}; "
                          "the termium window lost focus, capture deleted")
    os.replace(tmp_png, path)

attach = None
try:
    tmux("-f", conf, "new-session", "-d", "-s", "shots", "-n", "browse", "-x", str(cols), "-y", str(rows), "-c", ROOT)
    tmux("split-window", "-h", "-l", "38%", "-t", "shots:browse", "-c", ROOT)
    time.sleep(1.5)  # shells starting
    for pane in ("shots:browse.0", "shots:browse.1"):
        run(pane, USE_CHECKOUT)
    time.sleep(0.5)
    run("shots:browse.1", "tmux -V; git --no-pager log --oneline -4")
    run("shots:browse.0", f"termium --profile {profile} https://en.wikipedia.org/wiki/Tmux")
    tmux("select-pane", "-t", "shots:browse.0")
    attach = subprocess.Popen(["tmux", "-L", SOCK, "attach", "-t", "shots"], env=env)
    time.sleep(14)
    run("shots:browse.1", "termium ls")
    time.sleep(2)
    shot("tmux-split.png")

    # detach termium (C-b goes to the pane, as Ctrl+B Ctrl+B does from the keyboard)
    tmux("send-keys", "-t", "shots:browse.0", "C-b", "d")
    time.sleep(2)
    tmux("new-window", "-t", "shots", "-n", "reattached", "-c", ROOT)
    time.sleep(1.5)
    run("shots:reattached", USE_CHECKOUT)
    time.sleep(0.5)
    run("shots:reattached", "termium attach")
    time.sleep(6)
    shot("tmux-reattach.png")
except WrongWindow as e:
    with open(os.path.join(OUT, "screenshots-error.txt"), "w") as f:
        f.write(str(e) + "\n")
finally:
    subprocess.run(["bun", f"{ROOT}/src/main.ts", "kill"], env=env, capture_output=True, timeout=30)
    tmux("kill-server")
    if attach:
        attach.wait(timeout=10)
    shutil.rmtree(tmp, ignore_errors=True)
