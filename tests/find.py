#!/usr/bin/env python3
"""End-to-end check of find in page and its scrollbar landmarks: real termium + real headless Helium.

Usage: python3 tests/find.py [outdir]
"""
import json, os, shutil, socket, subprocess, sys, tempfile, time
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
from drive import Term

OUT = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="termium-find-")
os.makedirs(OUT, exist_ok=True)
profile = tempfile.mkdtemp(prefix="termium-find-profile-")
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0)); PORT = sock.getsockname()[1]
PY = shutil.which("python3") or sys.executable
srv = subprocess.Popen([PY, "-m", "http.server", str(PORT), "--bind", "127.0.0.1",
                        "--directory", os.path.join(ROOT, "tests", "fixtures")],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.5)
BASE = f"http://127.0.0.1:{PORT}"

failures = []
def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail != "" and not cond else ""))
    if not cond: failures.append(name)

def page_value(expr, page="find.html"):
    r = subprocess.run(["bun", os.path.join(ROOT, "tests/support/cdp-eval.ts"), profile, expr], capture_output=True, text=True, timeout=20)
    vals = [p["value"] for p in json.loads(r.stdout or "[]") if page in p["url"]]
    return vals[0] if vals else None

COLS, ROWS, CW, CH = 120, 40, 10, 20
BAR_COL = COLS
TOP, BOTTOM = 3, ROWS
MARK, CURRENT = "f9e2af", "fab387"

def marks():
    """{row: colour} of the bar's landmark cells."""
    with t.lock:
        out = {}
        for y in range(TOP - 1, BOTTOM):
            c = t.screen.buffer[y][BAR_COL - 1]
            if c.data == "━": out[y + 1] = c.fg
        return out

def expected_rows(query):
    """Bar rows where the page's own matches of `query` go (as scrollbar.markRow)."""
    v = page_value("(() => { const ys = []; const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);"
                   f" const re = new RegExp({json.dumps(query)}, 'gi');"
                   " for (let n; (n = w.nextNode()); ) { if (n.parentElement.tagName === 'SCRIPT') continue; re.lastIndex = 0;"
                   " for (let m; (m = re.exec(n.data)); ) { const r = new Range(); r.setStart(n, m.index); r.setEnd(n, m.index + m[0].length);"
                   " const b = r.getBoundingClientRect(); if (b.width || b.height) ys.push(b.top + scrollY); } }"
                   " return { ys, total: document.documentElement.scrollHeight }; })()")
    n = BOTTOM - TOP + 1
    return sorted({TOP + min(n - 1, max(0, int(y / v["total"] * n))) for y in v["ys"]}), v

def bar_line():
    return t.line(2)

def in_view(row_id):
    return page_value(f"(b => b.top >= 0 && b.bottom <= innerHeight)(document.getElementById('{row_id}').getBoundingClientRect())")

def count_shown(s):
    return t.wait_for(lambda: s in bar_line(), 5)

t = Term(["bun", os.path.join(ROOT, "src/main.ts"), "--session", "pr28-find", "--profile", profile, f"{BASE}/find.html"],
         cols=COLS, rows=ROWS, cell_w=CW, cell_h=CH, cwd=ROOT)
