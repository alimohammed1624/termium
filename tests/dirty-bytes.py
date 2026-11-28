#!/usr/bin/env python3
"""Bytes per second termium writes to the terminal, per scenario (issue #5).

    python3 tests/dirty-bytes.py [SECONDS] [--hidpi] [--json OUT]

Runs the real termium against real headless Helium in drive.py's PTY (which
answers like Ghostty) and counts what termium writes while:

  typing   typing into a text field
  blink    a page with a spinning loader and a blinking caret
  scroll   scrolling a long page with the mouse wheel
  video    a 640x360 video playing (made with ffmpeg)

and, for typing and scroll, checks that once things settle the picture on
screen (the full frame plus any patches over it) is the same as a full
repaint of the page: no stale patches.

With --hidpi the terminal has 20x40 px cells (a device scale factor of 2,
where frames come from full-resolution screenshots).

Everything (profile, runtime dir, the pages) lives in a private temp dir;
the pages are served on a free port.
"""
import json, os, re, shutil, socket, subprocess, sys, tempfile, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
from drive import Term
from PIL import Image, ImageChops

SECONDS = float(sys.argv[1]) if len(sys.argv) > 1 and not sys.argv[1].startswith("-") else 8.0
JSON_OUT = sys.argv[sys.argv.index("--json") + 1] if "--json" in sys.argv else None
SIZE = dict(cols=100, rows=30, cell_w=20, cell_h=40) if "--hidpi" in sys.argv else dict(cols=160, rows=45, cell_w=10, cell_h=20)

tmp = tempfile.mkdtemp(prefix="pr5-bytes-")
www = os.path.join(tmp, "www")
os.makedirs(www)
shutil.copy(os.path.join(ROOT, "tests", "fixtures", "page.html"), www)
with open(os.path.join(www, "blink.html"), "w") as f:
    f.write("""<!doctype html><meta charset=utf-8><title>blink</title>
<style>body{font:16px sans-serif;margin:20px}
.spin{width:32px;height:32px;border:4px solid #ddd;border-top-color:#36c;border-radius:50%;animation:s 1s linear infinite}
@keyframes s{to{transform:rotate(360deg)}}</style>
<h1>Loading…</h1><div class=spin></div><p>Some text that never changes.</p>
<input id=inp value="caret blinks here">""")
with open(os.path.join(www, "long.html"), "w") as f:
    paras = "\n".join(f"<h2>Section {i}</h2><p>" + ("Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. " * 6) + "</p>" for i in range(200))
    f.write(f"<!doctype html><title>long</title><style>body{{font:16px serif;margin:20px 60px}}</style>{paras}")
clip = os.path.join(www, "clip.webm")
subprocess.run(["ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-t", "20",
                "-c:v", "libvpx-vp9", "-b:v", "1M", "-deadline", "realtime", clip], check=True)
with open(os.path.join(www, "video.html"), "w") as f:
    f.write("""<!doctype html><title>video</title><style>body{font:16px sans-serif;margin:20px}</style>
<h1>A video</h1><video src="clip.webm" autoplay muted loop width=640 height=360></video><p>Text below the video.</p>""")

with socket.socket() as so:
    so.bind(("127.0.0.1", 0))
    PORT = so.getsockname()[1]
server = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1", "--directory", www],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
BASE = f"http://127.0.0.1:{PORT}"
results = {}
fails = []


def graphics_updates(raw: bytes) -> int:
    """Synchronized updates that carry a picture (a frame, or a set of patches)."""
    return sum(1 for seg in raw.split(b"\x1b[?2026h") if b"\x1b_Ga=T" in seg)


def page_shot(t: Term, path: str) -> Image.Image:
    t.shot(path)
    im = Image.open(path).convert("RGB")
    # The page area only (below termium's top rows, right of nothing).
    return im.crop((0, 2 * t.cell_h, im.width, im.height))


