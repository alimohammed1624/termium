#!/usr/bin/env python3
"""Flicker check in a real Ghostty window (manual: needs Ghostty, KDE, Spectacle).

    ghostty --gtk-single-instance=false --window-width=150 --window-height=42 \\
        --title="termium flicker" -e python3 tests/ghostty-flicker.py OUTDIR [direct|tmux]

Runs termium (directly, or inside a private tmux server) in this Ghostty
window and, while it scrolls, types in the address bar, navigates, toggles the
sidebar and switches tabs, captures the window over and over (Spectacle,
active window; KWin is asked to activate this window, and a capture of any
other window is deleted). A capture is "blank" when most of the page area
shows the terminal's own (translucent) background instead of the page's
(opaque) picture. Writes OUTDIR/summary.json and keeps the captures.
"""
import fcntl, json, os, shutil, struct, subprocess, sys, tempfile, termios, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
from drive import Term

OUT = sys.argv[1]
MODE = sys.argv[2] if len(sys.argv) > 2 else "direct"
TITLE = "termium flicker"
os.makedirs(OUT, exist_ok=True)
for f in os.listdir(OUT):
    if f.startswith("f-") and f.endswith(".png"):
        os.remove(os.path.join(OUT, f))
tmp = tempfile.mkdtemp(prefix="termium-flicker-")
rt = os.path.join(tmp, "run"); os.makedirs(rt, mode=0o700)
XDG = {"XDG_RUNTIME_DIR": rt, "XDG_DATA_HOME": os.path.join(tmp, "data"), "XDG_STATE_HOME": os.path.join(tmp, "state")}
env = dict(os.environ, **XDG); env.pop("TMUX", None)
rows, cols, xpix, ypix = struct.unpack("HHHH", fcntl.ioctl(0, termios.TIOCGWINSZ, b"\0" * 8))
cw, ch = xpix // cols, ypix // rows
URL1 = "https://en.wikipedia.org/wiki/Terminal_emulator"
URL2 = "https://en.wikipedia.org/wiki/Tmux"
URL3 = "https://news.ycombinator.com"


def activate():
    js = "for (const w of workspace.windowList()) { if (w.caption.indexOf(%s) >= 0) { workspace.activeWindow = w; } }" % json.dumps(TITLE)
    path = os.path.join(tmp, "activate.js")
    with open(path, "w") as f:
        f.write(js)
    q = lambda *a: subprocess.run(["qdbus6", "org.kde.KWin", "/Scripting", *a], capture_output=True, text=True)
    name = f"termium-flicker-{os.getpid()}"
    q("org.kde.kwin.Scripting.unloadScript", name)
    q("org.kde.kwin.Scripting.loadScript", path, name)
    q("org.kde.kwin.Scripting.start")
    time.sleep(0.3)
    q("org.kde.kwin.Scripting.unloadScript", name)


frames = []  # (file, action, t)
action = ["start"]
stop = threading.Event()


def capture_loop():
    from PIL import Image
    n = 0
    while not stop.is_set():
        path = os.path.join(OUT, f"f-{n:03d}.png")
        label = action[0]
        t0 = time.time()
        subprocess.run(["spectacle", "-b", "-n", "-a", "-o", path], capture_output=True)
        try:
            w, h = Image.open(path).size
        except OSError:
            continue
        if not (xpix <= w <= xpix + 120 and ypix <= h <= ypix + 160):
            os.remove(path)  # some other window: never keep it
            activate()  # and bring this one back
            continue
        frames.append((path, label, t0))
        n += 1


