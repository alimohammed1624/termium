"""The hint footer against the real stack (termium + Helium).

In each context (normal, ^B prefix, resize, spaces picker, help, a page's
dialogs, the address bar) checks what the footer lists, clicks each action
with real mouse sequences and checks what it did; then that ^B f takes the
row back (the page grows by one row), that with the footer only shown with
^B the hints take the address line, that off is off, and that the choice
is kept for the next session.

Usage: python3 tests/footer.py
"""
import json, os, shutil, socket, subprocess, sys, tempfile, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
from drive import Term

failures = []
def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""), flush=True)
    if not cond:
        failures.append(name)

main = os.path.join(ROOT, "src", "main.ts")
tmp = tempfile.mkdtemp(prefix="pr17-footer-")
rt = os.path.join(tmp, "run"); os.makedirs(rt)
prof = os.path.join(tmp, "profile")
state = os.path.join(tmp, "state")
TMPD = os.path.join(tmp, "t"); os.makedirs(TMPD)
# TERMIUM_FOOTER empty: as for someone who never chose (drive.py turns the footer off otherwise).
ENV = {"XDG_RUNTIME_DIR": rt, "TMPDIR": TMPD, "TERMIUM_NO_UPDATE_CHECK": "1", "TERMIUM_FOOTER": "",
       "XDG_DATA_HOME": os.path.join(tmp, "data"), "XDG_STATE_HOME": state}
S = "pr17-footer"
COLS, ROWS = 160, 36

with socket.socket() as so:
    so.bind(("127.0.0.1", 0)); PORT = so.getsockname()[1]
srv = subprocess.Popen([shutil.which("python3") or sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1",
                        "--directory", os.path.join(ROOT, "tests", "fixtures")], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.5)
BASE = f"http://127.0.0.1:{PORT}"

def ctl(*args, timeout=60):
    return subprocess.run(["bun", main, "ctl", "-s", S, *args], cwd=ROOT, env=dict(os.environ, **ENV), stdin=subprocess.DEVNULL,
                          capture_output=True, text=True, timeout=timeout, start_new_session=True)

def value(expr):
    r = ctl("eval", expr, "--json")
    try:
        return json.loads(r.stdout).get("value")
    except ValueError:
        return None

def wait(pred, timeout=10):
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(0.2)
    return False

t = None
def foot():
    return t.line(ROWS)

def url_line():
    """The address line, right of the sidebar."""
    return t.line(2)[22:]

def click_hint(text, row=None):
    """Clicks the hint whose label and key read `text` (e.g. "Split ^Bv")."""
    row = row or ROWS
    line = t.line(row)
    i = line.find(text)
    if i < 0:
        return False
    t.click_cell(i + 2, row)
    time.sleep(0.5)
    return True

def tabs():
    r = ctl("tabs", "--json")
    try:
        return json.loads(r.stdout)
    except ValueError:
        return None

def sep_col():
    """The column of the side-by-side divider on the first pane row (1-based), or -1."""
    line = t.line(4)
    i = line.find("│", 23)
    return i + 1 if i >= 0 else -1

def header_row():
    """The row of a stacked pane's title (below the panes' top row), or -1."""
    for r in range(4, ROWS):
        if t.line(r)[22:].replace("│", "").strip():
            return r
    return -1

