#!/usr/bin/env python3
"""The element picker against the real stack (termium + Helium).

A person's terminal (a PTY that answers like Ghostty) picks elements with
Ctrl+B g and real SGR mouse events; another process, with no terminal,
reads them with `termium ctl picked` / `pick` and acts on them with
`ctl click` / `type`. Checks the click never reaches the page, Esc and a
click outside cancel, the clipboard (OSC 52, captured by the PTY: no real
clipboard is touched), stale ids, and `pick` timing out.

Usage: python3 tests/pick.py
"""
import base64, json, os, re, shutil, socket, subprocess, sys, tempfile, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
from drive import Term

failures = []
def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))
    if not cond:
        failures.append(name)

main = os.path.join(ROOT, "src", "main.ts")
tmp = tempfile.mkdtemp(prefix="pr2-pick-")
rt = os.path.join(tmp, "run"); os.makedirs(rt)
TMPD = os.path.join(tmp, "t"); os.makedirs(TMPD)
ENV = {"XDG_RUNTIME_DIR": rt, "TMPDIR": TMPD, "TERMIUM_NO_UPDATE_CHECK": "1",
       "XDG_DATA_HOME": os.path.join(tmp, "data"), "XDG_STATE_HOME": os.path.join(tmp, "state")}
S = "pr2-pick"

with socket.socket() as so:
    so.bind(("127.0.0.1", 0)); PORT = so.getsockname()[1]
srv = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1",
                        "--directory", os.path.join(ROOT, "tests", "fixtures")], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.5)
URL = f"http://127.0.0.1:{PORT}/pick.html"

def ctl_argv(*args):
    return ["bun", main, "ctl", "-s", S, *args]

def ctl(*args, timeout=60):
    return subprocess.run(ctl_argv(*args), cwd=ROOT, env=dict(os.environ, **ENV), stdin=subprocess.DEVNULL,
                          capture_output=True, text=True, timeout=timeout, start_new_session=True)

def ctl_bg(*args):
    return subprocess.Popen(ctl_argv(*args), cwd=ROOT, env=dict(os.environ, **ENV), stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)

def js(expr):
    r = ctl("eval", expr, "--json")
    try:
        return json.loads(r.stdout).get("value")
    except ValueError:
        return ("error", r.returncode, r.stderr)

# The pane's content starts at col 23, row 3: pixel (220, 40) at 10x20 cells, 1 CSS px per pixel.
def at(css_x, css_y):
    return 220 + css_x, 40 + css_y

def pick_on(t):
    t.key("ctrl+b"); t.key("g")
    return t.wait_text("PICK", 5)

def clipboards(t, since):
    return [base64.b64decode(m).decode() for m in re.findall(rb"\x1b\]52;c;([A-Za-z0-9+/=]*)(?:\x1b\\|\x07)", bytes(t.raw[since:]))]

