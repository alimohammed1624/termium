#!/usr/bin/env python3
"""Reader mode end to end: real termium + real headless browser in a PTY.

Blog, docs and news-like fixture articles are shown as text; scrolling,
links (click, Tab/Enter), select mode, toggling back and `termium ctl
reader` are checked, and a page that isn't an article offers no reader.

Usage: python3 tests/reader.py [outdir]
"""
import json, os, shutil, socket, subprocess, sys, tempfile, time
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
from drive import Term

OUT = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="termium-reader-")
os.makedirs(OUT, exist_ok=True)
profile = tempfile.mkdtemp(prefix="termium-reader-profile-")
SESSION = "pr27-reader"

with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0)); PORT = sock.getsockname()[1]
PY = shutil.which("python3") or sys.executable
# The fixtures, served from a separate process; ?delay=SEC answers late (a slow page).
SERVER = r"""
import http.server, sys, time, urllib.parse
class H(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        d = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get("delay")
        if d: time.sleep(float(d[0]))
        super().do_GET()
    def log_message(self, *a): pass
http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])),
    lambda *a, **k: H(*a, directory=sys.argv[2], **k)).serve_forever()
"""
srv = subprocess.Popen([PY, "-c", SERVER, str(PORT), os.path.join(ROOT, "tests", "fixtures")],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.5)
BASE = f"http://127.0.0.1:{PORT}"

failures = []
def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""), flush=True)
    if not cond: failures.append(name)

MAIN = ["bun", os.path.join(ROOT, "src/main.ts")]
t = Term(MAIN + ["-s", SESSION, "--profile", profile, f"{BASE}/article-blog.html"], cols=140, rows=40, cwd=ROOT)

def ctl(*args):
    env = dict(os.environ, XDG_RUNTIME_DIR=t.runtime_dir, TERMIUM_NO_UPDATE_CHECK="1")
    r = subprocess.run(MAIN + ["ctl", "-s", SESSION, "--json", *args], capture_output=True, text=True, env=env, timeout=60)
    return json.loads(r.stdout) if r.returncode == 0 and r.stdout.strip() else {"error": r.stderr.strip(), "code": r.returncode}

def url():
    tabs = ctl("tabs")
    return next((x["url"] for x in tabs if x.get("active")), "") if isinstance(tabs, list) else ""

def pane():
    return "\n".join(t.line(r) for r in range(3, t.rows + 1))

def leader(key):
    t.key("ctrl+b"); time.sleep(0.1); t.key(key); time.sleep(0.1)

def images_since(mark):
    with t.lock:
        return [i for i in t.placements if i not in mark]