def measure(name, t: Term, act):
    start = len(t.raw)
    t0 = time.time()
    act()
    dt = time.time() - t0
    raw = bytes(t.raw[start:])
    results[name] = {"bytes_per_s": round(len(raw) / dt), "updates_per_s": round(graphics_updates(raw) / dt, 1),
                     "seconds": round(dt, 1)}
    print(f"{name:7s} {len(raw) / dt / 1024:10.1f} KiB/s  {graphics_updates(raw) / dt:6.1f} picture updates/s", flush=True)


def same_after_repaint(name, t: Term):
    """The settled picture equals a full repaint."""
    t.wait_idle(1.5, 10)
    a = page_shot(t, os.path.join(tmp, f"{name}-a.png"))
    # A resize there and back: termium redraws everything (full frames) at the original size.
    t.resize(t.cols - 1, t.rows)
    time.sleep(0.5)
    t.wait_idle(1.0, 10)
    mark = len(t.raw)
    t.resize(t.cols + 1, t.rows)
    time.sleep(0.5)
    t.wait_idle(1.5, 10)
    full = [m for m in re.findall(rb"\x1b_G(a=T[^;\x1b]*)", bytes(t.raw[mark:])) if b",z=" not in m]
    if not full:
        print(f"{name:7s} no full repaint came after the resize", flush=True)
        fails.append(name)
    b = page_shot(t, os.path.join(tmp, f"{name}-b.png"))
    diff = ImageChops.difference(a, b).getbbox()
    print(f"{name:7s} settled picture == full repaint: {'yes' if diff is None else f'NO, differs in {diff}'}", flush=True)
    if diff is not None:
        fails.append(name)
        shutil.copy(os.path.join(tmp, f"{name}-a.png"), f"/tmp/pr5-{name}-patched.png")
        shutil.copy(os.path.join(tmp, f"{name}-b.png"), f"/tmp/pr5-{name}-repaint.png")


def run_for(fn):
    end = time.time() + SECONDS
    while time.time() < end:
        fn()


try:
    prof = os.path.join(tmp, "profile")
    with Term(["bun", os.path.join(ROOT, "src/main.ts"), "--profile", prof, f"{BASE}/page.html"], cwd=ROOT, **SIZE) as t:
        # A point on the page (CSS px) in terminal pixels: the pane starts
        # below 2 top rows, right of the 22-column sidebar.
        dsf = max(1, round(t.cell_h / 19 * 4) / 4)
        at = lambda x, y: (int(22 * t.cell_w + x * dsf), int(2 * t.cell_h + y * dsf))
        t.wait_text("termium test page", 40)
        t.wait_idle(1.5, 20)
        # typing: click into the field, then type steadily.
        t.click(*at(130, 132))
        time.sleep(0.5)
        t.wait_idle(0.8, 10)
        word = iter("the quick brown fox jumps over the lazy dog " * 20)
        measure("typing", t, lambda: run_for(lambda: (t.type(next(word)), time.sleep(0.12))))
        t.click(*at(600, 100))  # blur the field: no caret blinking
        same_after_repaint("typing", t)

        def nav(url, text):
            t.key("ctrl+l"); time.sleep(0.3)
            t.type(url, 0.002); t.key("enter")
            t.wait_text(text, 30); time.sleep(1.5); t.wait_idle(1.0, 10)

        nav(f"{BASE}/blink.html", "blink")
        t.click(*at(100, 180))  # focus the field
        time.sleep(1)
        measure("blink", t, lambda: time.sleep(SECONDS))

        nav(f"{BASE}/long.html", "long")
        t.click(*at(400, 300))
        measure("scroll", t, lambda: run_for(lambda: (t.scroll(*at(400, 300), True, 1), time.sleep(0.1))))
        same_after_repaint("scroll", t)

        nav(f"{BASE}/video.html", "video")
        time.sleep(1)
        measure("video", t, lambda: time.sleep(SECONDS))
finally:
    server.terminate()
    shutil.rmtree(tmp, ignore_errors=True)

if JSON_OUT:
    with open(JSON_OUT, "w") as f:
        json.dump(results, f, indent=1)
print("FAIL: " + ", ".join(fails) if fails else "OK")
sys.exit(1 if fails else 0)
