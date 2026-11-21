#!/usr/bin/env python3
"""Take README screenshots of termium running in a real Ghostty window.

    scripts/screenshots.sh            # opens Ghostty and runs this inside it

Runs inside the Ghostty window: termium runs in a PTY whose output goes to
Ghostty (which renders it and answers its queries) while this script types
the scenario. Screenshots capture the active window with Spectacle (KDE).
"""
import os, subprocess, sys, tempfile, time
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
from drive import Term

OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)
profile = tempfile.mkdtemp(prefix="termium-shots-")

def shot(name):
    time.sleep(0.6)
    subprocess.run(["spectacle", "-b", "-n", "-a", "-o", os.path.join(OUT, name)], check=False)
    time.sleep(0.4)

t = Term(["bun", os.path.join(ROOT, "src/main.ts"), "--profile", profile,
          "https://en.wikipedia.org/wiki/Terminal_emulator"], cwd=ROOT, passthrough=True)
try:
    t.wait_text("Terminal emulator", 30); time.sleep(5)
    shot("browse.png")

    # split right with Hacker News
    t.key("ctrl+b"); t.key("v"); time.sleep(1.5)
    t.type("news.ycombinator.com"); t.key("enter"); time.sleep(6)
    shot("split.png")

    # a second space with a few tabs
    t.key("ctrl+b"); t.key("shift+n"); time.sleep(1.5)
    t.type("github.com/trending"); t.key("enter"); time.sleep(3)
    t.key("ctrl+b"); t.key("shift+w"); time.sleep(0.5)
    t.key("ctrl+a"); t.key("ctrl+k"); t.type("research"); t.key("enter")
    t.key("ctrl+t"); time.sleep(1.2); t.type("lobste.rs"); t.key("enter"); time.sleep(6)
    shot("spaces.png")

    t.key("ctrl+b"); t.key("question"); time.sleep(1)
    shot("help.png")
    t.key("escape"); time.sleep(0.5)
finally:
    t.close()
    subprocess.run(["rm", "-rf", profile])
