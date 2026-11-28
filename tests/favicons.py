#!/usr/bin/env python3
"""Site icons in the tab bar and sidebar: real termium + real headless Helium.

Pages with a png, an svg, an ico (/favicon.ico) and a cross-origin icon get
pictures one cell row high and two cells wide before their titles; a page
without one gets a coloured dot, as does every page when pictures go
through unicode placeholders (tmux). Switching tabs never clears the screen
outside a synchronized update.

Usage: python3 tests/favicons.py [outdir]
"""
import os, shutil, socket, subprocess, sys, tempfile, time
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
from drive import Term
from PIL import Image, ImageDraw

OUT = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="termium-favicons-")
os.makedirs(OUT, exist_ok=True)
site = tempfile.mkdtemp(prefix="termium-favicons-site-")
PY = shutil.which("python3") or sys.executable


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def icon(path, colour, fmt=None, sizes=None):
    im = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    ImageDraw.Draw(im).ellipse((2, 2, 61, 61), fill=colour)
    im.save(path, format=fmt, sizes=sizes) if sizes else im.save(path)


# Two origins: "a" has a /favicon.ico; "b" has none (its pages link theirs).
A, B = os.path.join(site, "a"), os.path.join(site, "b")
os.makedirs(A); os.makedirs(B)
PA, PB = free_port(), free_port()
icon(os.path.join(A, "favicon.ico"), (60, 120, 230, 255), "ICO", [(16, 16), (32, 32), (48, 48)])
icon(os.path.join(A, "green.png"), (60, 200, 90, 255))
icon(os.path.join(B, "red.png"), (230, 60, 60, 255))
for d in (A, B):
    with open(os.path.join(d, "star.svg"), "w") as f:
        f.write('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#f5a623" d="M12 2l3 7h7l-5.5 4.5L18.5 21 12 16.5 5.5 21l2-7.5L2 9h7z"/></svg>')
