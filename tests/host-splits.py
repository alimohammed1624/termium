#!/usr/bin/env python3
"""termium open --split and termium ctl split, against the real stack.

The outer terminal is drive.Term (it composites kitty graphics). Inside it
run a private tmux server (its own -L socket and config), then a private,
uniquely named herdr session with a home of its own; neither touches the
user's. termium's own directories are private too, and set only in the
calling pane's shell: the split must pass them on to the new pane.

Checks: `termium open URL --split right` makes a real split next to the
calling pane, which attaches and shows the page; `ctl split down` adds one
and leaves the focus where it was; a host that can't split fails clearly
and starts no session.

Usage: python3 tests/host-splits.py [outdir]   (screenshots land in outdir)
"""
import json, os, re, shutil, subprocess, sys, tempfile, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
from drive import Term

failures = []
def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))
    if not cond:
        failures.append(name)

OUT = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="termium-splits-")
os.makedirs(OUT, exist_ok=True)
tmp = tempfile.mkdtemp(prefix="pr4-splits-")
rt = os.path.join(tmp, "run"); os.makedirs(rt, mode=0o700)
# Set in the calling pane's shell only (not in tmux's or herdr's environment).
EXPORTS = (f"export XDG_RUNTIME_DIR={rt} XDG_DATA_HOME={tmp}/data XDG_STATE_HOME={tmp}/state "
           "TERMIUM_NO_UPDATE_CHECK=1; cd " + ROOT)
CLI_ENV = dict(os.environ, XDG_RUNTIME_DIR=rt, XDG_DATA_HOME=f"{tmp}/data", XDG_STATE_HOME=f"{tmp}/state")
for k in ("TMUX", "TMUX_PANE", "HERDR_ENV", "HERDR_PANE_ID", "KITTY_WINDOW_ID", "WEZTERM_PANE", "TERM_PROGRAM"):
    CLI_ENV.pop(k, None)
TMUX_SOCK = f"pr4-splits-{os.getpid()}"
HERDR = shutil.which("herdr") or os.path.expanduser("~/.local/bin/herdr")
HERDR_SESSION = f"pr4-splits-{os.getpid()}"
BG = (0x33, 0x33, 0xcc)
PAGE = "data:text/html,<body style=\"background:%233333cc;color:white;font:40px sans-serif\"><h1>termium in a host split</h1>"
GREEN = (0x22, 0x99, 0x44)
PAGE2 = "data:text/html,<body style=\"background:%23229944\"><h1>second</h1>"

def cli(*args, env=None):
    return subprocess.run(["bun", os.path.join(ROOT, "src", "main.ts"), *args], cwd=ROOT, env=env or CLI_ENV,
                          capture_output=True, text=True, timeout=60)

def tmux(*args):
    return subprocess.run(["tmux", "-L", TMUX_SOCK, *args], capture_output=True, text=True)