try:
    check("page loads", t.wait_for(lambda: page_value("document.title") == "find page", 30))
    t.wait_idle(1.0, 15)
    check("no marks before find", marks() == {}, marks())

    # Ctrl+F opens the find bar; typing searches and marks every match
    t.key("ctrl+f")
    check("Ctrl+F opens the find bar", t.wait_for(lambda: "Find:" in bar_line(), 5), bar_line())
    t.type("needle")
    check("count shows 1/6", count_shown("1/6"), bar_line())
    want, info = expected_rows("needle")
    check("the bar marks the rows of the matches", t.wait_for(lambda: sorted(marks()) == want, 5), (marks(), want, info))
    check("the current match's mark stands out", t.wait_for(lambda: list(marks().values()).count(CURRENT) == 1, 5), marks())
    check("matches are highlighted in the page", page_value("CSS.highlights.get('termium-find').size") == 6)
    t.shot(f"{OUT}/01-find.png")

    # Enter / Shift+Enter: next / previous, wrapping around
    t.key("enter")
    check("Enter: 2/6", count_shown("2/6"), bar_line())
    check("...scrolled to it", t.wait_for(lambda: in_view("row20"), 5))
    check("the find bar stays open after Enter", "Find:" in bar_line())
    t.key("enter"); count_shown("3/6")
    t.key("shift+enter")
    check("Shift+Enter: back to 2/6", count_shown("2/6"), bar_line())
    t.key("shift+enter"); count_shown("1/6")
    t.key("shift+enter")
    check("Shift+Enter wraps to 6/6", count_shown("6/6"), bar_line())
    check("...scrolled to the last one", t.wait_for(lambda: in_view("row78"), 5))
    cur_row = want[-1]
    check("the current mark follows", t.wait_for(lambda: marks().get(cur_row) == CURRENT, 5), (marks(), cur_row))
    t.shot(f"{OUT}/02-last.png")

    # clicking a mark (off the thumb) jumps to that match
    x = (BAR_COL - 1) * CW + 5
    v = expected_rows("needle")[1]
    row50 = TOP + int(v["ys"][3] / v["total"] * (BOTTOM - TOP + 1))  # the 4th match, in row 50
    t.click(x, (row50 - 1) * CH + CH // 2)
    check("clicking a mark goes to its match (4/6)", count_shown("4/6"), bar_line())
    check("...scrolled there", t.wait_for(lambda: in_view("row50"), 5))
    check("...and the find bar stays", "Find:" in bar_line())
    first = expected_rows("needle")[0][0]
    t.click(x, (first - 1) * CH + CH // 2)
    check("clicking the first mark: 1/6", count_shown("1/6"), bar_line())
    check("...scrolled to the top match", t.wait_for(lambda: in_view("row5"), 5))
    t.shot(f"{OUT}/03-clicked.png")

    # a click on the track away from any mark still pages, as before
    y0 = page_value("scrollY")
    empty = next(r for r in range(BOTTOM, TOP, -1) if r not in marks())
    t.click(x, (empty - 1) * CH + CH // 2)
    check("a click off the marks pages down", t.wait_for(lambda: (page_value("scrollY") or 0) > y0 + 300, 5))

    # quick presses each count: three Enters in one write go three matches on
    t.write("\x1b[13u\x1b[13u\x1b[13u")
    check("three quick Enters: 4/6", count_shown("4/6"), bar_line())

    # a match far down a tall element is scrolled into view itself
    t.key("ctrl+a"); t.key("ctrl+k"); t.type("tallword")
    check("tall element: 1/2", count_shown("1/2"), bar_line())
    t.key("enter")
    check("tall element: 2/2", count_shown("2/2"), bar_line())
    match_in_view = ("(() => { const hl = CSS.highlights.get('termium-find-current'); const r = [...hl][0].getBoundingClientRect();"
                     " return r.top >= 0 && r.bottom <= innerHeight; })()")
    check("...the second one is in view", t.wait_for(lambda: page_value(match_in_view), 5), page_value("scrollY"))
    t.key("enter")
    check("...and back to the first, in view", count_shown("1/2") and t.wait_for(lambda: page_value(match_in_view), 5), page_value("scrollY"))

    # text the page doesn't show (visibility: hidden) isn't found
    t.key("ctrl+a"); t.key("ctrl+k"); t.type("ghostword")
    check("hidden text: No matches", count_shown("No matches"), bar_line())
    t.key("ctrl+a"); t.key("ctrl+k"); t.type("needle"); count_shown("/6")

    # Esc closes: the marks and highlights go
    t.key("escape")
    check("Esc closes the find bar", t.wait_for(lambda: "Find:" not in bar_line(), 5), bar_line())
    check("...the marks go", t.wait_for(lambda: marks() == {}, 5), marks())
    check("...the highlights go", t.wait_for(lambda: page_value("CSS.highlights.size") == 0, 5))

    # Ctrl+B f opens it again with the last search; typing replaces it
    t.key("ctrl+b"); t.key("f")
    check("Ctrl+B f opens it with the last search", t.wait_for(lambda: "needle" in bar_line() and "/6" in bar_line(), 5), bar_line())
    t.type("zzz")
    check("no match: 'No matches', no marks", count_shown("No matches") and t.wait_for(lambda: marks() == {}, 5), (bar_line(), marks()))
    # what's searched for is literal text, not a pattern
    t.key("ctrl+a"); t.key("ctrl+k"); t.paste("a.b(c)")
    check("a pasted search is literal: 1/1", count_shown("1/1"), bar_line())
    t.key("escape")

    # a page that handles Ctrl+F itself keeps it
    page_value("(addEventListener('keydown', (e) => { if (e.ctrlKey && e.key === 'f') { e.preventDefault(); document.title = 'own find'; } }), 1)")
    t.key("ctrl+f")
    check("a page's own Ctrl+F", t.wait_for(lambda: page_value("document.title") == "own find", 5))
    time.sleep(0.5)
    check("...doesn't open termium's", "Find:" not in bar_line(), bar_line())

    # a new document closes the find bar
    t.key("ctrl+b"); t.key("f")
    check("find bar open again", t.wait_for(lambda: "Find:" in bar_line(), 5))
    page_value("(location.reload(), 1)")
    check("a navigation closes it", t.wait_for(lambda: "Find:" not in bar_line(), 10), bar_line())
    check("...and its marks", t.wait_for(lambda: marks() == {}, 5), marks())
finally:
    t.close()
    srv.terminate()
    shutil.rmtree(profile, ignore_errors=True)

print(f"\nscreenshots in {OUT}")
print("ALL PASS" if not failures else f"{len(failures)} FAILED: {failures}")
sys.exit(1 if failures else 0)