PAGES = {
    "png": (B, PB, '<link rel="icon" href="/red.png">'),
    "svg": (B, PB, '<link rel="icon" type="image/svg+xml" href="/star.svg">'),
    "ico": (A, PA, ""),
    "cross": (B, PB, f'<link rel="icon" href="http://127.0.0.1:{PA}/green.png">'),
    "none": (B, PB, ""),
    # An inline (data:) SVG icon.
    "data": (B, PB, '<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 8 8%22%3E%3Crect width=%228%22 height=%228%22 fill=%22%23a040e0%22/%3E%3C/svg%3E">'),
    # Its CSP keeps images to its own origin: the other origin's SVG can't be drawn, the png can.
    "cspsvg": (B, PB, f'<meta http-equiv="Content-Security-Policy" content="img-src \'self\'"><link rel="icon" href="http://127.0.0.1:{PA}/star.svg?csp"><link rel="icon" sizes="32x32" href="/red.png?alt">'),
    # Same-origin SVG only, under a CSP that keeps images to the page's origin.
    "svgself": (B, PB, '<meta http-equiv="Content-Security-Policy" content="img-src \'self\'"><link rel="icon" href="/star.svg?self">'),
    # A binary PNG percent-encoded in a data: URL.
    "pctpng": (B, PB, '<link rel="icon" href="data:image/png,' + __import__("urllib.parse").parse.quote(open(os.path.join(A, "green.png"), "rb").read(), safe="") + '">'),
    # A script swaps the icon (and the title) after the page has loaded.
    "swap": (B, PB, '<link rel="icon" href="/red.png?swap"><script>setTimeout(() => { document.querySelector("link").href = "/star.svg?swap"; document.title = "swapped page"; }, 2500)</script>'),
    # A page whose CSP lets nothing load: a dot, and no harm done.
    "csp": (B, PB, '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'"><link rel="icon" href="/red.png?csp">'),
}
for name, (d, _, head) in PAGES.items():
    with open(os.path.join(d, f"{name}.html"), "w") as f:
        f.write(f"<!doctype html><title>{name} page</title>{head}<h1>{name}</h1>")
# A third origin whose server holds requests for /hang* (an icon that never comes).
C = os.path.join(site, "c"); os.makedirs(C)
PC = free_port()
icon(os.path.join(C, "favicon.ico"), (60, 120, 230, 255), "ICO", [(16, 16), (32, 32)])
Image.new("RGBA", (16, 16), (230, 60, 60, 255)).save(os.path.join(C, "red16.png"))
SLOW = {
    # Its link never answers: /favicon.ico still shows, without waiting for it.
    "stall": '<link rel="icon" href="/hang.png">',
    # A linked /favicon.ico (32px) outranks a 16px png.
    "ranked": '<link rel="icon" sizes="16x16" href="/red16.png"><link rel="icon" sizes="32x32" href="/favicon.ico">',
    # The icon changes while the first lookup still waits: the change isn't lost.
    # Same site as "ranked", but its own links all hang: no leftover icon meanwhile.
    "allhang": '<link rel="icon" href="/hang3.png"><link rel="icon" href="/hang4.png">',
    "swapbusy": '<link rel="icon" href="/hang2.png"><script>setTimeout(() => { document.querySelector("link").href = "/red16.png"; document.title = "swapbusy changed"; }, 1000)</script>',
}
for name, head in SLOW.items():
    with open(os.path.join(C, f"{name}.html"), "w") as f:
        f.write(f"<!doctype html><title>{name} page</title>{head}<h1>{name}</h1>")
HANG = """
import http.server, sys, time
class H(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/hang"):
            time.sleep(20); self.send_error(404); return
        super().do_GET()
    def log_message(self, *a): pass
http.server.ThreadingHTTPServer.daemon_threads = True
http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), lambda *a: H(*a, directory=sys.argv[2])).serve_forever()
"""
servers = [subprocess.Popen([PY, "-m", "http.server", str(p), "--bind", "127.0.0.1", "--directory", d],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) for d, p in ((A, PA), (B, PB))]
servers.append(subprocess.Popen([PY, "-c", HANG, str(PC), C], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
time.sleep(0.5)
url = lambda name: f"http://127.0.0.1:{PAGES[name][1]}/{name}.html"

failures = []
def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else f"  {detail}"), flush=True)
    if not cond:
        failures.append(name)


def icons_on_row(t, row):
    """Pictures placed on a row two cells wide and one high: {col: png bytes}."""
    with t.lock:
        return {c: t.images[i] for i, (r, c, w, h) in t.placements.items() if r == row and w == 2 and h == 1}


def colour_of(png):
    im = Image.open(__import__("io").BytesIO(png)).convert("RGBA")
    px = [p for p in list(im.getdata()) if p[3] > 200]
    if not px:
        return None
    return tuple(sum(p[i] for p in px) // len(px) for i in range(3))


FIRST = ("png", "svg", "ico", "cross", "data", "cspsvg", "csp", "none")


def open_tabs(t):
    t.type(url("png")); t.key("enter")
    for name in FIRST[1:]:
        time.sleep(0.4)
        t.key("ctrl+t"); time.sleep(0.4); t.type(url(name)); t.key("enter")
    t.wait_for(lambda: "none page" in t.line(1), 15)
    time.sleep(2)
    t.wait_idle(0.8, 10)


try:
    with Term(["bun", os.path.join(ROOT, "src/main.ts"), "--incognito"], cols=200, rows=40) as t:
        open_tabs(t)
        line = t.line(1)
        tabs = {name: line.find(f"{name} page") for name in PAGES}
        print("tab bar:", line.rstrip())
        placed = icons_on_row(t, 1)
        expect = {"png": (230, 60, 60), "svg": (245, 166, 35), "ico": (60, 120, 230), "cross": (60, 200, 90), "data": (160, 64, 224), "cspsvg": (230, 60, 60)}
        for name, rgb in expect.items():
            col = tabs[name] - 2 + 1  # icon cells come right before the title (1-based)
            png = placed.get(col)
            got = colour_of(png) if png else None
            check(f"{name} icon in its tab", got is not None and all(abs(a - b) < 40 for a, b in zip(got, rgb)), (col, sorted(placed), got))
        for name in ("none", "csp"):
            check(f"{name}: a dot, no picture", tabs[name] - 1 not in placed and line[tabs[name] - 2] == "●", line)
        # The icon is drawn at the cell's pixel size, two cells wide.
        some = next(iter(placed.values()), None)
        if some:
            im = Image.open(__import__("io").BytesIO(some))
            check("icon is two cells' pixels", im.size == (2 * t.cell_w, t.cell_h), im.size)
        # Sidebar: the active space's current tab (the last one opened: no icon).
        side = icons_on_row(t, 3)
        check("sidebar shows the current tab's dot", "●" in t.line(3)[3:8] and not side, (t.line(3), side))
        t.shot(f"{OUT}/01-tabs.png")

        # Switch to the png tab: the sidebar shows its icon; nothing flickers.
        mark = len(t.raw)
        t.key("ctrl+b"); t.key("1"); time.sleep(1.0); t.wait_idle(0.6, 5)
        side = icons_on_row(t, 3)
        check("sidebar shows the png tab's icon", any(colour_of(p) and colour_of(p)[0] > 180 for p in side.values()), (t.line(3), list(side)))
        check("no unsynchronized clear when switching tabs", not t.unsynced_clears(mark), t.unsynced_clears(mark))
        count = len(icons_on_row(t, 1))
        check("tab icons still all shown after the switch", count == 6, count)
        t.shot(f"{OUT}/02-switched.png")

        # Chrome redraws that change nothing (a toast) leave the icons alone.
        mark = len(t.raw)
        t.key("ctrl+b"); t.key("b"); time.sleep(0.6); t.key("ctrl+b"); t.key("b"); time.sleep(0.8)
        t.key("alt+="); time.sleep(0.6); t.key("alt+0"); time.sleep(0.8)
        t.wait_idle(0.6, 5)
        check("icons survive sidebar toggles and zoom", len(icons_on_row(t, 1)) == 6 and len(icons_on_row(t, 3)) == 1,
              (sorted(icons_on_row(t, 1)), sorted(icons_on_row(t, 3))))
        check("no unsynchronized clears meanwhile", not t.unsynced_clears(mark), t.unsynced_clears(mark))

    # Same-origin SVG under a strict CSP, percent-encoded data:, a swapped icon, navigation.
    with Term(["bun", os.path.join(ROOT, "src/main.ts"), "--incognito"], cols=200, rows=40) as t:
        t.type(url("svgself")); t.key("enter")
        for name in ("pctpng", "swap"):
            time.sleep(0.4)
            t.key("ctrl+t"); time.sleep(0.4); t.type(url(name)); t.key("enter")
        t.wait_for(lambda: "swap page" in t.line(1), 15)
        time.sleep(1.5); t.wait_idle(0.6, 5)

        def tab_icon(name):
            line = t.line(1)
            col = line.find(f"{name} page") - 1
            png = icons_on_row(t, 1).get(col)
            return (colour_of(png) if png else None), line[col - 1] if col > 0 else ""
        near = lambda got, rgb: got is not None and all(abs(a - b) < 40 for a, b in zip(got, rgb))
        for name, rgb in (("svgself", (245, 166, 35)), ("pctpng", (60, 200, 90)), ("swap", (230, 60, 60))):
            got, _ = tab_icon(name)
            check(f"{name} icon in its tab", near(got, rgb), (got, t.line(1)))
        t.wait_for(lambda: "swapped page" in t.line(1), 8); time.sleep(2.5); t.wait_idle(0.6, 5)
        got, _ = tab_icon("swapped")
        check("a script's new icon replaces the old one", near(got, (245, 166, 35)), (got, t.line(1)))

        # Same site, no icon: the old one goes, a dot shows (tab and sidebar).
        t.key("ctrl+l"); time.sleep(0.3); t.type(url("none")); t.key("enter")
        t.wait_for(lambda: "none page" in t.line(1), 10); time.sleep(2); t.wait_idle(0.6, 5)
        got, ch = tab_icon("none")
        check("navigating to a page without an icon: a dot", got is None and ch == "●", (got, ch, t.line(1)))
        check("...and the sidebar shows no picture", not icons_on_row(t, 3) and "●" in t.line(3)[3:8], t.line(3))
        # Another site: its own icon, in the tab and the sidebar.
        t.key("ctrl+l"); time.sleep(0.3); t.type(url("ico")); t.key("enter")
        t.wait_for(lambda: "ico page" in t.line(1), 10); time.sleep(2); t.wait_idle(0.6, 5)
        got, _ = tab_icon("ico")
        side = list(icons_on_row(t, 3).values())
        check("navigating to another site: its icon", near(got, (60, 120, 230)), (got, t.line(1)))
        check("...in the sidebar too", len(side) == 1 and near(colour_of(side[0]), (60, 120, 230)), len(side))
        with t.lock:
            n = len(t.placements)
        check("no picture left behind", n == 3 + 1 + 1, n)  # 3 tab icons, 1 sidebar icon, 1 page
        t.shot(f"{OUT}/03-navigation.png")

    # Icons that hang, a linked /favicon.ico, an icon changed during a lookup.
    with Term(["bun", os.path.join(ROOT, "src/main.ts"), "--incognito"], cols=200, rows=40) as t:
        curl = lambda name: f"http://127.0.0.1:{PC}/{name}.html"
        t.type(curl("stall")); t.key("enter")
        t0 = time.time()
        for name in ("ranked", "swapbusy"):
            time.sleep(0.4)
            t.key("ctrl+t"); time.sleep(0.4); t.type(curl(name)); t.key("enter")
        def tab_icon(title):
            col = t.line(1).find(title if " " in title else f"{title} page") - 1
            png = icons_on_row(t, 1).get(col)
            return colour_of(png) if png else None
        near = lambda got, rgb: got is not None and all(abs(a - b) < 40 for a, b in zip(got, rgb))
        ok = t.wait_for(lambda: near(tab_icon("stall"), (60, 120, 230)), 12)
        check("an icon that never answers doesn't hold up /favicon.ico", ok, (tab_icon("stall"), round(time.time() - t0, 1)))
        check("a linked 32px /favicon.ico outranks a 16px png", t.wait_for(lambda: near(tab_icon("ranked"), (60, 120, 230)), 8), tab_icon("ranked"))
        ok = t.wait_for(lambda: near(tab_icon("swapbusy changed"), (230, 60, 60)), 15)
        check("an icon changed during a lookup still shows", ok, (tab_icon("swapbusy changed"), t.line(1)))

        # Tab 3 (red, a link the new page lacks) goes to a same-site page whose links hang.
        t.key("ctrl+b"); t.key("3"); time.sleep(0.5)
        t.key("ctrl+l"); time.sleep(0.3); t.type(curl("allhang")); t.key("enter")
        t.wait_for(lambda: "allhang page" in t.line(1) and "◌" not in t.line(1), 10)
        time.sleep(1.5)
        check("same site, new links: no leftover icon while they're fetched", tab_icon("allhang") is None, tab_icon("allhang"))
        check("...then /favicon.ico", t.wait_for(lambda: near(tab_icon("allhang"), (60, 120, 230)), 12), tab_icon("allhang"))
        # Reloaded: the links that hung are skipped for a while, so it shows at once.
        t0 = time.time()
        t.key("ctrl+r")
        t.wait_for(lambda: "◌" in t.line(1), 3); t.wait_for(lambda: "◌" not in t.line(1), 10)
        ok = t.wait_for(lambda: near(tab_icon("allhang"), (60, 120, 230)), 10)
        check("icons that hung aren't waited for again", ok and time.time() - t0 < 4, round(time.time() - t0, 1))

    # Through tmux (unicode placeholders), no pictures in the chrome: dots.
    with Term(["bun", os.path.join(ROOT, "src/main.ts"), "--incognito"], cols=200, rows=40,
              env={"TERMIUM_GRAPHICS": "placeholders"}) as t:
        open_tabs(t)
        line = t.line(1)
        print("tab bar (placeholders):", line.rstrip())
        with t.lock:
            chrome = [p for p in t.placements.values() if p[0] <= 2]
        dots = [line[line.find(f"{n} page") - 2] for n in FIRST]
        check("placeholders: dots, no pictures in the chrome", not chrome and dots == ["●"] * len(FIRST), (chrome, dots))
        t.shot(f"{OUT}/04-placeholders.png")
finally:
    for s in servers:
        s.terminate()
    shutil.rmtree(site, ignore_errors=True)

print(f"\nshots in {OUT}")
print("FAILED: " + ", ".join(failures) if failures else "ALL PASS")
sys.exit(1 if failures else 0)