try:
    t = Term(["bun", main, "-s", S, "--profile", prof, f"{BASE}/page.html"], cols=COLS, rows=ROWS, cwd=ROOT, env=ENV)
    check("the page shows", t.wait_frames(1, 40) and t.wait_text("termium test page", 20))
    time.sleep(1)

    # ---- someone who never chose: the footer is on, under the panes
    check("normal: footer lists the common actions with their keys",
          all(s in foot() for s in ("Address ^L", "New tab ^T", "Split ^Bv", "Close ^W", "Back Alt←", "Reload ^R", "Spaces ^Bw", "Keys ^B?", "Hide ^Bf")), foot())
    h_on = value("innerHeight")
    check("the page is one row short of the panes' full height", h_on == (ROWS - 3) * 20, h_on)

    # Address: opens the address bar; its footer has Go / Cancel.
    click_hint("Address ^L")
    check("Address opens the address bar, whose footer has Go and Cancel",
          wait(lambda: "Go Enter" in foot() and "Cancel Esc" in foot()), foot())
    t.type(f"{BASE}/page.html?two=1")
    click_hint("Go Enter")
    check("Go goes to the typed address", wait(lambda: value("location.search") == "?two=1"), value("location.href"))
    click_hint("Address ^L"); time.sleep(0.3)
    click_hint("Cancel Esc")
    check("Cancel puts the address bar away", wait(lambda: "Address ^L" in foot()), foot())

    # Back, Reload
    click_hint("Back Alt←")
    check("Back goes back", wait(lambda: value("location.search") == ""), value("location.href"))
    ctl("eval", "window.mark = 1")
    click_hint("Reload ^R")
    check("Reload reloads", wait(lambda: value("window.mark") is None and value("document.readyState") == "complete"), value("window.mark"))

    # New tab, Split, Close
    n = len(tabs() or [])
    click_hint("New tab ^T")
    check("New tab opens a tab (with the address bar)", wait(lambda: len(tabs() or []) == n + 1) and wait(lambda: "Go Enter" in foot()), tabs())
    t.type(f"{BASE}/page.html"); click_hint("Go Enter")
    t.wait_text("termium test page", 10)
    click_hint("Split ^Bv")
    check("Split splits the pane", wait(lambda: sep_col() > 0), t.line(4))
    t.key("escape"); time.sleep(0.5)  # the new pane's address bar
    click_hint("Close ^W")
    check("Close closes the focused pane", wait(lambda: sep_col() < 0), t.line(4))
    click_hint("Close ^W")
    check("...and the tab with its last pane", wait(lambda: len(tabs() or []) == n), tabs())

    # Keys: help, whose footer has Close
    click_hint("Keys ^B?")
    check("Keys shows help, with Close in the footer", wait(lambda: "edit address" in t.text() and "Close Esc" in foot()), foot())
    check("help lists ^B f", "hint footer: on / only with ^B / off" in t.text(), t.text())
    click_hint("Close Esc")
    check("Close puts help away", wait(lambda: "edit address" not in t.text() and "Address ^L" in foot()))

    # ---- ^B prefix
    t.key("ctrl+b")
    want = ("Split→ v", "Split↓ -", "New tab c", "Close x", "Zoom z", "Resize r", "Spaces w", "Footer f", "Keys ?", "Cancel Esc", "Next n", "Prev p", "Sidebar b")
    check("prefix: footer lists the prefix keys", wait(lambda: all(s in foot() for s in want)), foot())
    click_hint("Cancel Esc")
    check("Cancel ends the prefix", wait(lambda: "Address ^L" in foot()), foot())
    t.key("ctrl+b"); time.sleep(0.3); click_hint("Split→ v")
    check("prefix Split right splits side by side", wait(lambda: sep_col() > 0))
    t.key("escape"); time.sleep(0.4)
    t.key("ctrl+b"); time.sleep(0.3); click_hint("Split↓ -")
    check("prefix Split down stacks panes", wait(lambda: header_row() > 4), [t.line(r) for r in range(3, ROWS)])
    t.key("escape"); time.sleep(0.4)
    t.key("ctrl+b"); time.sleep(0.3); click_hint("Zoom z")
    check("prefix Zoom shows the focused pane alone", wait(lambda: sep_col() < 0 and header_row() < 0))
    t.key("ctrl+b"); time.sleep(0.3); click_hint("Zoom z")
    check("...and back", wait(lambda: sep_col() > 0))

    # ---- resize mode
    t.key("ctrl+b"); time.sleep(0.3); click_hint("Resize r")
    check("resize: footer lists Left/Down/Up/Right/Done",
          wait(lambda: all(s in foot() for s in ("Left h", "Down j", "Up k", "Right l", "Done Esc"))) and "RESIZE" in url_line(), foot())
    c0 = sep_col(); click_hint("Left h")
    check("Left moves the divider left", wait(lambda: 0 < sep_col() < c0), (c0, sep_col()))
    c1 = sep_col(); click_hint("Right l")
    check("Right moves it right", wait(lambda: sep_col() > c1), (c1, sep_col()))
    r0 = header_row(); click_hint("Up k")
    check("Up moves the stacked divider up", wait(lambda: 4 < header_row() < r0), (r0, header_row()))
    r1 = header_row(); click_hint("Down j")
    check("Down moves it down", wait(lambda: header_row() > r1), (r1, header_row()))
    click_hint("Done Esc")
    check("Done ends resize mode", wait(lambda: "Address ^L" in foot() and "RESIZE" not in url_line()), foot())

    # Close x, Next/Prev, New tab c, Sidebar b (prefix)
    t.key("ctrl+b"); time.sleep(0.3); click_hint("Close x")
    check("prefix Close closes a pane", wait(lambda: header_row() < 0))
    n = len(tabs() or [])
    t.key("ctrl+b"); time.sleep(0.3); click_hint("New tab c")
    check("prefix New tab opens a tab", wait(lambda: len(tabs() or []) == n + 1), tabs())
    t.key("escape"); time.sleep(0.4)
    active = lambda: next((x.get("tab") for x in (tabs() or []) if x.get("active")), None)
    a0 = active()
    t.key("ctrl+b"); time.sleep(0.3); click_hint("Prev p")
    check("prefix Prev selects the tab before", wait(lambda: active() == a0 - 1), (a0, active(), tabs()))
    t.key("ctrl+b"); time.sleep(0.3); click_hint("Next n")
    check("prefix Next selects the tab after", wait(lambda: active() == a0), (a0, active()))
    t.key("ctrl+b"); time.sleep(0.3); click_hint("Sidebar b")
    check("prefix Sidebar hides the sidebar", wait(lambda: "SPACES" not in t.line(2)[:22]))
    check("...and the footer starts at the left edge", foot().startswith(" Address ^L"), foot())
    t.key("ctrl+b"); time.sleep(0.3); click_hint("Sidebar b")
    check("...and shows it again", wait(lambda: "SPACES" in t.line(2)[:22]))
    t.key("ctrl+b"); time.sleep(0.3); click_hint("Keys ?")
    check("prefix Keys shows help", wait(lambda: "edit address" in t.text()))
    t.key("escape"); time.sleep(0.4)

    # ---- spaces picker
    t.key("ctrl+b"); time.sleep(0.3); click_hint("Spaces w")
    check("spaces: footer lists Down/Up/Open/New/Cancel",
          wait(lambda: all(s in foot() for s in ("Down j", "Up k", "Open Enter", "New N", "Cancel Esc"))), foot())
    click_hint("New N")
    check("New makes a space", wait(lambda: " 2 " in t.text() and "Address ^L" in foot() or "Go Enter" in foot()), foot())
    t.key("escape"); time.sleep(0.5)
    click_hint("Spaces ^Bw")
    cursor = lambda: next((r for r in range(3, ROWS) if "▸" in t.line(r)), -1)
    r0 = cursor(); click_hint("Up k")
    check("Up moves the space cursor", wait(lambda: cursor() not in (-1, r0)), (r0, cursor()))
    r1 = cursor(); click_hint("Down j")
    check("Down moves it back", wait(lambda: cursor() not in (-1, r1)), (r1, cursor()))
    click_hint("Up k"); time.sleep(0.3)
    click_hint("Open Enter")
    check("Open switches to the space under the cursor", wait(lambda: "● 1" in t.text() and "Address ^L" in foot()), [t.line(r)[:22] for r in range(3, 6)])
    click_hint("Spaces ^Bw"); time.sleep(0.3)
    click_hint("Cancel Esc")
    check("Cancel leaves the picker", wait(lambda: "Address ^L" in foot() and "SPACES" not in url_line()), url_line())

    # ---- a page's dialogs
    ctl("eval", "setTimeout(() => { window.r = confirm('Proceed?') }, 50); 1")
    check("confirm: footer has OK and Cancel", wait(lambda: "OK Enter" in foot() and "Cancel Esc" in foot()), foot())
    click_hint("Cancel Esc")
    check("Cancel answers no", wait(lambda: value("window.r") is False), value("window.r"))
    ctl("eval", "setTimeout(() => { window.r = confirm('Proceed?') }, 50); 1")
    wait(lambda: "OK Enter" in foot()); click_hint("OK Enter")
    check("OK answers yes", wait(lambda: value("window.r") is True), value("window.r"))
    ctl("eval", "setTimeout(() => { alert('hi'); window.r = 'alerted' }, 50); 1")
    check("alert: footer has just OK", wait(lambda: "OK Enter" in foot() and "Cancel" not in foot()), foot())
    click_hint("OK Enter")
    check("OK closes the alert", wait(lambda: value("window.r") == "alerted"))
    ctl("eval", "setTimeout(() => { window.r = prompt('Name?', 'anon') }, 50); 1")
    wait(lambda: "OK Enter" in foot()); click_hint("OK Enter")
    check("prompt: OK answers with the text", wait(lambda: value("window.r") == "anon"), value("window.r"))

    # ---- ^B f: the row goes back to the page
    click_hint("Hide ^Bf")
    check("Hide takes the footer away", wait(lambda: "Address ^L" not in foot()), foot())
    check("...and the page grows by one row", wait(lambda: value("innerHeight") == h_on + 20), (h_on, value("innerHeight")))
    check("...and says how to get it back", "^B f" in url_line(), url_line())
    # Only with ^B: the hints take the address line while a key is awaited; the page keeps its size.
    t.key("ctrl+b")
    check("with ^B the hints show in the address line", wait(lambda: "Split→ v" in url_line() and " ^B " in url_line()), url_line())
    check("...the page keeps the bottom row", value("innerHeight") == h_on + 20 and "Split" not in foot())
    click_hint("Split→ v", row=2)
    check("...and clicking one does it", wait(lambda: sep_col() > 0), t.line(4))
    t.key("escape"); time.sleep(0.4)
    t.key("ctrl+b"); time.sleep(0.3); click_hint("Resize r", row=2)
    check("resize hints show in the address line", wait(lambda: "Left h" in url_line()), url_line())
    c0 = sep_col(); click_hint("Left h", row=2)
    check("...and work", wait(lambda: 0 < sep_col() < c0), (c0, sep_col()))
    click_hint("Done Esc", row=2)
    check("Done leaves resize mode; the address is back", wait(lambda: "Left h" not in url_line() and "←" in url_line()), url_line())
    t.key("ctrl+b"); time.sleep(0.3); click_hint("Footer f", row=2)
    check("Footer f turns hints off", wait(lambda: "footer off" in url_line()), url_line())
    t.key("ctrl+b")
    check("off: ^B shows no hints", wait(lambda: " ^B " in url_line()) and "Split→" not in url_line() and "Split" not in foot(), url_line())
    t.key("escape"); time.sleep(0.4)
    saved = json.load(open(os.path.join(state, "termium", "footer.json")))
    check("the choice is saved", saved == {"footer": "off"}, saved)
    h_off = value("innerHeight")
    t.key("ctrl+b"); time.sleep(0.2); t.key("f")
    check("^B f from off turns it back on", wait(lambda: "Address ^L" in foot()), foot())
    check("...and the page is one row shorter again", wait(lambda: value("innerHeight") == h_off - 20), (h_off, value("innerHeight")))

    # ---- 140 columns with the sidebar: the prefix's essentials still fit (the rest go first)
    t.resize(140, ROWS); time.sleep(1.5)
    t.key("ctrl+b")
    check("140 columns: ^B still shows Footer, Keys and Cancel", wait(lambda: all(s in foot() for s in ("Footer f", "Keys ?", "Cancel Esc"))), foot())
    t.key("escape"); time.sleep(0.4)
    # ---- narrow: what doesn't fit is left off the end, never cut mid-action
    t.resize(60, ROWS); time.sleep(1.5)
    f = foot()
    check("narrow: whole actions only", "Address ^L" in f and "Hide ^Bf" not in f and f.rstrip().endswith(("^L", "^T", "^Bv", "^W")), f)
    t.resize(COLS, ROWS); time.sleep(1)
finally:
    if t:
        try:
            t.key("ctrl+q"); time.sleep(0.5)
        except Exception:
            pass
        t.close()
    srv.terminate()
    shutil.rmtree(tmp, ignore_errors=True)

print(f"\n{len(failures)} failure(s)" + (": " + ", ".join(failures) if failures else ""))
sys.exit(1 if failures else 0)
