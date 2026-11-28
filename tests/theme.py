#!/usr/bin/env python3
"""Chrome colors follow the terminal's (OSC 10/11/4), or a fixed --theme:
real termium + real headless Helium in a PTY that reports a light palette.

Usage: python3 tests/theme.py [outdir]
"""
import os, shutil, subprocess, sys, tempfile, time
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
from drive import Term

OUT = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="termium-theme-")
os.makedirs(OUT, exist_ok=True)
root = tempfile.mkdtemp(prefix="termium-theme-run-")
profile = os.path.join(root, "profile")
ENV = {k: os.path.join(root, k.lower()) for k in ("XDG_RUNTIME_DIR", "XDG_DATA_HOME", "XDG_STATE_HOME")}
for d in ENV.values():
    os.makedirs(d, mode=0o700)
SESSION = "theme"
MAIN = ["bun", os.path.join(ROOT, "src/main.ts")]

import socket
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0)); PORT = sock.getsockname()[1]
PY = shutil.which("python3") or sys.executable
srv = subprocess.Popen([PY, "-m", "http.server", str(PORT), "--bind", "127.0.0.1",
                        "--directory", os.path.join(ROOT, "tests", "fixtures")],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.5)
URL = f"http://127.0.0.1:{PORT}/page.html"

# Solarized Light, as a terminal would report it.
LIGHT = {"fg": "657b83", "bg": "fdf6e3", "ansi": {1: "dc322f", 2: "859900", 3: "b58900", 4: "268bd2",
                                                  9: "cb4b16", 10: "586e75", 11: "657b83", 12: "839496"}}

failures = []
def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))
    if not cond:
        failures.append(name)

def lum(hexc):
    r, g, b = (int(hexc[i:i + 2], 16) / 255 for i in (0, 2, 4))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b

def bar_bg(t):
    """Background of the address bar (beside its back button)."""
    with t.lock:
        return t.screen.buffer[1][23].bg  # row 2, right of the sidebar: the address bar

def chrome_bgs(t):
    with t.lock:
        return {t.screen.buffer[y][x].bg for y in (0, 1) for x in range(t.cols)}

def accent_pixels(t, rgb):
    img = t.latest_image()
    if img is None:
        return 0
    return sum(1 for p in img.get_flattened_data() if all(abs(a - b) < 20 for a, b in zip(p, rgb)))

def sel_center():
    import json
    expr = "(() => { const e = document.getElementById('sel'); const r = e.getBoundingClientRect(); return [r.x + 20, r.y + r.height/2]; })()"
    r = subprocess.run(["bun", os.path.join(ROOT, "tests/support/cdp-eval.ts"), profile, expr], capture_output=True, text=True, timeout=20)
    for p in json.loads(r.stdout or "[]"):
        if p["value"]:
            return p["value"]
    return None

def term(colors, *extra, env=None):
    return Term(MAIN + list(extra), cols=140, rows=40, cwd=ROOT, env={**ENV, **(env or {})}, colors=colors)