try:
    check("blog loads", t.wait_text("Why I read the web", 25))
    check("an article offers reader mode in the address bar", t.wait_for(lambda: "≡ Reader" in t.line(2), 15), t.line(2))
    t.wait_idle(0.8, 10)
    t.shot(f"{OUT}/01-blog-page.png")

    # Toggle on with the key: the article as text.
    mark = set(t.placements)
    leader("shift+r")
    check("reader shows the article text", t.wait_text("The problem with pages", 15), pane()[:300])
    text = pane()
    check("title, byline and body", "Why I read the web in a terminal" in text and "Ada Byron" in text and "The terminal has outlived" in text)
    check("site navigation is left out", "Privacy" not in text and "RSS" not in text, text[:400])
    check("list bullets and quote gutter", "• Short lines are easier to read." in text and "│ The best interface" in text, text)
    check("nested list indented", "  ◦ A nested point" in text, text)
    check("address bar shows the way back", "≡ Page" in t.line(2), t.line(2))
    check("status line lists the keys", "^B R: page" in t.line(t.rows), t.line(t.rows))
    lines = [t.line(r) for r in range(3, t.rows)]
    longest = max(len(l.rstrip()) - (len(l) - len(l.lstrip())) for l in lines if l.strip())
    check("a readable column (≤ 80 cells)", longest <= 80, longest)
    t.shot(f"{OUT}/02-blog-reader.png")

    # Scrolling: keys and wheel.
    first = t.line(3)
    t.key("j"); time.sleep(0.2)
    check("j scrolls a line", t.wait_for(lambda: t.line(3) != first, 3))
    t.key("space"); time.sleep(0.2)
    check("space pages down", "Closing thoughts" in pane() or "Numbered steps" in pane(), pane()[:200])
    before = pane()
    t.scroll(600, 400, down=True, n=3); time.sleep(0.3)
    check("wheel scrolls", pane() != before)
    t.key("g"); time.sleep(0.2)
    check("g goes back to the top", "Why I read the web in a terminal" in t.line(3), t.line(3))
    t.key("shift+g"); time.sleep(0.2)
    check("G goes to the end", "Read the news next" in pane() and "100%" in t.line(t.rows), t.line(t.rows))

    # Select mode: the terminal selects (mouse reporting off), any key returns.
    mark_raw = len(t.raw)
    t.key("s"); time.sleep(0.3)
    check("s turns mouse reporting off for the terminal to select", b"\x1b[?1003l" in bytes(t.raw[mark_raw:]))
    check("select mode is shown", "SELECT" in t.line(t.rows), t.line(t.rows))
    mark_raw = len(t.raw)
    t.key("escape"); time.sleep(0.3)
    check("Esc turns it back on", b"\x1b[?1003h" in bytes(t.raw[mark_raw:]) and "SELECT" not in t.line(t.rows))

    # Copy as Markdown.
    mark_raw = len(t.raw)
    t.key("y"); time.sleep(0.4)
    check("y copies the article (OSC 52)", b"\x1b]52;c;" in bytes(t.raw[mark_raw:]))

    # Links: Tab focuses, Enter follows (reader mode stays on for the next page).
    t.key("g"); time.sleep(0.2)
    t.key("tab"); time.sleep(0.2)
    t.key("enter")
    check("Enter on a link follows it, still in reader mode", t.wait_text("Configuring the widget server", 20), pane()[:300])
    check("...to the docs page", t.wait_for(lambda: "article-docs.html" in url(), 10), url())
    text = pane()
    check("code blocks keep their lines", "▏ port = 8080" in text and "▏ [server]" in text, text)
    check("code language label", "▏ toml" in text, text)
    check("docs sidebar is left out", "Deploy" not in text, text[:500])
    t.shot(f"{OUT}/03-docs-reader.png")

    # Clicking a link: find the row with it.
    t.key("shift+g"); time.sleep(0.3)
    check("table columns line up", any("port         │ 3000    │ Where it listens" in t.line(r) for r in range(3, t.rows)), pane())
    row = next((r for r in range(3, t.rows) if "the blog post" in t.line(r)), None)
    check("the docs page links to the blog", row is not None, pane())
    if row is not None:
        c = t.line(row).index("the blog post")
        t.click_cell(c + 3, row)
        check("clicking a link follows it", t.wait_for(lambda: "article-blog.html" in url(), 10), url())
        check("...and reads the next article", t.wait_text("The problem with pages", 15), pane()[:300])

    # Toggle back: the picture returns.
    mark = set(t.placements)
    t.key("escape")
    check("Esc shows the page again", t.wait_for(lambda: len(images_since(mark)) > 0, 10))
    check("address bar offers reader again", t.wait_for(lambda: "≡ Reader" in t.line(2), 5), t.line(2))
    check("reader text is gone", t.wait_for(lambda: "^B R: page" not in t.line(t.rows), 5))

    # ctl reader, on a news page with clutter.
    r = ctl("open", f"{BASE}/article-news.html")
    t.wait_idle(0.8, 10)
    check("news page offers reader", t.wait_for(lambda: "≡ Reader" in t.line(2), 15), t.line(2))
    t.shot(f"{OUT}/04-news-page.png")
    r = ctl("reader", "on")
    check("ctl reader on", r.get("on") is True and r.get("readable") is True, r)
    check("news article shown", t.wait_text("A tram depot that stood empty", 10), pane()[:300])
    text = pane()
    check("ads, trending, comments and cookie banner left out",
          not any(x in text for x in ("ADVERTISEMENT", "Trending", "first!", "We use cookies")), text)
    check("image alt text shown", "[image: The depot's new reading room]" in text, text)
    t.shot(f"{OUT}/05-news-reader.png")
    # Clicking the address-bar button turns it off.
    c = t.line(2).index("≡ Page")
    mark = set(t.placements)
    t.click_cell(c + 3, 2)
    check("the address-bar button shows the page again", t.wait_for(lambda: len(images_since(mark)) > 0 and "≡ Reader" in t.line(2), 10), t.line(2))
    r = ctl("reader")
    check("ctl reader toggles on", r.get("on") is True, r)
    r = ctl("reader", "off")
    check("ctl reader off", r.get("on") is False, r)

    # Not an article: no button, and asking anyway says so.
    ctl("open", f"{BASE}/not-article.html")
    t.wait_idle(0.8, 10)
    time.sleep(1.5)
    check("a sign-in form offers no reader", "≡ Reader" not in t.line(2), t.line(2))
    t.shot(f"{OUT}/06-not-article.png")
    mark_raw = len(t.raw)
    r = ctl("reader", "on")
    check("ctl reader on a non-article stays off", r.get("on") is False and r.get("readable") is False, r)
    check("and says why", t.wait_text("no article found in tab", 5), t.line(2))
    check("the page itself is shown again", "≡" not in t.line(2) and "^B R: page" not in t.line(t.rows), t.line(t.rows))

    # A #fragment link scrolls the reader to its target.
    ctl("open", f"{BASE}/article-blog.html")
    r = ctl("reader", "on")
    check("reader on the blog again", r.get("on") is True and t.wait_text("The problem with pages", 10), r)
    row = next((r for r in range(3, t.rows) if "Skip to the closing thoughts" in t.line(r)), None)
    check("the skip link is on screen", row is not None, pane())
    if row is not None:
        t.click_cell(t.line(row).index("Skip to the closing") + 3, row)
        # (Near the end, it can only come as far up as the end of the article allows.)
        check("a #fragment link scrolls to its target", t.wait_for(lambda: "Closing thoughts" in pane() and "100%" in t.line(t.rows), 5), pane())
        check("...and the address has the fragment", url().endswith("#closing"), url())

    # A list item's id is a target too.
    t.key("g"); time.sleep(0.3)
    row = next((r for r in range(3, t.rows) if "the last step" in t.line(r)), None)
    if row is not None:
        t.click_cell(t.line(row).index("the last step") + 3, row)
        check("a #fragment to a list item scrolls to it", t.wait_for(lambda: "3. Read." in t.line(3), 5), t.line(3))
    else:
        check("the last-step link is on screen", False, pane())

    # The reading position is kept inside a paragraph (not just the paragraph).
    t.key("g"); time.sleep(0.2)
    for _ in range(20):
        t.key("j"); time.sleep(0.08)
        top = t.line(3)[22:].strip()  # (past the sidebar)
        if top and top[0].islower():
            break
    time.sleep(0.3)
    top = t.line(3)
    check("scrolled to the middle of a paragraph", top[22:].strip()[:1].islower(), top)
    mark = set(t.placements)
    t.key("escape")
    t.wait_for(lambda: len(images_since(mark)) > 0, 10)
    leader("shift+r")
    check("toggling back returns to the same line", t.wait_for(lambda: t.line(3) == top, 10), (t.line(3), top))

    # A row hidden under the status line can't be clicked.
    t.key("g"); time.sleep(0.3)
    row = next((r for r in range(3, t.rows) if "an outside page" in t.line(r)), None)
    if row is not None:
        col = t.line(row).index("an outside page") + 3
        t.resize(140, row); time.sleep(1.0)
        check("after a resize the link sits under the status line", "^B R: page" in t.line(row) and "an outside page" not in t.line(row), t.line(row))
        before_url = url()
        t.click_cell(col, row); time.sleep(1.5)
        check("clicking the status line follows no hidden link", url() == before_url, url())
        t.resize(140, 40); time.sleep(1.0)
    else:
        check("the outside link is on screen", False, pane())

    # Select mode in a pane that closes: mouse reporting comes back.
    leader("v"); time.sleep(1.5)
    t.key("escape"); time.sleep(0.3)
    leader("h"); time.sleep(0.3)
    t.key("s"); time.sleep(0.3)
    raw_off = len(t.raw)
    check("select mode in the left pane", "SELECT" in t.text(), t.line(t.rows))
    tabs = ctl("tabs")
    left = next((x["id"] for x in tabs if "article-blog" in x["url"]), None) if isinstance(tabs, list) else None
    ctl("close", str(left), "--force")
    check("closing it turns mouse reporting back on", t.wait_for(lambda: b"\x1b[?1003h" in bytes(t.raw[raw_off:]), 5))

    # An article filled in after the page loaded is still offered.
    ctl("open", f"{BASE}/article-late.html")
    check("a late article gets the reader button", t.wait_for(lambda: "≡ Reader" in t.line(2), 15), t.line(2))

    # Reader mode asked for while a slow page is still on its way reads that page.
    ctl("eval", f"location.href = '{BASE}/article-news.html?delay=3'")
    time.sleep(0.3)
    r = ctl("reader", "on")
    check("ctl reader on during a slow navigation reads the new page", r.get("on") is True, r)
    check("...its article", t.wait_text("A tram depot that stood empty", 10), pane()[:300])

    # Following a link (here: ctl open) to an address with a #fragment opens there.
    ctl("open", f"{BASE}/article-docs.html#from-code")
    # (The docs article is short: the section comes as far up as the end allows.)
    ok = t.wait_for(lambda: "From code" in pane() and "Configuring the widget" not in pane() and "100%" in t.line(t.rows), 15)
    check("a new page's #fragment opens the reader there", ok, pane()[:600])

    # Resizing back and forth keeps the same line on top.
    t.key("j"); t.key("j"); time.sleep(0.3)
    top = t.line(3)[22:].strip()
    for _ in range(3):
        t.resize(88, 40); time.sleep(0.6)
        t.resize(140, 40); time.sleep(0.6)
    check("resizing back and forth doesn't move the text", t.line(3)[22:].strip() == top, (t.line(3), top))

    # In reader mode, a page whose article comes late is read once it's there.
    ctl("open", f"{BASE}/article-late.html")
    check("a late article is read (reader mode stays on)", t.wait_text("An article that arrives late", 15) and "^B R: page" in t.line(t.rows), pane()[:300])

    # ctl reader keeps to its --timeout while the page is still on its way.
    r = ctl("reader", "off")
    check("ctl reader off (before the slow page)", r.get("on") is False, r)
    # (Started from the page: `ctl open` itself returns only once the slow page answers.)
    ctl("eval", f"location.href = '{BASE}/article-news.html?delay=4&x=2'")
    time.sleep(0.3)
    t0 = time.time()
    r = ctl("--timeout", "0.5", "reader", "on")
    took = time.time() - t0
    check("ctl reader --timeout 0.5 gives up in time", r.get("code") == 4 and took < 3, (r, round(took, 2)))
    time.sleep(4.5)
    check("...and leaves reader mode off", "^B R: page" not in t.line(t.rows) and "≡ Page" not in t.line(2), t.line(2))
finally:
    t.close()
    srv.terminate()
    shutil.rmtree(profile, ignore_errors=True)

print(f"\n{len(failures)} failure(s)" + (": " + ", ".join(failures) if failures else ""), f"(screens in {OUT})")
sys.exit(1 if failures else 0)
