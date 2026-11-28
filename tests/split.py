#!/usr/bin/env python3
"""End-to-end check of splitting, equalizing and resetting panes by mouse
(issue #21): real termium + real headless Helium in a Ghostty-like PTY,
driven only by pointer moves, clicks and drags.

Usage: python3 tests/split.py [outdir]
"""
import json, os, shutil, socket, subprocess, sys, tempfile, time
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
from drive import Term

OUT = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="termium-split-")
os.makedirs(OUT, exist_ok=True)
profile = tempfile.mkdtemp(prefix="termium-split-profile-")
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0)); PORT = sock.getsockname()[1]
PY = shutil.which("python3") or sys.executable
srv = subprocess.Popen([PY, "-m", "http.server", str(PORT), "--bind", "127.0.0.1",
                        "--directory", os.path.join(ROOT, "tests", "fixtures")],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.5)
BASE = f"http://127.0.0.1:{PORT}"
SESSION = os.environ.get("SPLIT_SESSION", "pr21-split")

failures = []
def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))
    if not cond: failures.append(name)

def viewports():
    """{pane name: (innerWidth, innerHeight)} of every pane.html page."""
    r = subprocess.run(["bun", os.path.join(ROOT, "tests/support/cdp-eval.ts"), profile, "[innerWidth, innerHeight]"],
                       capture_output=True, text=True, timeout=20)
    return {p["url"].split("?")[1]: tuple(p["value"]) for p in json.loads(r.stdout or "[]")
            if "pane.html?" in p["url"] and p["value"]}

def find(text, row=None, start=0):
    rows = [row] if row else range(1, t.rows + 1)
    for r in rows:
        i = t.line(r).find(text, start)
        if i >= 0:
            return i + 1, r
    return None

def header(name):
    """(col, row) of the header of pane `name` (its title starts there)."""
    return find(f" pane {name} —")

def px(col, row):
    return (col - 1) * 10 + 5, (row - 1) * 20 + 10

def move(col, row):
    t.mouse(*px(col, row), 0, "move")

def split_button(name):
    """(col, row) of the ⊞ in the header of pane `name`."""
    c, r = header(name)
    i = t.line(r).find("⊞", c)
    return i + 1, r

def open_url(name):
    assert t.wait_text("about:blank", 1) or True
    time.sleep(0.8)
    t.type(f"{BASE}/pane.html?{name}"); t.key("enter")
    return t.wait_for(lambda: header(name) is not None, 15)

def arrow_split(name, arrow, new, preview_char):
    c, r = split_button(name)
    move(c, r); time.sleep(0.4)
    shown = t.wait_for(lambda: "← ↑ ↓ →" in t.line(r), 3)
    check(f"pointing at {name}'s ⊞ shows the four split arrows", shown, t.line(r))
    a = t.line(r).find(arrow, c - 12) + 1
    move(a, r); time.sleep(0.6)
    check(f"pointing at {arrow} previews the new divider ({preview_char})", t.wait_for(lambda: find(preview_char * 1) is not None, 3))
    t.shot(f"{OUT}/preview-{name}-{new}.png")
    t.click_cell(a, r)
    ok = open_url(new)
    check(f"clicking {arrow} on {name} makes a new pane", ok, t.line(r))
    move(2, 30); time.sleep(0.5)
    check("the preview is gone after the split", find(preview_char) is None)

t = Term(["bun", os.path.join(ROOT, "src/main.ts"), "-s", SESSION, "--profile", profile, f"{BASE}/pane.html?A"],
         cols=160, rows=45, cwd=ROOT)
