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
dl_dir = tempfile.mkdtemp(prefix="termium-e2e-dl-")

# Serve the fixtures from a separate process so the driver's busy reader
# thread can't starve the server.
import socket
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0)); PORT = sock.getsockname()[1]
# sys.executable can be a host app (not python) when run from some IDEs.
PY = shutil.which("python3") or sys.executable
srv = subprocess.Popen([PY, "-m", "http.server", str(PORT), "--bind", "127.0.0.1",
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

def center(id_, skip=("popup=1", "right=1")):
    """Center of an element in the visible fixture page (other tabs share the layout code, not the layout)."""
    for p in pages(f"(() => {{ const e = document.getElementById('{id_}'); if (!e) return null; const r = e.getBoundingClientRect(); return [r.x + Math.min(r.width/2, 40), r.y + r.height/2]; }})()"):
        if p["value"] and not any(k in p["url"] for k in skip):
            return p["value"]
    return None

def top_left(id_):
    for p in pages(f"(() => {{ const e = document.getElementById('{id_}'); if (!e) return null; const r = e.getBoundingClientRect(); return [r.x, r.y]; }})()"):
        if p["value"] and not any(k in p["url"] for k in ("popup=1", "right=1")):
            return p["value"]
    return None

def blue_pixels():
    """Pixels of the select menu's highlight colour in the newest frame."""
    img = t.latest_image()
    if img is None:
        return 0
    return sum(1 for (r, g, b) in img.get_flattened_data() if abs(r - 26) < 25 and abs(g - 115) < 30 and abs(b - 232) < 30)

def click_el(id_, x0=220, y0=40):
    c = center(id_)
    t.click(x0 + int(c[0]), y0 + int(c[1]))

def state(match="page.html"):
    for p in pages():
        if match in p["url"] and p["value"]:
            return p["value"]
    return None

t = Term(["bun", os.path.join(ROOT, "src/main.ts"), "--profile", profile], cols=160, rows=45, cwd=ROOT,
         env={"TERMIUM_TEST_DEVTOOLS_PORT": "1", "TERMIUM_DOWNLOAD_DIR": dl_dir})
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
    check("paste fires the page's paste event", (state() or {}).get("pastes", 0) >= 1, state() and state().get("pastes"))
    t.key("ctrl+a"); mark = len(t.raw); t.key("ctrl+x"); time.sleep(0.6)
    import base64
    check("ctrl+x cuts and copies to the clipboard", (state() or {}).get("inp") == "" and
          b"\x1b]52;c;" + base64.b64encode(b"pasted text") in bytes(t.raw[mark:]), state() and state().get("inp"))
    t.paste("pasted text"); time.sleep(0.4)

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
    check("script title changes reach the tab bar", t.wait_for(lambda: "scrolled" in t.line(1), 5), t.line(1))
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

    # 6b. user agent does not say HeadlessChrome / webdriver
    st = state() or {}
    check("user agent hides HeadlessChrome", "HeadlessChrome" not in st.get("ua", "x") and st.get("webdriver") is False, (st.get("ua"), st.get("webdriver")))

    # 6c. <select> opens an in-page menu; keyboard picks a value
    t.scroll(700, 500, down=False, n=10); time.sleep(0.5)
    click_el("sel"); time.sleep(0.6)
    t.shot(f"{OUT}/02b-select-open.png")
    t.key("down"); t.key("down"); t.key("enter"); time.sleep(0.5)
    st = state() or {}
    check("select menu picks a value", st.get("sel") == "gamma" and st.get("selout") == "changed:gamma", (st.get("sel"), st.get("selout")))
    click_el("sel"); time.sleep(0.5)
    t.key("escape"); time.sleep(0.3)
    check("select menu Esc keeps value", (state() or {}).get("sel") == "gamma")

    # 6d. file input asks for a path in the address line
    click_el("file")
    check("file chooser prompt", t.wait_text("Upload file:", 5), t.line(2))
    t.key("ctrl+a"); t.key("ctrl+k")
    t.type(os.path.join(ROOT, "tests", "fixtures", "page.html")); t.key("enter"); time.sleep(0.6)
    check("file attached to input", (state() or {}).get("file") == "page.html", state() and state().get("file"))

    # 6e. cross-site iframe: user agent, select menu and file input work inside it
    check("cross-site iframe loaded", t.wait_for(lambda: ((state() or {}).get("frame") or {}).get("ua"), 10))
    fr = (state() or {}).get("frame") or {}
    check("iframe user agent hides HeadlessChrome", "HeadlessChrome" not in fr.get("ua", "x") and "HeadlessChrome" not in fr.get("brands", ""), fr.get("ua"))
    xf = top_left("xf")
    before_blue = blue_pixels()
    t.click(220 + int(xf[0] + 1 + fr["selRect"][0]), 40 + int(xf[1] + 1 + fr["selRect"][1])); time.sleep(0.8)
    check("select menu opens inside a cross-site iframe", blue_pixels() > before_blue + 200, (before_blue, blue_pixels()))
    t.shot(f"{OUT}/02c-iframe-select.png")
    t.key("down"); t.key("enter"); time.sleep(0.6)
    check("iframe select picks a value", ((state() or {}).get("frame") or {}).get("sel") == "two", (state() or {}).get("frame"))
    t.click(220 + int(xf[0] + 1 + fr["fileRect"][0]), 40 + int(xf[1] + 1 + fr["fileRect"][1]))
    check("iframe file input asks for a path", t.wait_text("Upload file:", 5), t.line(2))
    t.key("ctrl+a"); t.key("ctrl+k"); t.type(os.path.join(ROOT, "tests", "fixtures", "dl.txt")); t.key("enter"); time.sleep(0.8)
    check("iframe file attached", ((state() or {}).get("frame") or {}).get("file") == "dl.txt", (state() or {}).get("frame"))

    # 6f. downloads never overwrite
    click_el("dl"); time.sleep(1.5); click_el("dl"); time.sleep(1.5)
    got = sorted(os.listdir(dl_dir))
    check("second download gets a new name", got == ["dl (1).txt", "dl.txt"], got)

    # 7. target=_blank opens a new tab
    pop = pages("(() => { const r = document.getElementById('pop').getBoundingClientRect(); return [r.x + 5, r.y + r.height/2]; })()")[0]["value"]
    t.click(220 + int(pop[0]), 40 + int(pop[1]))
    check("link opens new tab", t.wait_for(lambda: " 2 " in t.line(1), 8), t.line(1))
    t.wait_idle(0.8, 8)
    check("popup page loaded", any("popup=1" in p["url"] for p in pages("1")))

    # 8. tab switching with prefix
    t.key("ctrl+b"); t.key("1"); time.sleep(0.5)
    check("prefix+1 switches tab", "page.html" in t.line(2) and "popup" not in t.line(2), t.line(2))

    # 8b. a pending dialog survives switching away and back
    click_el("cf")
    check("confirm shown", t.wait_text("Proceed?", 5), t.line(2))
    t.key("ctrl+b"); t.key("2"); time.sleep(0.5)
    check("other tab shows its own address", "Proceed?" not in t.line(2), t.line(2))
    t.key("ctrl+b"); t.key("1"); time.sleep(0.5)
    check("dialog restored after switching back", "Proceed?" in t.line(2), t.line(2))
    t.key("enter"); time.sleep(0.5)
    h = pages("document.getElementById('h') && document.getElementById('h').textContent")
    check("restored dialog can be answered", any(p["value"] == "confirm: true" for p in h), h)

    # 8b2. a dialog in a background tab doesn't steal focus or the address bar
    click_el("later"); time.sleep(0.2)
    t.key("ctrl+b"); t.key("2"); time.sleep(0.4)
    t.key("ctrl+l"); t.key("ctrl+a"); t.key("ctrl+k"); t.type("half typed"); time.sleep(2.5)
    check("background dialog leaves typing alone", "half typed" in t.line(2), t.line(2))
    check("background dialog is announced", "waiting" in t.line(2) or "!" in t.line(1), (t.line(1), t.line(2)))
    t.key("escape"); t.key("ctrl+b"); t.key("1"); time.sleep(0.5)
    check("dialog shown on return", "delayed alert" in t.line(2), t.line(2))
    t.key("enter"); time.sleep(0.4)

    # 8b3. middle-clicked link opens in the background; a guarded page asks before closing
    tabs_before = t.line(1).count("│")
    c = center("pop"); t.click(220 + int(c[0]), 40 + int(c[1]), button=1); time.sleep(2)
    check("middle click opens a background tab", t.line(1).count("│") == tabs_before + 1 and "popup" not in t.line(2), (t.line(1), t.line(2)))
    t.key("ctrl+b"); t.key("2"); time.sleep(1.0)
    click_el("guard", ); time.sleep(0.2); t.type("x"); time.sleep(0.3)
    t.key("ctrl+w")
    check("ctrl+w on an edited page asks to leave", t.wait_text("Leave this page?", 5), t.line(2))
    t.key("escape"); time.sleep(0.8)
    check("staying keeps the page", t.line(1).count("│") == tabs_before + 1, t.line(1))
    t.key("ctrl+w"); t.wait_text("Leave this page?", 5); t.key("enter"); time.sleep(1.0)
    check("leaving closes it", t.line(1).count("│") == tabs_before, t.line(1))
    t.key("ctrl+b"); t.key("1"); time.sleep(0.5)

    # 8c. Ctrl+T then immediate paste lands in the new tab's address bar, not the old page
    click_el("inp"); time.sleep(0.2)
    before_inp = (state() or {}).get("inp")
    t.key("ctrl+t"); t.paste("example.org")
    time.sleep(1.5)
    check("paste after Ctrl+T goes to the new address bar", "example.org" in t.line(2), t.line(2))
    check("old page input untouched", (state() or {}).get("inp") == before_inp, state() and state().get("inp"))
    t.key("escape"); t.key("ctrl+w")
    t.wait_for(lambda: " 3 " not in t.line(1), 5); time.sleep(0.5)
    t.key("ctrl+b"); t.key("1"); time.sleep(0.5)

    # 8d. mouse back button goes back exactly once
    click_el("next")
    check("link click navigates", t.wait_for(lambda: any("step=2" in p["url"] for p in pages("1")), 10), [p["url"] for p in pages("1")])
    time.sleep(0.8)
    t.write("\x1b[<128;700;500M\x1b[<128;700;500m"); time.sleep(1.5)
    urls = [p["url"] for p in pages("1")]
    check("mouse back goes back one page", any(u.endswith("/page.html") for u in urls) and not any("about:blank" in u for u in urls), urls)

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
    t.write("\x1b[113;1;113u"); time.sleep(0.2)          # hold q in the right pane...
    t.key("ctrl+b"); t.key("h"); time.sleep(0.3)
    check("prefix+h focuses left pane", "right=1" not in t.line(2), t.line(2))
    t.write("\x1b[113;1:3u"); time.sleep(0.5)             # ...release it in the left one
    logs = {p["url"]: p["value"] for p in pages("document.getElementById('log') ? document.getElementById('log').textContent : ''")}
    right_log = next((v for u, v in logs.items() if "right=1" in u), "")
    check("keyup goes to the pane that got the keydown", right_log.rstrip().endswith("up q"), right_log[-60:])
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
    time.sleep(1.0)
    t.key("ctrl+b"); t.key("x")
    check("prefix+x closes the other pane", t.wait_for(lambda: len(pages("1")) == before - 2, 5))
    time.sleep(1.2)
    with t.lock:
        placed = list(t.placements.values())
    full_w = t.cols - 22
    check("survivor fills the pane area after closes", len(placed) == 1 and placed[0][2] == full_w, placed)
    t.shot(f"{OUT}/09-after-close.png")

    # 15. a real URL with a #termium-... fragment is shown as-is
    t.key("ctrl+l"); t.key("ctrl+a"); t.key("ctrl+k"); t.type(f"{BASE}/page.html#termium-heading"); t.key("enter")
    check("URL with #termium- fragment shown", t.wait_for(lambda: "#termium-heading" in t.line(2), 10), t.line(2))

    # 15b. select menu still shows under a strict Content-Security-Policy (style-src 'none')
    t.key("ctrl+l"); t.key("ctrl+a"); t.key("ctrl+k"); t.type(f"{BASE}/csp.html"); t.key("enter")
    t.wait_for(lambda: any("csp.html" in p["url"] and p["value"] for p in pages()), 10); time.sleep(1)
    cs = next(p["value"] for p in pages("(() => { const r = document.getElementById('csel').getBoundingClientRect(); return [r.x + 10, r.y + r.height / 2]; })()") if "csp.html" in p["url"])
    before_blue = blue_pixels()
    t.click(220 + int(cs[0]), 40 + int(cs[1])); time.sleep(0.8)
    check("select menu shows under style-src 'none'", blue_pixels() > before_blue + 200, (before_blue, blue_pixels()))
    t.key("down"); t.key("enter"); time.sleep(0.5)
    v = next((p["value"] for p in pages("document.getElementById('csel') && document.getElementById('csel').value") if "csp.html" in p["url"]), None)
    check("CSP page select picks a value", v == "Green", v)

    # 16. Ctrl+B q from the address bar quits, and nothing is drawn after the terminal is restored
    t.key("ctrl+l"); time.sleep(0.3)
    t.key("ctrl+b"); t.key("q")
    status, end = None, time.time() + 10
    while time.time() < end and status is None:
        pid, st = os.waitpid(t.pid, os.WNOHANG)
        if pid:
            status = os.waitstatus_to_exitcode(st)
        time.sleep(0.1)
    t.exit_code = status
    tail = bytes(t.raw).rsplit(b"\x1b[?1049l", 1)[-1]
    check("nothing drawn after leaving the alternate screen", b"\x1b[" not in tail.replace(b"\x1b[0m", b""), tail[:120])
finally:
    t.close()
    srv.terminate()
    check("exits with status 0", getattr(t, "exit_code", 1) == 0, getattr(t, "exit_code", None))
    shutil.rmtree(profile, ignore_errors=True)
    shutil.rmtree(dl_dir, ignore_errors=True)

print(f"\nscreenshots: {OUT}")
print("FAILED: " + ", ".join(failures) if failures else "ALL PASSED")
sys.exit(1 if failures else 0)
