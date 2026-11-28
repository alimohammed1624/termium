"""The hint footer against the real stack (termium + Helium).

In each context (normal, ^B prefix, resize, spaces picker, help, a page's
dialogs, the address bar) checks what the footer lists, clicks each action
with real mouse sequences and checks what it did; then that ^B i takes the
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
          all(s in foot() for s in ("Address ^L", "New tab ^T", "Split ^Bv", "Close ^W", "Back Alt←", "Reload ^R", "Spaces ^Bw", "Keys ^B?", "Hide ^Bi")), foot())
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
    check("help lists ^B i", "hint footer: on / only with ^B / off" in t.text(), t.text())
    click_hint("Close Esc")
    check("Close puts help away", wait(lambda: "edit address" not in t.text() and "Address ^L" in foot()))

    # ---- ^B prefix
    t.key("ctrl+b")
    want = ("Split→ v", "Split↓ -", "New tab c", "Close x", "Spaces w", "Footer i", "Keys ?", "Cancel Esc", "Sidebar b")
    check("prefix: footer lists the prefix keys", wait(lambda: all(s in foot() for s in want)), foot())
    check("...but not Zoom, Resize, Next or Prev with one pane and one tab",
          not any(s in foot() for s in ("Zoom z", "Resize r", "Next n", "Prev p")), foot())
    click_hint("Cancel Esc")
    check("Cancel ends the prefix", wait(lambda: "Address ^L" in foot()), foot())
    t.key("ctrl+b"); time.sleep(0.3); click_hint("Split→ v")
    check("prefix Split right splits side by side", wait(lambda: sep_col() > 0))
    t.key("escape"); time.sleep(0.4)
    t.key("ctrl+b"); time.sleep(0.3); click_hint("Split↓ -")
    check("prefix Split down stacks panes", wait(lambda: header_row() > 4), [t.line(r) for r in range(3, ROWS)])
    t.key("escape"); time.sleep(0.4)
    t.key("ctrl+b")
    check("with panes, ^B offers Zoom and Resize", wait(lambda: "Zoom z" in foot() and "Resize r" in foot()), foot())
    click_hint("Zoom z")
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
    check("spaces (just one): footer lists Open/New/Cancel, no cursor moves",
          wait(lambda: all(s in foot() for s in ("Open Enter", "New N", "Cancel Esc"))) and "Down j" not in foot() and "Up k" not in foot(), foot())
    click_hint("New N")
    check("New makes a space", wait(lambda: " 2 " in t.text() and "Address ^L" in foot() or "Go Enter" in foot()), foot())
    t.key("escape"); time.sleep(0.5)
    click_hint("Spaces ^Bw")
    check("spaces (two): Down and Up too", wait(lambda: "Down j" in foot() and "Up k" in foot()), foot())
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

    # ---- mouse back button on the footer row still goes back
    ctl("eval", "history.pushState({}, '', '?pushed'); 1")
    i = foot().find("Address"); t.click_cell(i + 2, ROWS, button=128)
    check("mouse Back over the footer goes back", wait(lambda: value("location.search") == ""), value("location.search"))

    # ---- a press on the tab bar keeps its gesture, a wheel turn in the middle notwithstanding
    ctl("eval", "window.ups = []; addEventListener('mouseup', (e) => ups.push(e.clientY)); addEventListener('mousedown', (e) => ups.push('down')); 1")
    tx = COLS - 30  # the tab bar's empty stretch (termium's, does nothing)
    px = lambda c, r: ((c - 1) * 10 + 5, (r - 1) * 20 + 10)
    t.mouse(*px(tx, 1), action="press"); time.sleep(0.1)
    t.scroll(*px(60, 10)); time.sleep(0.1)
    t.mouse(*px(60, 10), action="drag"); time.sleep(0.1)
    t.mouse(*px(60, 10), action="release"); time.sleep(0.5)
    check("a tab-bar press's drag and release never reach the page (a wheel turn between)", value("window.ups") == [], value("window.ups"))
    # A footer press, with the page holding another button meanwhile: the page sees only its own button.
    ctl("eval", "window.ev = []; for (const k of ['mousedown', 'mouseup']) addEventListener(k, (e) => ev.push(k[5] + e.button)); 1")
    t.mouse(*px(COLS - 5, ROWS), action="press"); time.sleep(0.1)
    t.mouse(*px(60, 10), button=2, action="press"); time.sleep(0.1)
    t.mouse(*px(60, 12), action="drag"); time.sleep(0.1)
    t.mouse(*px(60, 12), action="release"); time.sleep(0.1)
    t.mouse(*px(60, 12), button=2, action="release"); time.sleep(0.5)
    t.key("escape"); time.sleep(0.3)  # (a context menu, if any)
    check("a footer press's release stays termium's while the page holds another button", value("window.ev") == ["d2", "u2"], value("window.ev"))
    # Closing help with a click: that click's release isn't the page's either.
    ctl("eval", "window.ev = []; for (const k of ['mousemove', 'mouseup']) addEventListener(k, (e) => ev.push(k)); 1")
    t.key("ctrl+b"); time.sleep(0.2); t.key("question"); time.sleep(0.8)
    i = foot().find("Close Esc")
    t.mouse(*px(i + 2, ROWS), action="press"); time.sleep(0.3)
    for y in (30, 20, 10):
        t.mouse(*px(60, y), action="drag"); time.sleep(0.1)
    t.mouse(*px(60, 10), action="release"); time.sleep(0.5)
    check("closing help by its footer chip: its drag and release don't reach the page", "edit address" not in t.text() and value("window.ev") == [], value("window.ev"))

    # ---- ^B i: the row goes back to the page
    ctl("eval", "window.ups = []; addEventListener('mouseup', (e) => ups.push(e.clientY)); addEventListener('mousedown', (e) => ups.push('down')); 1")
    click_hint("Hide ^Bi")
    check("Hide takes the footer away", wait(lambda: "Address ^L" not in foot()), foot())
    check("...and the page grows by one row", wait(lambda: value("innerHeight") == h_on + 20), (h_on, value("innerHeight")))
    check("...and says how to get it back", "^B i" in url_line(), url_line())
    time.sleep(0.5)
    check("...and the click's release doesn't reach the page now under it", value("window.ups") == [], value("window.ups"))
    # Only with ^B: the hints take the address line while a key is awaited; the page keeps its size.
    t.key("ctrl+b")
    check("with ^B the hints show in the address line", wait(lambda: "Split→ v" in url_line() and " ^B " in url_line()), url_line())
    check("...the page keeps the bottom row", value("innerHeight") == h_on + 20 and "Split" not in foot())
    check("...with the ^B badge at the right edge (nothing of the toast left after it)", url_line().rstrip().endswith("^B"), url_line())
    click_hint("Split→ v", row=2)
    check("...and clicking one does it", wait(lambda: sep_col() > 0), t.line(4))
    t.key("escape"); time.sleep(0.4)
    t.key("ctrl+b"); time.sleep(0.3); click_hint("Resize r", row=2)
    check("resize hints show in the address line", wait(lambda: "Left h" in url_line()), url_line())
    c0 = sep_col(); click_hint("Left h", row=2)
    check("...and work", wait(lambda: 0 < sep_col() < c0), (c0, sep_col()))
    click_hint("Done Esc", row=2)
    check("Done leaves resize mode; the address is back", wait(lambda: "Left h" not in url_line() and "←" in url_line()), url_line())
    t.key("ctrl+b"); time.sleep(0.3); click_hint("Footer i", row=2)
    check("Footer i turns hints off", wait(lambda: "footer off" in url_line()), url_line())
    t.key("ctrl+b")
    check("off: ^B shows no hints", wait(lambda: " ^B " in url_line()) and "Split→" not in url_line() and "Split" not in foot(), url_line())
    t.key("escape"); time.sleep(0.4)
    saved = json.load(open(os.path.join(state, "termium", "footer.json")))
    check("the choice is saved", saved == {"footer": "off"}, saved)
    h_off = value("innerHeight")
    t.key("ctrl+b"); time.sleep(0.2); t.key("f"); time.sleep(0.8)
    check("^B f doesn't touch the footer", "Address ^L" not in foot() and json.load(open(os.path.join(state, "termium", "footer.json"))) == {"footer": "off"}, foot())
    t.key("escape"); time.sleep(0.3)
    t.key("ctrl+b"); time.sleep(0.2); t.key("i")
    check("^B i from off turns it back on", wait(lambda: "Address ^L" in foot()), foot())
    check("...and the page is one row shorter again", wait(lambda: value("innerHeight") == h_off - 20), (h_off, value("innerHeight")))

    # ---- 140 columns with the sidebar: the prefix's essentials still fit (the rest go first)
    t.resize(140, ROWS); time.sleep(1.5)
    t.key("ctrl+b")
    check("140 columns: ^B still shows Footer, Keys and Cancel", wait(lambda: all(s in foot() for s in ("Footer i", "Keys ?", "Cancel Esc"))), foot())
    t.key("escape"); time.sleep(0.4)
    # ---- 80 columns, one pane: the prefix keeps its way out and to everything; no-op actions aren't offered
    t.key("ctrl+t"); time.sleep(0.8); t.key("escape"); time.sleep(0.5)
    t.resize(80, ROWS); time.sleep(1.5)
    t.key("ctrl+b")
    check("80 columns: ^B shows Footer, Keys and Cancel, not Zoom or Resize",
          wait(lambda: all(s in foot() for s in ("Footer i", "Keys ?", "Cancel Esc"))) and "Zoom" not in foot() and "Resize" not in foot(), foot())
    t.key("escape"); time.sleep(0.4)
    check("80 columns: the normal footer keeps Keys and Hide", "Keys ^B?" in foot() and "Hide ^Bi" in foot(), foot())
    # ---- narrow: what doesn't fit is left out, never cut mid-action
    t.resize(60, ROWS); time.sleep(1.5)
    f = foot()
    t.key("ctrl+b"); time.sleep(0.2); t.key("w"); time.sleep(0.6)
    check("60 columns, two spaces: the picker keeps Open, New and Cancel", all(x in foot() for x in ("Open Enter", "New N", "Cancel Esc")), foot())
    t.key("escape"); time.sleep(0.4)
    check("narrow: whole actions only, Keys and Hide kept", "Address ^L" in f and "New tab" not in f and f.rstrip().endswith("Keys ^B? · Hide ^Bi"), f)
    t.resize(COLS, ROWS); time.sleep(1)
    # ---- a short terminal: the footer never hides a pane
    for _ in range(2):
        t.key("ctrl+b"); time.sleep(0.2); t.key("minus"); time.sleep(0.8); t.key("escape"); time.sleep(0.5)
    # 3 stacked panes (the last two sharing the lower half) need 4 rows: 6 rows leave just 4 under the bars.
    t.resize(COLS, 6); time.sleep(1.5)
    check("6 rows, 3 stacked panes: the footer gives its row up rather than hide a pane", "Address" not in t.line(6), t.line(6))
    t.resize(COLS, 8); time.sleep(1.5)
    check("8 rows: room for both, the footer is back", "Address ^L" in t.line(8), t.line(8))
    # A long dialog in a short pane: the footer stays on top, so what shows there is what a click does.
    t.resize(COLS, 7); time.sleep(1.5)
    ctl("eval", "setTimeout(() => { window.r = confirm('LONG-QUESTION\\n' + 'line\\n'.repeat(8)) }, 50); 1")
    check("7 rows, a long dialog: the footer still shows OK and Cancel", wait(lambda: "OK Enter" in t.line(7) and "Cancel Esc" in t.line(7)), t.line(7))
    i = t.line(7).find("Cancel Esc"); t.click_cell(i + 2, 7); time.sleep(0.5)
    check("...and Cancel there answers no", wait(lambda: value("window.r") is False), value("window.r"))
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