try:
    t.wait_text("pane A", 25); t.wait_idle(0.8, 10); time.sleep(1)
    # One pane has no header: the ≡ menu has the four splits.
    t.click_cell(159, 2); time.sleep(0.6)
    check("≡ lists the four splits", t.wait_text("← Split left", 5) and find("↑ Split up") and find("Equalize panes"))
    sr = find("→ Split right")
    move(sr[0] + 2, sr[1]); time.sleep(0.6)
    check("a highlighted split item previews its divider", t.wait_for(lambda: find("┊") is not None, 3))
    t.shot(f"{OUT}/01-menu-preview.png")
    t.click_cell(sr[0] + 2, sr[1])
    check("≡ → Split right makes a second pane", open_url("B"))
    vp = viewports()
    check("A and B share the width", abs(vp["A"][0] - vp["B"][0]) <= 12, vp)

    arrow_split("A", "↓", "C", "┄")
    arrow_split("C", "↑", "D", "┄")
    arrow_split("B", "←", "E", "┊")
    arrow_split("B", "→", "F", "┊")
    hA, hD, hC = header("A"), header("D"), header("C")
    check("left column: A over D over C", hA[1] < hD[1] < hC[1] and hA[0] == hD[0] == hC[0], (hA, hD, hC))
    hE, hB, hF = header("E"), header("B"), header("F")
    check("top row: E, B and F side by side after A", hA[0] < hE[0] < hB[0] < hF[0] and hE[1] == hB[1] == hF[1] == 3, (hE, hB, hF))
    vp = viewports()
    print("viewports after the splits:", vp)
    check("E (half of the right side) is wider than B and F", vp["E"][0] > vp["B"][0] + 50 and abs(vp["B"][0] - vp["F"][0]) <= 12, vp)
    t.shot(f"{OUT}/02-six-panes.png")

    # Equalize from a side-by-side divider: pointing at it shows a grip and =.
    sep_col = hB[0] - 1
    move(sep_col, 30); time.sleep(0.5)
    eq = t.wait_for(lambda: any(t.line(r)[sep_col - 1] == "=" for r in range(4, 46)), 3)
    check("pointing at a divider shows its equalize button", eq)
    eq_row = next((r for r in range(4, 46) if t.line(r)[sep_col - 1] == "="), None)
    check("the divider is drawn thick while pointed at", "┃" in "".join(t.line(r)[sep_col - 1] for r in range(4, 46)))
    t.shot(f"{OUT}/03-divider-hover.png")
    t.click_cell(sep_col, eq_row); time.sleep(1.5)
    vp = viewports()
    print("viewports after equalizing E|B|F:", vp)
    ws = [vp[k][0] for k in "EBF"]
    check("= gives E, B and F the same width", max(ws) - min(ws) <= 12, ws)
    hs = [vp[k][1] for k in "ADC"]
    check("the left column wasn't touched (A taller than D and C)", hs[0] > hs[1] + 50, hs)

    # Equalize stacked panes from the grip on D's header (the divider between A and D).
    move(header("D")[0] + 5, header("D")[1]); time.sleep(0.5)
    g = t.wait_for(lambda: "━━━ = ━━━" in t.line(header("D")[1]), 3)
    check("pointing at a stacked divider (a header) shows a grip and =", g, t.line(header("D")[1]))
    t.shot(f"{OUT}/04-header-grip.png")
    r = header("D")[1]
    t.click_cell(t.line(r).find("━━━ = ━━━") + 5, r); time.sleep(1.5)
    vp = viewports()
    hs = [vp[k][1] for k in "ADC"]
    check("= on the grip gives A, D and C the same height", max(hs) - min(hs) <= 22, hs)

    # Drag the main divider, then double-click it: back to half way.
    main_col = hE[0] - 1
    before = viewports()["A"][0]
    t.mouse(*px(main_col, 30), 0, "press"); time.sleep(0.2)
    for c in range(main_col, main_col - 30, -3):
        t.mouse(*px(c, 30), 0, "drag"); time.sleep(0.05)
    t.mouse(*px(main_col - 30, 30), 0, "release"); time.sleep(1.5)
    dragged = viewports()["A"][0]
    check("dragging the divider resizes the panes", dragged < before - 200, (before, dragged))
    time.sleep(0.6)
    new_col = find("│", 30)[0] if find("│", 30) else main_col - 30
    new_col = header("E")[0] - 1
    t.click_cell(new_col, 30); time.sleep(0.05); t.click_cell(new_col, 30); time.sleep(1.5)
    after = viewports()["A"][0]
    check("double-clicking the divider resets it to half way", abs(after - before) <= 12, (before, dragged, after))
    t.shot(f"{OUT}/05-after-reset.png")

    # The pane menu: the four splits and Equalize panes.
    c, r = header("C")
    t.click_cell(c + 3, r, 2); time.sleep(0.6)
    check("a header's right-click menu lists the splits", t.wait_text("↓ Split down", 5) and find("Equalize panes") is not None)
    t.key("escape"); time.sleep(0.5)
    # A click on ⊞ (no pointing at the arrows needed): the splits as a menu.
    c, r = split_button("C")
    t.click_cell(c, r); time.sleep(0.6)
    check("clicking ⊞ opens the split menu", t.wait_text("Split", 5) and find("← Split left") is not None)
    q = find("Equalize panes")
    t.click_cell(q[0] + 2, q[1]); time.sleep(1.5)
    vp = viewports()
    print("viewports after Equalize panes:", vp)
    check("Equalize panes evens out every row and column", max(vp[k][1] for k in "ADC") - min(vp[k][1] for k in "ADC") <= 22
          and max(vp[k][0] for k in "EBF") - min(vp[k][0] for k in "EBF") <= 12, vp)

    hA_h = viewports()["A"][1]
    # Not double-clicks: a click on a page in between, or a click and then a drag.
    root_col = lambda: header("E")[0] - 1
    w0 = viewports()["A"][0]
    t.click_cell(root_col(), 30); t.click_cell(root_col() + 10, 30); t.click_cell(root_col(), 30); time.sleep(1.2)
    check("divider, page, divider is not a double-click", viewports()["A"][0] == w0, (w0, viewports()["A"][0]))
    c = root_col()
    t.click_cell(c, 30); time.sleep(0.05)
    t.mouse(*px(c, 30), 0, "press")
    for x in range(c, c + 20, 4):
        t.mouse(*px(x, 30), 0, "drag"); time.sleep(0.03)
    t.mouse(*px(c + 20, 30), 0, "release"); time.sleep(1.2)
    w1 = viewports()["A"][0]
    check("a click and then a quick drag drags (no reset)", w1 > w0 + 150, (w0, w1))
    c = root_col()
    t.mouse(*px(c, 30), 0, "press"); t.mouse(*px(c, 34), 0, "drag"); t.mouse(*px(c, 34), 0, "release"); time.sleep(0.1)
    t.click_cell(c, 34); time.sleep(1.2)
    check("a drag along the divider and then a click is not a double-click", viewports()["A"][0] == w1, (w1, viewports()["A"][0]))

    # Right-click on the = of a stacked divider (a header) still opens that pane's menu.
    c, r = header("D")
    move(c + 3, r); time.sleep(0.5)
    g = t.line(r).find(" = ")
    t.click_cell(g + 2, r, 2); time.sleep(0.6)
    check("right-click on a header grip's = opens the pane menu (doesn't equalize)",
          t.wait_text("↓ Split down", 3) and viewports()["A"][1] == hA_h, (g, t.line(r)))
    t.key("escape"); time.sleep(0.6)

    # A stacked divider's grip never covers the header's arrows.
    c, r = split_button("D")
    move(c, r); time.sleep(0.6)
    line = t.line(r)
    check("on a stacked divider's header, the arrows and the grip's = both show", "← ↑ ↓ →" in line and " = " in line, line)
    a = line.find("←") + 1
    t.click_cell(a, r)
    check("clicking ← there splits (not equalize)", open_url("G"))
    move(2, 30); time.sleep(0.4)

    # A zoomed pane: no preview (the split unzooms; the divider wouldn't be there).
    c, r = header("C")
    t.click_cell(c + 3, r, 2); time.sleep(0.6)
    q = find("Zoom pane"); t.click_cell(q[0] + 2, q[1]); time.sleep(1.2)
    c, r = split_button("C")
    move(c, r); time.sleep(0.4)
    a = t.line(r).find("→") + 1
    move(a, r); time.sleep(0.8)
    check("zoomed: arrows show, but no preview", "← ↑ ↓ →" in t.line(r) and find("┊") is None)
    t.key("ctrl+b"); t.key("z"); time.sleep(1)
    move(2, 30); time.sleep(0.4)

    # A menu's preview goes with the menu, however it closes (here: the terminal is resized).
    c, r = split_button("C")
    t.click_cell(c, r); time.sleep(0.6)
    q = find("→ Split right"); move(q[0] + 2, q[1]); time.sleep(0.8)
    check("the ⊞ menu previews the highlighted split", find("┊") is not None)
    t.resize(150, 45); time.sleep(1.5)
    check("a resize closes the menu and its preview", find("→ Split right") is None and find("┊") is None)
    t.resize(160, 45); time.sleep(1)
