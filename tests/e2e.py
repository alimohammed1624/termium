#!/usr/bin/env python3
"""End-to-end check: real termium + real headless Helium in a Ghostty-like PTY.

Usage: python3 tests/e2e.py [outdir]
"""
import json, os, shutil, subprocess, sys, tempfile, time, threading, http.server, functools
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
from drive import Term

OUT = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="termium-e2e-")
os.makedirs(OUT, exist_ok=True)
profile = tempfile.mkdtemp(prefix="termium-e2e-profile-")

# Serve the fixtures from a separate process so the driver's busy reader
# thread can't starve the server.
import socket
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0)); PORT = sock.getsockname()[1]
srv = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1",
                        "--directory", os.path.join(ROOT, "tests", "fixtures")],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.5)
BASE = f"http://127.0.0.1:{PORT}"

failures = []
def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))
    if not cond: failures.append(name)

def pages(expr="window.termiumState ? termiumState() : null"):
    r = subprocess.run(["bun", os.path.join(ROOT, "tests/support/cdp-eval.ts"), profile, expr], capture_output=True, text=True, timeout=20)
    return json.loads(r.stdout or "[]")

def state(match="page.html"):
    for p in pages():
        if match in p["url"] and p["value"]:
            return p["value"]
    return None

t = Term(["bun", os.path.join(ROOT, "src/main.ts"), "--profile", profile], cols=160, rows=45, cwd=ROOT)
try:
    # 1. starts with the URL bar focused; type a URL
    check("starts with the URL bar focused", t.wait_for(lambda: not t.screen.cursor.hidden and t.screen.cursor.y == 1, 20))
    t.type(f"{BASE}/page.html"); t.key("enter")
    check("navigates from URL bar", t.wait_for(lambda: state() is not None, 25))
    t.wait_text("termium test page", 10); t.wait_idle(0.8, 10)
    check("tab title shows page title", "termium test page" in t.line(1), t.line(1))
    t.shot(f"{OUT}/01-page.png")
    s = state()
    check("viewport matches pane", s and s["w"] == 1380 and s["h"] == 860, s and (s["w"], s["h"]))

    # 2. click the input and type (pixel mouse). Pane content starts at col 23,row 3 => px (220, 40)
    inp = pages("(() => { const r = document.getElementById('inp').getBoundingClientRect(); return [r.x + 10, r.y + r.height/2]; })()")[0]["value"]
    t.click(220 + int(inp[0]), 40 + int(inp[1])); time.sleep(0.3)
    t.type("Hello World"); time.sleep(0.5)
    check("typing into input", (state() or {}).get("inp") == "Hello World", state() and state().get("inp"))
    log = (state() or {}).get("log", "")
    check("keydown/keyup reach page", "down H KeyH S" in log and "up H" in log, log[-200:])
    t.key("ctrl+a"); t.type("x"); time.sleep(0.4)
    check("ctrl+a selects all in input", (state() or {}).get("inp") == "x", state() and state().get("inp"))
    t.key("backspace"); t.paste("pasted text"); time.sleep(0.4)
    check("bracketed paste inserts text", (state() or {}).get("inp") == "pasted text", state() and state().get("inp"))

    # 3. button clicks, double click
    btn = pages("(() => { const r = document.getElementById('btn').getBoundingClientRect(); return [r.x + r.width/2, r.y + r.height/2]; })()")[0]["value"]
    t.click(220 + int(btn[0]), 40 + int(btn[1])); time.sleep(0.15)
    t.click(220 + int(btn[0]), 40 + int(btn[1])); time.sleep(0.5)
    st = state() or {}
    check("clicks counted", st.get("clicks") == 2, st.get("clicks"))
    check("double click detected", "dblclick" in st.get("log", ""))

    # 4. scroll
    t.scroll(700, 500, down=True, n=5); time.sleep(0.8)
    check("wheel scrolls page", (state() or {}).get("scrollY", 0) > 100, state() and state().get("scrollY"))
    t.wait_idle(0.5, 5); t.shot(f"{OUT}/02-scrolled.png")
    t.scroll(700, 500, down=False, n=10); time.sleep(0.6)

    # 5. alert dialog
    al = pages("(() => { const r = document.getElementById('al').getBoundingClientRect(); return [r.x + r.width/2, r.y + r.height/2]; })()")[0]["value"]
    t.click(220 + int(al[0]), 40 + int(al[1]))
    check("alert shown in bar", t.wait_text("hello from page", 5), t.line(2))
    t.shot(f"{OUT}/03-alert.png")
    t.key("enter"); time.sleep(0.5)
    check("alert dismissed", "hello from page" not in t.line(2))

    # 6. prompt dialog with text
    pr = pages("(() => { const r = document.getElementById('pr').getBoundingClientRect(); return [r.x + r.width/2, r.y + r.height/2]; })()")[0]["value"]
    t.click(220 + int(pr[0]), 40 + int(pr[1]))
    check("prompt shown", t.wait_text("Your name?", 5))
    t.type("Ada"); t.key("enter"); time.sleep(0.6)
    h = pages("document.getElementById('h') && document.getElementById('h').textContent")
    check("prompt answer reaches page", any(p["value"] == "prompt: Ada" for p in h), h)

    # 7. target=_blank opens a new tab
    pop = pages("(() => { const r = document.getElementById('pop').getBoundingClientRect(); return [r.x + 5, r.y + r.height/2]; })()")[0]["value"]
    t.click(220 + int(pop[0]), 40 + int(pop[1]))
    check("link opens new tab", t.wait_for(lambda: " 2 " in t.line(1), 8), t.line(1))
    t.wait_idle(0.8, 8)
    check("popup page loaded", any("popup=1" in p["url"] for p in pages("1")))

    # 8. tab switching with prefix
    t.key("ctrl+b"); t.key("1"); time.sleep(0.5)
    check("prefix+1 switches tab", "page.html" in t.line(2) and "popup" not in t.line(2), t.line(2))

    # 9. split right and load a second page
    t.key("ctrl+b"); t.key("v")
    check("split creates pane", t.wait_for(lambda: len(pages("1")) == 3, 8))
    time.sleep(0.5)
    t.type(f"{BASE}/page.html?right=1"); t.key("enter")
    check("right pane loads", t.wait_for(lambda: any("right=1" in p["url"] and p["value"] for p in pages()), 10))
    t.wait_idle(1.0, 10)
    t.shot(f"{OUT}/04-split.png")
    widths = [p["value"]["w"] for p in pages() if p["value"] and "popup" not in p["url"]]
    check("split halves the viewport", len(widths) == 2 and all(600 < w < 700 for w in widths), widths)
    t.key("ctrl+b"); t.key("h"); time.sleep(0.3)
    check("prefix+h focuses left pane", "right=1" not in t.line(2), t.line(2))
    t.key("ctrl+b"); t.key("z"); time.sleep(0.8)
    zw = [p["value"]["w"] for p in pages() if p["value"] and "right" not in p["url"] and "popup" not in p["url"]]
    check("zoom gives full width", zw == [1380], zw)
    t.key("ctrl+b"); t.key("z"); time.sleep(0.5)

    # 10. split down
    t.key("ctrl+b"); t.key("minus")
    check("split down creates pane", t.wait_for(lambda: len(pages("1")) == 4, 8))
    t.key("escape"); time.sleep(0.8)
    t.shot(f"{OUT}/05-three-panes.png")

    # 11. new space
    t.key("ctrl+b"); t.key("shift+n"); time.sleep(0.5)
    t.type("example.com"); t.key("enter")
    check("new space listed", t.wait_text("space 2", 5))
    t.wait_idle(1.5, 10)
    t.shot(f"{OUT}/06-space2.png")
    t.click_cell(5, 3); time.sleep(0.6)
    check("sidebar click switches space", "3 " in t.line(1) or "⊞" in t.line(1), t.line(1))

    # 12. help overlay
    t.key("ctrl+b"); t.key("?"); time.sleep(0.5)
    check("help overlay", t.wait_text("termium keys", 3))
    t.shot(f"{OUT}/07-help.png")
    t.key("escape"); time.sleep(0.5)
    check("help closes", "termium keys" not in t.text())

    # 13. resize the terminal
    t.resize(120, 40); time.sleep(1.5)
    ws = [p["value"]["w"] for p in pages() if p["value"]]
    check("resize relayouts panes", t.wait_for(lambda: any(p["value"] and p["value"]["w"] < 700 for p in pages()), 5), ws)
    t.shot(f"{OUT}/08-resized.png")

    # 14. close pane with ctrl+w
    before = len(pages("1"))
    t.key("ctrl+w")
    check("ctrl+w closes pane", t.wait_for(lambda: len(pages("1")) == before - 1, 5))
finally:
    t.close()
    srv.terminate()
    check("exits cleanly with ctrl+q", getattr(t, "exit_code", 1) == 0, getattr(t, "exit_code", None))
    shutil.rmtree(profile, ignore_errors=True)

print(f"\nscreenshots: {OUT}")
print("FAILED: " + ", ".join(failures) if failures else "ALL PASSED")
sys.exit(1 if failures else 0)