t = None
try:
    t = Term(["bun", main, "-s", S, "--incognito", URL], cwd=ROOT, env=ENV)
    check("page loaded", t.wait_text("Pick fixture", 30), t.text()[:400])
    t.wait_idle()

    r = ctl("picked")
    check("nothing picked yet: exit 1", r.returncode == 1 and "nothing picked" in r.stderr, r.stderr)

    # 1. Ctrl+B g, hover, click the button: picked, the page never sees the click.
    check("Ctrl+B g turns pick mode on", pick_on(t), t.text()[:300])
    x, y = at(260, 85)
    t.mouse(x - 40, y, action="move"); time.sleep(0.2)
    t.mouse(x, y, action="move"); time.sleep(0.6)
    since = len(t.raw)
    t.click(x, y); time.sleep(1.0)
    check("pick mode ends after the click", t.wait_for(lambda: "PICK" not in t.text(), 5), t.text()[:300])
    check("the click didn't reach the page", js("window.clicks || 0") == 0, js("window.clicks"))
    r = ctl("picked", "--json")
    p = json.loads(r.stdout) if r.returncode == 0 else {}
    check("picked --json: the button", p.get("tag") == "button" and p.get("selector") == "#big" and p.get("role") == "button"
          and p.get("name") == "Big button" and p.get("text") == "Big button" and p.get("url") == URL
          and p.get("html", "").startswith("<button id=\"big\"") and re.fullmatch(r"\d+:\d+@\d+", p.get("ref", "")), p or r.stderr)
    clip = clipboards(t, since)
    check("description on the clipboard (OSC 52)", any(c.startswith('Picked in termium: button "Big button" [') and p.get("ref", "?") in c
                                                     and f"-s {S} click" in c for c in clip), clip)
    r = ctl("picked")
    check("picked (text) says how to act on it", r.returncode == 0 and f"termium ctl -s {S} click {p.get('ref')}" in r.stdout
          and "selector: #big" in r.stdout, r.stdout + r.stderr)
    check("toast names the pick", "Picked button" in t.text(), t.text()[:400])

    # 2. The id works with ctl click.
    r = ctl("click", p.get("ref", "x"))
    check("ctl click PICKED_ID", r.returncode == 0 and js("window.clicks || 0") == 1, (r.returncode, r.stderr, js("window.clicks")))

    # 3. ctl picked --wait, then the person picks the field: its value stays out; ctl type works on it.
    w = ctl_bg("picked", "--wait", "--json", "--timeout", "20"); time.sleep(0.8)
    check("picked --wait waits", w.poll() is None)
    pick_on(t)
    t.click(*at(100, 225)); time.sleep(0.3)
    out, err = w.communicate(timeout=30)
    q = json.loads(out) if w.returncode == 0 else {}
    check("picked --wait returns the next pick", q.get("tag") == "input" and q.get("selector") == 'input[data-testid="email"]'
          and q.get("role") == "textbox", (w.returncode, out, err))
    check("a field's value never in the pick", "typed-secret" not in out and q.get("text") == "", out)
    r = ctl("type", q.get("ref", "x"), "ada@example.com")
    check("ctl type PICKED_ID", r.returncode == 0 and js("document.querySelector('input').value") == "ada@example.com", r.stderr)

    # 4. Text inside an element: the element is picked (a text node stands for its parent).
    pick_on(t)
    t.click(*at(70, 345)); time.sleep(0.8)
    q = json.loads(ctl("picked", "--json").stdout or "{}")
    check("text picks its element", q.get("tag") in ("p", "b") and "bold" in q.get("text", ""), q)
    check("pick click didn't reach the page", js("window.pclicks || 0") == 0)

    # 5. Esc cancels; so does a click outside the pages; keys don't reach the page.
    pick_on(t)
    t.key("a")
    t.key("escape")
    check("Esc cancels pick mode", t.wait_for(lambda: "PICK" not in t.text(), 5), t.text()[:300])
    check("keys in pick mode don't reach the page", js("document.querySelector('input').value") == "ada@example.com",
          js("document.querySelector('input').value"))
    pick_on(t)
    t.click(50, 300)  # the sidebar
    check("a click outside the pages cancels", t.wait_for(lambda: "PICK" not in t.text(), 5), t.text()[:300])
    q = json.loads(ctl("picked", "--json").stdout or "{}")
    check("cancelling keeps the last pick", q.get("tag") in ("p", "b"), q)

    # 6. ctl pick: turns pick mode on for the person; their pick answers it; Esc is exit 1.
    w = ctl_bg("pick", "--timeout", "20")
    check("ctl pick turns pick mode on", t.wait_text("PICK", 10), t.text()[:300])
    t.click(*at(260, 85)); time.sleep(0.3)
    out, err = w.communicate(timeout=30)
    check("ctl pick returns the pick", w.returncode == 0 and 'Picked in termium: button "Big button"' in out, (w.returncode, out, err))
    w = ctl_bg("pick")
    t.wait_text("PICK", 10)
    t.key("escape")
    out, err = w.communicate(timeout=30)
    check("ctl pick: Esc is exit 1", w.returncode == 1 and "cancelled" in err, (w.returncode, err))
    r = ctl("pick", "--timeout", "2")
    check("ctl pick --timeout: exit 4, pick mode off", r.returncode == 4 and t.wait_for(lambda: "PICK" not in t.text(), 3),
          (r.returncode, r.stderr, t.text()[:200]))

    # 7. What a pick returns is what a click there would hit, and acting on it works.
    pick_on(t)
    t.click(*at(260, 465)); time.sleep(0.8)
    q = json.loads(ctl("picked", "--json").stdout or "{}")
    check("pointer-events:none overlay: the element under it is picked", q.get("selector") == "#under", q)
    r = ctl("click", q.get("ref", "x"))
    check("...and ctl click on it works", r.returncode == 0 and js("window.underClicks || 0") == 1, (r.returncode, r.stderr))

    # 8. Nothing typed into a field leaves the page, also from inside a picked container.
    js("document.getElementById('ed').textContent = 'typed-token'; document.querySelector('textarea').value = 'area-typed'")
    since = len(t.raw)
    pick_on(t)
    c = js("(() => { const r = document.createRange(); r.selectNodeContents(document.getElementById('form-card').firstChild); const b = r.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; })()")
    t.click(*at(int(c[0]), int(c[1]))); time.sleep(0.8)
    r = ctl("picked", "--json")
    q = json.loads(r.stdout or "{}")
    secrets = ["nested-secret", "area-secret", "area-typed", "ed-secret", "typed-token", "typed-secret"]
    clip = "\n".join(clipboards(t, since))
    check("container picked", q.get("selector") == "#form-card" and "Card" in q.get("text", "") and "label" in q.get("text", ""), q)
    check("no field content in a container's pick or clipboard", clip and not [x for x in secrets if x in r.stdout or x in clip], (r.stdout, clip))
    pick_on(t)
    c = js("(() => { const b = document.getElementById('ed').getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; })()")
    t.click(*at(int(c[0]), int(c[1]))); time.sleep(0.8)
    r = ctl("picked", "--json")
    q = json.loads(r.stdout or "{}")
    check("an editable picked: no content", q.get("selector") == "#ed" and q.get("text") == "" and "typed-token" not in r.stdout, r.stdout)

    # 9. A cross-site frame can't be picked into: said so, pick mode stays on.
    w = ctl_bg("pick", "--timeout", "15")
    t.wait_text("PICK", 10)
    t.click(*at(260, 705)); time.sleep(1.0)
    check("cross-site frame: refused, pick mode stays on", "cross-site frame" in t.text() and "PICK" in t.text() and w.poll() is None, t.text()[:300])
    t.key("escape")
    out, err = w.communicate(timeout=30)
    check("...then Esc ends ctl pick", w.returncode == 1, (w.returncode, err))

    # 10. A button held on the page before pick mode: its release still reaches the page.
    hx, hy = at(260, 800)
    t.mouse(hx, hy, action="press"); time.sleep(0.3)
    pick_on(t)
    t.mouse(hx, hy, action="release"); time.sleep(0.3)
    t.key("escape"); time.sleep(0.5)
    check("held button released on the page", (js("window.downs || 0"), js("window.ups || 0")) == (1, 1), (js("window.downs"), js("window.ups")))

    # 11. Two ctl pick at once: the first timing out leaves pick mode on for the other.
    a = ctl_bg("pick", "--timeout", "3")
    t.wait_text("PICK", 10)
    b = ctl_bg("pick", "--timeout", "20")
    a.communicate(timeout=30)
    time.sleep(0.5)
    check("first ctl pick times out (exit 4), pick mode stays on for the second", a.returncode == 4 and "PICK" in t.text() and b.poll() is None,
          (a.returncode, b.poll(), t.text()[:200]))
    t.click(*at(260, 85)); time.sleep(0.3)
    out, err = b.communicate(timeout=30)
    check("...and the second gets the pick", b.returncode == 0 and '"Big button"' in out, (b.returncode, out, err))

    # 12. A new document: picked says stale, and the id is refused.
    ref = json.loads(ctl("picked", "--json").stdout)["ref"]
    ctl("open", URL)
    q = json.loads(ctl("picked", "--json").stdout or "{}")
    check("picked after a new document: stale", q.get("stale") is True, q)
    r = ctl("click", ref)
    check("stale picked id refused", r.returncode == 1 and "stale" in r.stderr, r.stderr)
finally:
    if t:
        t.close()
    srv.terminate()
    shutil.rmtree(tmp, ignore_errors=True)

print(f"\n{len(failures)} failed" if failures else "\nall passed")
sys.exit(1 if failures else 0)