try:
    # 1. A light terminal: the chrome is light, in the terminal's own colors.
    t = term(LIGHT, "-s", SESSION, "--profile", profile, URL)
    check("page loads", t.wait_text("termium test page", 40) or t.wait_frames(1, 40))
    t.wait_frames(1, 30); t.wait_idle(1.0)
    t.shot(f"{OUT}/light-auto.png")
    bgc = bar_bg(t)
    check("address bar uses the terminal's background", bgc == "fdf6e3", bgc)
    check("no Catppuccin Mocha in the chrome", not (chrome_bgs(t) & {"1e1e2e", "11111b", "181825", "313244"}), chrome_bgs(t))
    check("chrome is light", all(lum(c) > 0.5 for c in chrome_bgs(t) if c != "default"), chrome_bgs(t))

    # 2. Its <select> popup takes the chrome's accent (palette 12, made readable).
    c = sel_center()
    check("select found", c is not None)
    if c:
        # The page starts below the bars and right of the sidebar (as in tests/e2e.py).
        x0, y0 = 220, 40
        before = accent_pixels(t, (0x7d, 0x8f, 0x92))
        t.click(x0 + int(c[0]), y0 + int(c[1]))
        t.key("down")
        ok = t.wait_for(lambda: accent_pixels(t, (0x7d, 0x8f, 0x92)) > before + 200, 8)
        t.shot(f"{OUT}/light-select.png")
        check("select popup highlight uses the theme's accent", ok, (before, accent_pixels(t, (0x7d, 0x8f, 0x92))))
        t.key("escape")
    # The keys overlay (a dialog) too.
    t.key("ctrl+b"); t.key("?")
    t.wait_text("termium keys", 5); t.wait_idle(0.5)
    t.shot(f"{OUT}/light-help.png")
    with t.lock:
        row = next(y for y in range(t.rows) if "termium keys" in "".join(t.screen.buffer[y][x].data for x in range(t.cols)))
        col = "".join(t.screen.buffer[row][x].data for x in range(t.cols)).index("termium keys")
        panel = t.screen.buffer[row][col].bg
    check("keys overlay is drawn in the terminal's colors", panel == "fdf6e3", panel)
    t.key("escape")
    t.key("ctrl+b"); t.key("d")
    t.wait_for(lambda: not t.alive, 10)
    t.close()

    # 3. Another terminal attaches with --theme catppuccin: Mocha, whatever it reports.
    t = term(LIGHT, "attach", SESSION, "--theme", "catppuccin")
    t.wait_frames(1, 30); t.wait_idle(1.0)
    t.shot(f"{OUT}/catppuccin.png")
    check("--theme catppuccin draws Mocha", bar_bg(t) == "1e1e2e", bar_bg(t))
    # The page loaded under the light palette: its popup follows the new one.
    c = sel_center()
    if c:
        mauve = (0xcb, 0xa6, 0xf7)
        before = accent_pixels(t, mauve)
        t.click(220 + int(c[0]), 40 + int(c[1]))
        t.key("down")
        ok = t.wait_for(lambda: accent_pixels(t, mauve) > before + 200, 8)
        t.shot(f"{OUT}/catppuccin-select.png")
        check("an open page's select popup follows the new theme", ok, (before, accent_pixels(t, mauve)))
        # Left open, detached.
    t.key("ctrl+b"); t.key("d")
    t.wait_for(lambda: not t.alive, 10)
    t.close()

    # 4. $TERMIUM_THEME=catppuccin-latte.
    t = term(None, "attach", SESSION, env={"TERMIUM_THEME": "catppuccin-latte"})
    t.wait_frames(1, 30); t.wait_idle(1.0)
    check("TERMIUM_THEME=catppuccin-latte draws Latte", bar_bg(t) == "eff1f5", bar_bg(t))
    if c:
        latte = (0x88, 0x39, 0xef)
        ok = t.wait_for(lambda: accent_pixels(t, latte) > 200, 8)
        t.shot(f"{OUT}/latte-open-select.png")
        check("a select menu left open takes the new terminal's colors", ok, accent_pixels(t, latte))
        t.key("escape")
    t.key("ctrl+b"); t.key("d")
    t.wait_for(lambda: not t.alive, 10)
    t.close()

    # 5. A terminal that doesn't report its colors: Mocha, as before.
    t = term(None, "attach", SESSION)
    t.wait_frames(1, 30); t.wait_idle(1.0)
    check("no color replies: Catppuccin Mocha", bar_bg(t) == "1e1e2e", bar_bg(t))
    t.key("ctrl+q")
    t.wait_for(lambda: not t.alive, 15)
    t.close()

    # 6. A valid --theme wins over a bad $TERMIUM_THEME, starting a session too;
    # commands that draw no chrome ignore $TERMIUM_THEME.
    t = term(None, "-s", SESSION + "2", "--profile", profile + "2", "--theme", "catppuccin-latte", URL,
             env={"TERMIUM_THEME": "bogus"})
    t.wait_frames(1, 40); t.wait_idle(1.0)
    check("--theme overrides a bad TERMIUM_THEME on a fresh session", bar_bg(t) == "eff1f5", bar_bg(t))
    t.key("ctrl+q")
    t.wait_for(lambda: not t.alive, 15)
    t.close()
    r = subprocess.run(MAIN + ["ls"], capture_output=True, text=True, env={**os.environ, **ENV, "TERMIUM_THEME": "bogus"})
    check("ls ignores TERMIUM_THEME", r.returncode != 2 and "TERMIUM_THEME" not in r.stderr, (r.returncode, r.stderr))

    # 7. A bad theme is refused.
    r = subprocess.run(MAIN + ["--theme", "nope", "ls"], capture_output=True, text=True, env={**os.environ, **ENV})
    check("unknown --theme is refused", r.returncode == 2 and "unknown theme" in r.stderr, (r.returncode, r.stderr))
finally:
    srv.terminate()
    for name in (SESSION, SESSION + "2"):
        subprocess.run(MAIN + ["kill", name], env={**os.environ, **ENV}, capture_output=True)
    shutil.rmtree(root, ignore_errors=True)

print(f"\nscreenshots in {OUT}")
print("FAILED: " + ", ".join(failures) if failures else "ALL PASS")
sys.exit(1 if failures else 0)