finally:
    t.close()

# Unicode placeholders (tmux): a vertical preview hides one column of the picture, not the rest of the row.
shutil.rmtree(profile, ignore_errors=True); os.makedirs(profile)
t = Term(["bun", os.path.join(ROOT, "src/main.ts"), "-s", SESSION + "-ph", "--profile", profile, f"{BASE}/pane.html?A"],
         cols=160, rows=45, cwd=ROOT, env={"TERMIUM_GRAPHICS": "placeholders"})
def ph_cells():
    with t.lock:
        return len(t._placeholder_cells())
try:
    t.wait_text("pane A", 25); t.wait_idle(0.8, 10); time.sleep(1)
    t.key("ctrl+b"); t.key("v")
    open_url("B"); time.sleep(2)
    before = ph_cells()
    c, r = split_button("A")
    move(c, r); time.sleep(0.4)
    move(t.line(r).find("→") + 1, r); time.sleep(1.5)
    rows = sum(1 for y in range(1, 46) if "┊" in t.line(y))
    during = ph_cells()
    check("placeholders: the preview hides exactly its own column", rows > 0 and before - during == rows, (before, during, rows))
    t.shot(f"{OUT}/06-placeholder-preview.png")
    move(2, 30); time.sleep(1.5)
    check("placeholders: the picture is whole again after", ph_cells() == before, (before, ph_cells()))
finally:
    t.close()
    srv.terminate()
    shutil.rmtree(profile, ignore_errors=True)

print(f"\nscreenshots: {OUT}")
print("FAILED: " + ", ".join(failures) if failures else "ALL PASSED")
sys.exit(1 if failures else 0)