def blank_fraction(path):
    """Share of the page area showing the terminal's translucent background."""
    from PIL import Image
    im = Image.open(path).convert("RGBA")
    w, h = im.size
    ox, oy = (w - xpix) // 2, h - ypix - (w - xpix) // 2  # decorations: title bar on top, thin border
    x0, y0 = ox + 23 * cw, oy + 3 * ch  # page area: right of the sidebar, below the two top rows
    x1, y1 = ox + xpix - 2 * cw, oy + ypix - 2 * ch
    pts = [(x, y) for x in range(x0, x1, max(1, (x1 - x0) // 40)) for y in range(y0, y1, max(1, (y1 - y0) // 30))]
    return sum(1 for p in pts if im.getpixel(p)[3] < 250) / len(pts)


LEGACY = {"enter": "\r", "escape": "\x1b", "pagedown": "\x1b[6~", "pageup": "\x1b[5~", "alt+left": "\x1b[1;3D", "space": " ",
          # tmux's prefix is Ctrl+B too: pressed twice, one reaches termium
          "ctrl+b": "\x02\x02"}


def press(k):
    """A key, as the kitty protocol in Ghostty, or as legacy bytes through tmux."""
    if MODE != "tmux":
        return t.key(k)
    if k in LEGACY:
        return t.write(LEGACY[k])
    if k.startswith("ctrl+") and len(k) == 6:
        return t.write(chr(ord(k[-1]) - 96))
    t.write(k)


def type_(text):
    if MODE != "tmux":
        return t.type(text, 0.01)
    t.write(text)


def key(t, k, n=1, pause=0.12):
    for _ in range(n):
        press(k)
        time.sleep(pause)


t = None
try:
    if MODE == "tmux":
        sock = f"termium-flicker-{os.getpid()}"
        conf = os.path.join(tmp, "tmux.conf")
        with open(conf, "w") as f:
            f.write("set -g allow-passthrough on\nset -g status off\nset -g escape-time 10\n")
        tm = lambda *a: subprocess.run(["tmux", "-L", sock, *a], env=env, capture_output=True, text=True)
        tm("-f", conf, "new-session", "-d", "-s", "f", "-x", str(cols), "-y", str(rows), "-c", ROOT)
        time.sleep(1.5)
        # Attach first: tmux learns the cell size from its client, and termium asks as it starts.
        t = Term(["tmux", "-L", sock, "attach", "-t", "f"], passthrough=True, env=dict(XDG))
        time.sleep(1)
        tm("send-keys", "-t", "f", f"termium() {{ bun '{ROOT}/src/main.ts' \"$@\"; }}; clear", "Enter")
        time.sleep(0.5)
        tm("send-keys", "-t", "f", f"termium --profile {tmp}/profile {URL1}", "Enter")
    else:
        extra = {"TERMIUM_GRAPHICS": "placeholders"} if MODE == "placeholders" else {}
        t = Term(["bun", os.path.join(ROOT, "src/main.ts"), "--profile", f"{tmp}/profile", URL1], cwd=ROOT,
                 passthrough=True, env={**XDG, **extra})
    time.sleep(12)
    activate()
    time.sleep(0.5)
    th = threading.Thread(target=capture_loop, daemon=True)
    th.start()
    time.sleep(1.5)
    action[0] = "scroll"
    for _ in range(3):
        key(t, "pagedown", 4, 0.35)
        key(t, "pageup", 4, 0.35)
    action[0] = "type"
    press("ctrl+l"); time.sleep(0.2)
    for c in "typing in the address bar":
        press("space") if c == " " else press(c)
        time.sleep(0.08)
    press("escape"); time.sleep(0.5)
    action[0] = "navigate"
    for url in (URL2, URL3):
        press("ctrl+l"); time.sleep(0.2); type_(url); press("enter"); time.sleep(4)
    press("alt+left"); time.sleep(3)
    action[0] = "sidebar"
    for _ in range(4):
        press("ctrl+b"); press("b"); time.sleep(0.8)
    action[0] = "new tab"
    press("ctrl+t"); time.sleep(0.6); type_(URL1); press("enter"); time.sleep(4)
    action[0] = "tabs"
    for _ in range(4):
        press("ctrl+b"); press("n"); time.sleep(0.8)
    action[0] = "new split"
    press("ctrl+b"); press("v"); time.sleep(0.6); type_(URL3); press("enter"); time.sleep(4)
    action[0] = "split"
    time.sleep(1)
    # detach, then attach again in this same window
    action[0] = "detach"
    press("ctrl+b"); press("d"); time.sleep(2)
    action[0] = "new attach"
    if MODE == "tmux":
        tm("send-keys", "-t", "f", "termium attach", "Enter")
    else:
        old = t
        try:
            old.close()
        except Exception:
            pass
        t = Term(["bun", os.path.join(ROOT, "src/main.ts"), "attach"], cwd=ROOT, passthrough=True,
                 env={**XDG, **({"TERMIUM_GRAPHICS": "placeholders"} if MODE == "placeholders" else {})})
    time.sleep(4)
    action[0] = "re-attached tabs"
    for _ in range(4):
        press("ctrl+b"); press("n"); time.sleep(0.8)
    action[0] = "end"
    time.sleep(1)
finally:
    stop.set()
    time.sleep(1.5)
    if t:
        with open(os.path.join(OUT, "raw.bin"), "wb") as f:
            f.write(bytes(t.raw))
        try:
            t.close()
        except Exception:
            pass
    if MODE == "tmux":
        subprocess.run(["tmux", "-L", f"termium-flicker-{os.getpid()}", "kill-server"], capture_output=True)
    pid_file = os.path.join(rt, "termium", "default.pid")
    if os.path.exists(pid_file):
        subprocess.run(["bun", os.path.join(ROOT, "src/main.ts"), "kill"], env=env, capture_output=True, timeout=30)
    results = []
    for path, label, t0 in frames:
        try:
            results.append({"file": os.path.basename(path), "action": label, "blank": round(blank_fraction(path), 3)})
        except Exception as e:
            results.append({"file": os.path.basename(path), "action": label, "error": str(e)})
    summary = {
        "mode": MODE,
        "captures": len(results),
        # (a new tab or split pane is empty until its page draws: not flicker)
        "blank": [r["file"] for r in results if r.get("blank", 0) > 0.5 and r["action"] not in ("start", "new tab", "new split", "detach", "new attach")],
        "frames": results,
    }
    with open(os.path.join(OUT, "summary.json"), "w") as f:
        json.dump(summary, f, indent=1)
    shutil.rmtree(tmp, ignore_errors=True)