def shows_page(t, path, right_of=0, colour=BG):
    """Some picture (through placeholders, or placed: herdr) is a rect right of
    column right_of whose middle is the page's colour."""
    t.shot(path)
    from PIL import Image
    im = Image.open(path).convert("RGB")
    with t.lock:
        placed = list(t.placements.values())
    for row, col, cols, rows in list(t.placeholder_images().values()) + placed:
        if col <= right_of:
            continue
        px = im.getpixel(((col - 1 + cols // 2) * t.cell_w, (row - 1 + rows // 2) * t.cell_h))
        if all(abs(a - b) < 12 for a, b in zip(px, colour)):
            return True, (row, col, cols, rows)
    return False, (list(t.placeholder_images().values()), placed)

sessions = []
try:
    # ------------------------------------------------------------- not a host that can split
    r = cli("open", "--split", "right", "-s", "pr4-nohost", PAGE, env=dict(CLI_ENV, TERM_PROGRAM="ghostty"))
    check("ghostty: --split fails clearly (exit 1)", r.returncode == 1 and "Ghostty" in r.stderr and "own splits" in r.stderr, r.stderr)
    check("ghostty: ...and starts no session", "pr4-nohost" not in cli("ls").stdout)
    r = cli("open", "--split", "left", PAGE)
    check("--split left is a usage error", r.returncode == 2 and "right or down" in r.stderr, r.stderr)
    r = cli("attach", "--split", "right")
    check("--split only with open", r.returncode == 2, r.stderr)

    # ------------------------------------------------------------- tmux
    conf = os.path.join(tmp, "tmux.conf")
    with open(conf, "w") as f:
        f.write("set -g status off\nset -g escape-time 10\nset -g allow-passthrough on\nset -g default-shell /bin/bash\n")
    t = Term(["tmux", "-L", TMUX_SOCK, "-f", conf, "new-session", "-s", "main", "-x", "160", "-y", "45"], cols=160, rows=45)
    time.sleep(1.5)
    tmux("send-keys", "-t", "main", EXPORTS, "Enter")
    tmux("send-keys", "-t", "main", f"bun src/main.ts open -s pr4-tmux '{PAGE}' --split right; echo OPEN_EXIT=$?", "Enter")
    sessions.append("pr4-tmux")
    ok = t.wait_for(lambda: re.search(r"OPEN_EXIT=\d", tmux("capture-pane", "-p", "-t", "main.0").stdout), 60)
    out0 = tmux("capture-pane", "-p", "-t", "main.0").stdout
    check("tmux: open --split right exits 0 and names the new pane", ok and "OPEN_EXIT=0" in out0 and "tmux split (pane %" in out0, out0[-500:])
    panes = tmux("list-panes", "-t", "main", "-F", "#{pane_index} #{pane_left} #{pane_top} #{pane_active} #{pane_start_command}").stdout.splitlines()
    check("tmux: a real split right of the calling pane", len(panes) == 2 and panes[1].split()[1] != "0" and panes[1].split()[2] == "0", panes)
    check("tmux: the new pane runs termium for the session, and has the focus", len(panes) == 2 and "--session pr4-tmux" in panes[1] and panes[1].split()[3] == "1", panes)
    check("tmux: it shows the page, in the new pane", t.wait_for(lambda: shows_page(t, f"{OUT}/tmux-open-split.png", 80)[0], 30),
          shows_page(t, f"{OUT}/tmux-open-split.png", 80)[1])
    check("tmux: the session runs (in the private runtime dir the pane was given)", "pr4-tmux" in cli("ls").stdout)

    # An agent's way: ctl split from the first pane, focus stays there.
    tmux("select-pane", "-t", "main.0")
    tmux("send-keys", "-t", "main.0", "clear; bun src/main.ts ctl -s pr4-tmux split down --json; echo CTL_EXIT=$?", "Enter")
    ok = t.wait_for(lambda: re.search(r"CTL_EXIT=\d", tmux("capture-pane", "-p", "-t", "main.0").stdout), 60)
    out0 = tmux("capture-pane", "-p", "-t", "main.0").stdout
    check("tmux: ctl split down exits 0 with JSON", ok and "CTL_EXIT=0" in out0 and '"host":"tmux"' in out0, out0[-500:])
    panes = tmux("list-panes", "-t", "main", "-F", "#{pane_index} #{pane_left} #{pane_top} #{pane_active} #{pane_start_command}").stdout.splitlines()
    check("tmux: ...a split below the calling pane, focus left there", len(panes) == 3 and panes[0].split()[3] == "1"
          and panes[1].split()[1] == "0" and panes[1].split()[2] != "0", panes)
    below = lambda: [r for r in t.placeholder_images().values() if r[0] > 3]
    check("tmux: ...which shows the page (taking it over from the right one)", t.wait_for(lambda: bool(below()), 30), t.placeholder_images())
    t.shot(f"{OUT}/tmux-ctl-split.png")

    # A URL for the running session is shown in the new pane, even while the
    # person at the terminal attached now is busy (editing the address).
    tmux("select-pane", "-t", "main.1")
    tmux("send-keys", "-t", "main.1", "C-l"); time.sleep(0.5)
    tmux("send-keys", "-t", "main.1", "-l", "a draft"); time.sleep(0.5)
    tmux("select-pane", "-t", "main.0")
    tmux("send-keys", "-t", "main.0", f"clear; bun src/main.ts ctl -s pr4-tmux split right '{PAGE2}'; echo URL_EXIT=$?", "Enter")
    ok = t.wait_for(lambda: re.search(r"URL_EXIT=\d", tmux("capture-pane", "-p", "-t", "main.0").stdout), 60)
    out0 = tmux("capture-pane", "-p", "-t", "main.0").stdout
    check("tmux: ctl split right URL, with the person busy, exits 0", ok and "URL_EXIT=0" in out0 and "opening" in out0, out0[-500:])
    check("tmux: ...and the new pane shows that URL's page", t.wait_for(lambda: shows_page(t, f"{OUT}/tmux-ctl-split-url.png", 40, GREEN)[0], 30),
          shows_page(t, f"{OUT}/tmux-ctl-split-url.png", 40, GREEN)[1])
    tabs = cli("ctl", "-s", "pr4-tmux", "tabs").stdout
    check("tmux: ...in a new tab, the focused one", any(l.startswith("*") and "229944" in l for l in tabs.splitlines()), tabs)

    # allow-passthrough off: termium couldn't show anything in the pane; said here, nothing started.
    sessions.append("pr4-tmux-off")
    tmux("set", "-g", "allow-passthrough", "off")
    tmux("send-keys", "-t", "main.0", f"clear; bun src/main.ts open -s pr4-tmux-off '{PAGE}' --split right; echo OFF_EXIT=$?", "Enter")
    ok = t.wait_for(lambda: re.search(r"OFF_EXIT=\d", tmux("capture-pane", "-p", "-t", "main.0").stdout), 60)
    out0 = tmux("capture-pane", "-p", "-t", "main.0").stdout
    check("tmux: passthrough off: --split fails clearly (exit 1)", ok and "OFF_EXIT=1" in out0 and "allow-passthrough" in out0, out0[-500:])
    check("tmux: ...and starts no session", "pr4-tmux-off" not in cli("ls").stdout)
    tmux("set", "-g", "allow-passthrough", "on")
    # What counts is what a new pane gets, not the calling pane's own setting.
    tmux("set", "-g", "allow-passthrough", "off"); tmux("set", "-p", "-t", "main.0", "allow-passthrough", "on")
    tmux("send-keys", "-t", "main.0", f"clear; bun src/main.ts ctl -s pr4-tmux split right; echo POFF_EXIT=$?", "Enter")
    ok = t.wait_for(lambda: re.search(r"POFF_EXIT=\d", tmux("capture-pane", "-p", "-t", "main.0").stdout), 60)
    out0 = tmux("capture-pane", "-p", "-t", "main.0").stdout
    check("tmux: passthrough off for new panes (on in this one) is refused", ok and "POFF_EXIT=1" in out0 and "allow-passthrough" in out0, out0[-500:])
    tmux("set", "-g", "allow-passthrough", "on"); tmux("set", "-pu", "-t", "main.0", "allow-passthrough")

    # No room for another pane: tmux refuses, and no session is left behind.
    tmux("new-window", "-t", "main")
    while tmux("split-window", "-h", "-t", "main:1").returncode == 0:  # (each split is of the newest, narrowest pane)
        pass
    narrow = tmux("display-message", "-p", "-t", "main:1", "#{pane_id}").stdout.strip()
    tmux("send-keys", "-t", narrow, EXPORTS, "Enter")
    nospace = os.path.join(tmp, "nospace")
    sessions.append("pr4-tmux-full")  # (ended at the end, should one start)
    tmux("send-keys", "-t", narrow, f"bun src/main.ts open -s pr4-tmux-full '{PAGE}' --split right 2>{nospace}.err; echo $? > {nospace}", "Enter")
    t.wait_for(lambda: os.path.exists(nospace) and open(nospace).read().strip() != "", 60)
    err = open(nospace + ".err").read() if os.path.exists(nospace + ".err") else ""
    check("tmux: no room for a split: exit 1, said clearly", os.path.exists(nospace) and open(nospace).read().strip() == "1" and "couldn't make the split" in err, err)
    check("tmux: ...and no session left running", "pr4-tmux-full" not in cli("ls").stdout)
    tmux("kill-window", "-t", "main:1")

    r = cli("ctl", "-s", "pr4-nosuch", "split", "right", env=dict(CLI_ENV, TMUX="x", TMUX_PANE="%0"))
    check("ctl split without the session: exit 3", r.returncode == 3, r.stderr)
    t.close()
    tmux("kill-server")

    # ------------------------------------------------------------- herdr
    if not os.path.exists(HERDR):
        print("SKIP herdr: not installed")
    else:
        HOME = os.path.join(tmp, "home"); os.makedirs(HOME)
        HENV = dict(HOME=HOME, XDG_CONFIG_HOME=os.path.join(HOME, ".config"), SHELL="/bin/bash")
        h = Term([HERDR, "--session", HERDR_SESSION], cols=160, rows=45, env=HENV)
        hc = lambda *a: subprocess.run([HERDR, "--session", HERDR_SESSION, *a], capture_output=True, text=True, env=dict(os.environ, **HENV))
        def panes():
            r = hc("pane", "list")
            try:
                return json.loads(r.stdout)["result"]["panes"] if r.returncode == 0 else []
            except (ValueError, KeyError):
                return []
        h.wait_for(lambda: bool(panes()), 60, 0.5)
        for _ in range(6):  # the first-run introduction: continue, then close it
            if not h.wait_for(lambda: "continue" in h.text() or "integration" in h.text().lower(), 3):
                break
            h.write("\r" if "continue" in h.text() else "\x1b"); time.sleep(1)
        first = panes()[0]["pane_id"]
        time.sleep(2)
        odd = os.path.join(tmp, "it's a dir"); os.makedirs(odd)
        shutil.copytree(os.path.join(ROOT, "src"), os.path.join(odd, "src"))  # (a link would be resolved)
        shutil.copy(os.path.join(ROOT, "package.json"), odd)
        hc("pane", "run", first, EXPORTS + ' && cd "$XDG_RUNTIME_DIR/../it\'s a dir"')
        time.sleep(0.5)
        hc("pane", "run", first, f"bun src/main.ts open -s pr4-herdr '{PAGE}' --split right; echo EXIT=$?")
        sessions.append("pr4-herdr")
        read = lambda: hc("pane", "read", first, "--source", "recent-unwrapped").stdout
        ok = h.wait_for(lambda: re.search(r"EXIT=\d", read()), 60)
        check("herdr: open --split right exits 0 and names the new pane", ok and "EXIT=0" in read() and "herdr split (pane" in read(), read()[-500:])
        ps = panes()
        check("herdr: a second pane", len(ps) == 2, ps)
        check("herdr: ...running termium from a path with a quote and a space", any("it's a dir/src/main.ts" in l for l in subprocess.run(
            ["ps", "-eo", "args"], capture_output=True, text=True).stdout.splitlines()))
        check("herdr: it shows the page, in the new pane", h.wait_for(lambda: shows_page(h, f"{OUT}/herdr-open-split.png", 93)[0], 30),
              shows_page(h, f"{OUT}/herdr-open-split.png", 93)[1])
        lay = hc("pane", "layout", "--pane", first).stdout
        print("herdr layout:", lay[:400].replace("\n", " "))
        h.close()
        hc("server", "stop")
finally:
    for s in sessions:
        cli("kill", s)
    tmux("kill-server")
    shutil.rmtree(tmp, ignore_errors=True)

print(f"\n{len(failures)} failed" if failures else "\nall passed")
print("screenshots in", OUT)
sys.exit(1 if failures else 0)
