#!/usr/bin/env python3
"""Update check and self-update against the real stack, with a fake GitHub.

Builds this checkout as a release binary (and the next patch version, as
release.yml would package it), serves fake `releases/latest` redirects,
SHA256SUMS and archives from a local HTTP server, and drives the compiled
termium (with real Helium) in PTYs: the badge, the update box only while
nothing else is open, later / skip / update, the restart into the new
binary, a checksum mismatch, offline and slow checks, attach / detach /
takeover, `termium check-update` and `termium update`, and a client of
another protocol version. Everything runs from temp dirs (binaries, XDG
dirs, sessions); nothing touches an installed termium.

Usage: python3 tests/update.py [screenshot-dir]
"""
import hashlib, http.server, json, os, re, shutil, signal, socketserver, stat, subprocess, sys, tempfile, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
from drive import Term

failures = []
def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""), flush=True)
    if not cond:
        failures.append(name)

tmp = tempfile.mkdtemp(prefix="tup-")
SHOTS = sys.argv[1] if len(sys.argv) > 1 else None
if SHOTS:
    os.makedirs(SHOTS, exist_ok=True)
def shot(t, name):
    if SHOTS:
        t.wait_idle(0.5, 5)
        t.shot(os.path.join(SHOTS, name))
CUR = json.load(open(os.path.join(ROOT, "package.json")))["version"]
maj, mnr, pat = map(int, CUR.split("."))
NEXT, BAD = f"{maj}.{mnr}.{pat + 1}", f"{maj}.{mnr}.{pat + 2}"
TARGET = {"x86_64": "x86_64", "aarch64": "aarch64", "arm64": "aarch64"}[os.uname().machine] + "-unknown-linux-gnu"
ASSET = f"termium-{TARGET}.tar.gz"

def build(version, out, protocol=None):
    """A release binary of this checkout claiming `version` (and speaking `protocol`)."""
    src = os.path.join(tmp, f"src-{version}-{protocol}")
    os.makedirs(src)
    shutil.copytree(os.path.join(ROOT, "src"), os.path.join(src, "src"))
    os.symlink(os.path.join(ROOT, "node_modules"), os.path.join(src, "node_modules"))
    pkg = json.load(open(os.path.join(ROOT, "package.json"))); pkg["version"] = version
    json.dump(pkg, open(os.path.join(src, "package.json"), "w"))
    if protocol is not None:
        p = os.path.join(src, "src", "session.ts")
        s = open(p).read(); open(p, "w").write(re.sub(r"export const PROTOCOL = \d+;", f"export const PROTOCOL = {protocol};", s))
    os.makedirs(os.path.dirname(out), exist_ok=True)
    subprocess.run(["bun", "build", "--compile", "--minify", "src/main.ts", "--outfile", out], cwd=src, check=True, capture_output=True)
    return out

def package(binary, tag, good=True):
    """dist/<tag>/ as release.yml makes it: the archive and SHA256SUMS (a wrong sum unless good)."""
    pkg = os.path.join(tmp, "pkg", tag, f"termium-{TARGET}")
    os.makedirs(pkg)
    shutil.copy(binary, os.path.join(pkg, "termium")); os.chmod(os.path.join(pkg, "termium"), 0o755)
    for f in ("README.md", "LICENSE", "CHANGELOG.md"):
        shutil.copy(os.path.join(ROOT, f), pkg)
    dist = os.path.join(tmp, "dist", tag); os.makedirs(dist)
    subprocess.run(["tar", "-C", os.path.dirname(pkg), "--owner=0", "--group=0", "--numeric-owner", "-czf",
                    os.path.join(dist, ASSET), os.path.basename(pkg)], check=True)
    h = hashlib.sha256(open(os.path.join(dist, ASSET), "rb").read()).hexdigest()
    if not good:
        h = hashlib.sha256(b"something else").hexdigest()
    open(os.path.join(dist, "SHA256SUMS"), "w").write(f"{h}  {ASSET}\n")

print(f"building termium {CUR} and {NEXT} ...", flush=True)
cur_bin = build(CUR, os.path.join(tmp, "build", "cur", "termium"))
next_bin = build(NEXT, os.path.join(tmp, "build", "next", "termium"))
proto_bin = build("9.9.9", os.path.join(tmp, "build", "proto", "termium"), protocol=999)
package(next_bin, f"v{NEXT}")
package(next_bin, f"v{BAD}", good=False)
sha = lambda p: hashlib.sha256(open(p, "rb").read()).hexdigest()

# ---- the fake GitHub
LATEST = {"tag": f"v{NEXT}"}
HITS = []
class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass
    def do_GET(self):
        if self.path.startswith("/latest") or self.path.startswith("/slow"):
            HITS.append((time.time(), self.path, self.headers.get("User-Agent")))
            if self.path.startswith("/slow"):
                time.sleep(10)
            self.send_response(302)
            self.send_header("Location", f"https://github.com/alimohammed1624/termium/releases/tag/{LATEST['tag']}")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if self.path.startswith("/dl/"):
            p = os.path.join(tmp, "dist", *self.path[4:].split("/"))
            if os.path.isfile(p):
                data = open(p, "rb").read()
                self.send_response(200); self.send_header("Content-Length", str(len(data))); self.end_headers()
                self.wfile.write(data)
            else:
                self.send_response(404); self.send_header("Content-Length", "0"); self.end_headers()
            return
        if self.path.startswith("/fixtures/"):
            p = os.path.join(ROOT, "tests", "fixtures", self.path[len("/fixtures/"):].split("?")[0])
            data = open(p, "rb").read()
            self.send_response(200); self.send_header("Content-Type", "text/html"); self.send_header("Content-Length", str(len(data))); self.end_headers()
            self.wfile.write(data)
            return
        self.send_response(404); self.send_header("Content-Length", "0"); self.end_headers()
class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    def handle_error(self, *a):
        pass  # a client that gave up (the 3 s timeout) closed the connection
httpd = Server(("127.0.0.1", 0), Handler)
PORT = httpd.server_address[1]
threading.Thread(target=httpd.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{PORT}"
PAGE = f"{BASE}/fixtures/page.html"

rt = os.path.join(tmp, "run"); os.makedirs(rt, mode=0o700)
TMPD = os.path.join(tmp, "t"); os.makedirs(TMPD)
sockdir = os.path.join(rt, "termium")
def env_for(state, **extra):
    e = {"XDG_RUNTIME_DIR": rt, "XDG_DATA_HOME": os.path.join(tmp, "data"), "XDG_STATE_HOME": os.path.join(tmp, state),
         "TMPDIR": TMPD, "TERMIUM_TEST_DEVTOOLS_PORT": "1", "CI": "", "TERMIUM_NO_UPDATE_CHECK": "",
         "TERMIUM_UPDATE_URL": f"{BASE}/latest", "TERMIUM_UPDATE_DOWNLOAD_URL": f"{BASE}/dl"}
    e.update(extra)
    return e

def cli(binary, *args, state="cli", **extra):
    return subprocess.run([binary, *args], env=dict(os.environ, **env_for(state, **extra)), capture_output=True, text=True, timeout=120)

def cache(state):
    p = os.path.join(tmp, state, "termium", "update-check.json")
    return json.load(open(p)) if os.path.exists(p) else None

def server_pid(session):
    try:
        pid = int(open(os.path.join(sockdir, f"{session}.pid")).read()); os.kill(pid, 0); return pid
    except (OSError, ValueError):
        return None

def stop(session):
    pid = server_pid(session)
    if pid:
        os.kill(pid, signal.SIGTERM)
        for _ in range(100):
            try:
                os.kill(pid, 0)
            except OSError:
                return
            time.sleep(0.1)
        os.kill(pid, signal.SIGKILL)

def exit_code(t, timeout=10):
    end = time.time() + timeout
    while time.time() < end:
        try:
            pid, st = os.waitpid(t.pid, os.WNOHANG)
        except ChildProcessError:
            return getattr(t, "_code", None)
        if pid:
            t._code = os.waitstatus_to_exitcode(st); time.sleep(0.2); return t._code
        time.sleep(0.1)
    return None

def output(t):
    return bytes(t.raw).decode(errors="replace")

def page_eval(expr, profile, match="page.html"):
    r = subprocess.run(["bun", os.path.join(ROOT, "tests/support/cdp-eval.ts"), profile, expr], capture_output=True, text=True, timeout=20)
    for p in json.loads(r.stdout or "[]"):
        if match in p["url"] and p["value"] is not None:
            return p["value"]
    return None

BOX = "is available (you have"
def box_shown(t):
    return BOX in t.text()
def wait_box(t, timeout=40, text=BOX):
    """Waits for the box, then past the moment where keys still go to the page."""
    ok = t.wait_for(lambda: text in t.text(), timeout)
    time.sleep(1.3)
    return ok
def badge(t, v=NEXT):
    return f"↑ v{v}" in t.line(1)

terms = []
def term(binary, *args, state, **kw):
    extra = kw.pop("env", {})
    t = Term([binary, *args], cwd=tmp, env=env_for(state, **extra), **kw)
    terms.append(t)
    return t

try:
    # ------------------------------------------------ termium check-update
    r = cli(cur_bin, "check-update")
    check("check-update: a newer release is available (exit 100)", r.returncode == 100 and
          f"termium {NEXT} is available (you have {CUR})" in r.stdout and "install.sh | sh" in r.stdout and r.stdout.count("\n") == 1,
          (r.returncode, r.stdout, r.stderr))
    check("check-update: sends only a termium/<version> User-Agent", HITS and HITS[-1][2] == f"termium/{CUR}", HITS[-1:])
    cp = os.path.join(tmp, "cli", "termium", "update-check.json")
    check("check-update: the cache is written, 0600, with checked_at/latest/skipped",
          cache("cli") and cache("cli")["latest"] == f"v{NEXT}" and set(cache("cli")) == {"checked_at", "latest", "skipped"}
          and stat.S_IMODE(os.stat(cp).st_mode) == 0o600, cache("cli"))
    LATEST["tag"] = f"v{CUR}"
    r = cli(cur_bin, "check-update")
    check("check-update: up to date (exit 0)", r.returncode == 0 and r.stdout.strip() == f"termium {CUR} is up to date", (r.returncode, r.stdout))
    LATEST["tag"] = f"v{maj}.{mnr + 1}.0-rc.1"
    r = cli(cur_bin, "check-update")
    check("check-update: a pre-release is not offered, nor cached", r.returncode == 0 and "up to date" in r.stdout and cache("cli")["latest"] == f"v{CUR}",
          (r.returncode, r.stdout, cache("cli")))
    r = cli(cur_bin, "check-update", TERMIUM_UPDATE_URL="http://127.0.0.1:1/latest")
    check("check-update: an error (exit 1) keeps the cached tag", r.returncode == 1 and r.stderr.strip().startswith("could not check for updates: ")
          and cache("cli")["latest"] == f"v{CUR}", (r.returncode, r.stdout, r.stderr, cache("cli")))
    LATEST["tag"] = f"v{NEXT}"
    r = cli(cur_bin, "check-update", TERMIUM_NO_UPDATE_CHECK="1", CI="true")
    check("check-update ignores the opt-outs", r.returncode == 100, (r.returncode, r.stdout))
    n = len(HITS)
    cli(cur_bin, "ls"); cli(cur_bin, "kill", "nosuch"); cli(cur_bin, "--version"); cli(cur_bin, "--help")
    check("ls, kill, --version and --help never check", len(HITS) == n, HITS[n:])

    # ------------------------------------------------ startup: never slowed by the check
    def startup(session, state, **extra):
        t0 = time.time()
        t = term(cur_bin, "-s", session, "--incognito", PAGE, state=state, env=extra)
        ok = t.wait_text("termium test page", 40)
        took = time.time() - t0
        return t, ok, took
    base_t, ok0, base = startup("t0", "st-off", TERMIUM_NO_UPDATE_CHECK="1")
    stop("t0"); base_t.close()
    slow_t, ok1, slow = startup("t1", "st-slow", TERMIUM_UPDATE_URL=f"{BASE}/slow")
    check(f"startup with a check that hangs isn't slower (opt-out {base:.2f}s, hanging check {slow:.2f}s)",
          ok0 and ok1 and slow < base + 1.0, (ok0, ok1, base, slow))
    time.sleep(5)
    check("a check that times out is silent: no badge, no box", not badge(slow_t) and not box_shown(slow_t) and "update" not in slow_t.text().lower(),
          slow_t.line(1))
    stop("t1"); slow_t.close()
    off_t, ok2, off = startup("t2", "st-offline", TERMIUM_UPDATE_URL="http://127.0.0.1:1/latest")
    time.sleep(4)
    check(f"offline: silent and not slower ({off:.2f}s)", ok2 and off < base + 1.0 and not badge(off_t) and not box_shown(off_t), (ok2, off))
    stop("t2"); off_t.close()
    n = len(HITS)
    ci_t, _, _ = startup("t3", "st-ci", CI="1")
    time.sleep(5)
    check("CI set: no check, no badge", len(HITS) == n and not badge(ci_t), HITS[n:])
    stop("t3"); ci_t.close()
    n = len(HITS)
    fl_t = term(cur_bin, "-s", "t4", "--incognito", "--no-update-check", PAGE, state="st-flag")
    fl_t.wait_text("termium test page", 40); time.sleep(5)
    check("--no-update-check: no check, no badge", len(HITS) == n and not badge(fl_t), HITS[n:])
    stop("t4"); fl_t.close()

    # ------------------------------------------------ the badge and the box; later; attach/detach/takeover
    prof = os.path.join(tmp, "prof-offer")
    n = len(HITS)
    a = term(cur_bin, "-s", "offer", "--profile", prof, PAGE, state="st-offer")
    check("the badge shows the newer release in the tab bar", a.wait_for(lambda: badge(a), 40), a.line(1))
    a.key("ctrl+l")  # the address bar is open: the box must wait
    time.sleep(6)
    def editing(t):
        """The address is being edited (its text selected: shown in reverse video)."""
        row = t.line(2); i = row.find("http://")
        with t.lock:
            return i >= 0 and t.screen.buffer[1][i].reverse
    check("no box while the address bar is open", not box_shown(a) and editing(a), (box_shown(a), a.line(2)))
    a.key("escape")
    check("the box appears once nothing is open and input is idle", wait_box(a, 10), a.text()[-400:])
    check("the box offers u / l / s", "u update · l later · s skip" in a.text() and "skip this version" in a.text())
    shot(a, "update-offer.png")
    a.key("x"); time.sleep(0.8)
    check("other keys don't close the box (nor reach the page)", box_shown(a) and (page_eval("termiumState().inp", prof) or "") == "")
    a.key("l")
    check("l: later closes the box", a.wait_for(lambda: not box_shown(a), 5))
    check("...the badge stays", badge(a))
    time.sleep(5)
    check("...and the box doesn't come back in this session", not box_shown(a))
    check("one check for the attach", len(HITS) - n == 1, HITS[n:])
    a.key("ctrl+b"); a.key("question")
    check("help shows the update and the upgrade command", a.wait_text("update available", 5) and "install.sh" in a.text() and f"→ {NEXT}" in a.text(), a.text()[:600])
    shot(a, "update-help.png")
    a.key("escape"); time.sleep(0.5)
    a.key("ctrl+b"); a.key("d")
    check("detach", exit_code(a) == 0)
    n = len(HITS)
    time.sleep(5)
    check("no checks while detached", len(HITS) == n, HITS[n:])
    b = term(cur_bin, "attach", "offer", state="st-offer")
    check("re-attach: the badge is back at once", b.wait_for(lambda: badge(b), 15), b.line(1))
    time.sleep(5)
    check("re-attach: no new check, no repeated box", len(HITS) == n and not box_shown(b), HITS[n:])
    c = term(cur_bin, "attach", "offer", state="st-offer", cols=120, rows=36)
    check("takeover: the badge shows", c.wait_for(lambda: badge(c), 15))
    time.sleep(5)
    check("takeover: no new check, no repeated box", len(HITS) == n and not box_shown(c), HITS[n:])
    c.key("ctrl+b"); c.key("shift+u")
    check("Ctrl+B U opens the box on demand", wait_box(c, 5))
    c.key("escape"); time.sleep(0.5)
    w = term(cur_bin, "attach", "offer", state="st-offer", cols=60, rows=24)
    check("a narrow terminal still shows a (short) badge", w.wait_for(lambda: "↑" in w.line(1), 15), w.line(1))
    shot(w, "update-badge-narrow.png")
    stop("offer")

    # ------------------------------------------------ a menu open: no box; keys typed as it appears go to the page
    prof2 = os.path.join(tmp, "prof-arm")
    m = term(cur_bin, "-s", "arm", "--profile", prof2, PAGE, state="st-arm")
    m.wait_text("termium test page", 40); m.wait_idle(0.8, 10)
    sel = page_eval("(() => { const r = document.getElementById('sel').getBoundingClientRect(); return [r.x + 10, r.y + r.height/2]; })()", prof2)
    m.click(220 + int(sel[0]), 40 + int(sel[1]))
    menu_open = lambda: page_eval("!!document.querySelector('termium-select')", prof2) is True
    check("a <select> menu is open", m.wait_for(menu_open, 5))
    time.sleep(6)
    check("no box while a page's menu is open", not box_shown(m) and m.wait_for(lambda: badge(m), 1))
    m.key("escape")
    check("menu closed", m.wait_for(lambda: not menu_open(), 5))
    inp = page_eval("(() => { const r = document.getElementById('inp').getBoundingClientRect(); return [r.x + 10, r.y + r.height/2]; })()", prof2)
    m.click(220 + int(inp[0]), 40 + int(inp[1]))
    check("the box appears", m.wait_for(lambda: box_shown(m), 12, 0.02))
    m.type("ab", delay=0.05)
    check("keys typed just as the box appeared close it ...", m.wait_for(lambda: not box_shown(m), 3))
    check("... and reach the page", m.wait_for(lambda: page_eval("termiumState().inp", prof2) == "ab", 5), page_eval("termiumState().inp", prof2))
    stop("arm")

    # ------------------------------------------------ skip
    s = term(cur_bin, "-s", "skip", "--incognito", PAGE, state="st-skip")
    check("skip: the box appears", wait_box(s))
    s.key("s")
    check("s: closes the box and says so", s.wait_for(lambda: not box_shown(s) and "skipped" in s.text(), 5))
    sp = os.path.join(tmp, "st-skip", "termium", "update-check.json")
    check("s: the skipped release is saved (0600)", (cache("st-skip") or {}).get("skipped") == f"v{NEXT}" and stat.S_IMODE(os.stat(sp).st_mode) == 0o600, cache("st-skip"))
    stop("skip"); s.close()
    s = term(cur_bin, "-s", "skip", "--incognito", PAGE, state="st-skip")
    check("skipped: the badge still shows after a restart", s.wait_for(lambda: badge(s), 40))
    time.sleep(6)
    check("skipped: ... but the box isn't offered again", not box_shown(s))
    stop("skip"); s.close()

    # ------------------------------------------------ a checksum mismatch is refused
    inst = os.path.join(tmp, "inst-bad"); os.makedirs(inst)
    shutil.copy(cur_bin, os.path.join(inst, "termium"))
    before = sha(os.path.join(inst, "termium"))
    LATEST["tag"] = f"v{BAD}"
    x = term(os.path.join(inst, "termium"), "-s", "bad", "--incognito", PAGE, state="st-bad")
    check("mismatch: the box offers the bad release", wait_box(x) and BAD in x.text())
    x.key("u")
    check("mismatch: the update fails and says why", x.wait_for(lambda: "update failed" in x.text(), 30) and "does not match its SHA-256" in x.text(), x.text()[-600:])
    check("mismatch: ... and shows how to update by hand", "update by hand" in x.text() and "install.sh" in x.text())
    shot(x, "update-failed.png")
    check("mismatch: the binary is untouched, nothing left beside it", sha(os.path.join(inst, "termium")) == before and os.listdir(inst) == ["termium"], os.listdir(inst))
    x.key("escape")
    check("mismatch: Esc closes", x.wait_for(lambda: "update failed" not in x.text(), 5))
    stop("bad"); x.close()
    LATEST["tag"] = f"v{NEXT}"

    # ------------------------------------------------ u: update, then r: restart into it (layout kept)
    inst = os.path.join(tmp, "inst"); os.makedirs(inst)
    shutil.copy(cur_bin, os.path.join(inst, "termium"))
    link = os.path.join(tmp, "linkdir"); os.makedirs(link)
    os.symlink(os.path.join(inst, "termium"), os.path.join(link, "termium"))
    prof3 = os.path.join(tmp, "prof-upd")
    u = term(os.path.join(link, "termium"), "-s", "upd", "--profile", prof3, PAGE, state="st-upd")
    u.wait_text("termium test page", 40); u.wait_idle(0.8, 10)
    u.key("ctrl+b"); u.key("v"); time.sleep(1.5)
    u.type(f"{BASE}/fixtures/reader.html"); u.key("enter"); time.sleep(1.5)
    u.key("ctrl+t"); time.sleep(1.5)
    u.type(f"{BASE}/fixtures/frame.html"); u.key("enter"); time.sleep(1.5)
    u.key("ctrl+b"); u.key("shift+n"); time.sleep(1.5)
    u.type(f"{BASE}/fixtures/anim.html"); u.key("enter")
    check("u: the box appears", wait_box(u), u.text()[-300:])
    old_server = server_pid("upd")
    u.key("u")
    check("u: the update downloads, verifies and installs", u.wait_for(lambda: f"updated to termium {NEXT}" in u.text(), 60), u.text()[-600:])
    check("u: the box says this session runs the old one until it restarts",
          u.wait_for(lambda: f"keeps running termium {CUR} until it restarts" in u.text() and "r restart" in u.text(), 5), u.text())
    shot(u, "update-done.png")
    r = subprocess.run([os.path.join(inst, "termium"), "--version"], capture_output=True, text=True)
    check("u: the binary (the symlink's target) is the new release", r.stdout.strip() == f"termium {NEXT}", r.stdout)
    check("u: the symlink is still a symlink, and no temp files are left", os.path.islink(os.path.join(link, "termium")) and os.listdir(inst) == ["termium"], os.listdir(inst))
    check("u: the binary is executable", os.access(os.path.join(inst, "termium"), os.X_OK))
    check("u: the session still runs (the old version)", server_pid("upd") == old_server)
    check("u: the badge says a restart is due", f"↻ v{NEXT}" in u.line(1), u.line(1))
    time.sleep(1.3)
    u.key("r")
    check("r: the client says it's restarting", u.wait_for(lambda: "restarting session upd" in output(u), 15), output(u)[-300:])
    check("r: a new session server runs", u.wait_for(lambda: server_pid("upd") not in (None, old_server), 30))
    check("r: the same terminal is attached again, with a notice", u.wait_for(lambda: f"Restarted: termium {CUR} → {NEXT}" in u.text(), 40), u.text()[-400:])
    lsout = subprocess.run([cur_bin, "ls"], env=dict(os.environ, **env_for("st-upd")), capture_output=True, text=True).stdout
    check("r: ls (from an old binary) shows the session runs the new termium", f"(termium {NEXT})" in lsout, lsout)
    check("r: the spaces are back", u.wait_for(lambda: "space 2" in u.text(), 20) and "space 1" in u.text())
    u.key("ctrl+b"); u.key("w"); u.key("1"); time.sleep(2)
    check("r: space 1 has its two tabs, the first split in two", u.wait_for(lambda: "⊞2" in u.line(1) and " 2 " in u.line(1), 15), u.line(1))
    shot(u, "update-restarted.png")
    urls = lambda: [p["url"] for p in json.loads(subprocess.run(["bun", os.path.join(ROOT, "tests/support/cdp-eval.ts"), prof3, "1"], capture_output=True, text=True, timeout=20).stdout or "[]")]
    check("r: every page reopened at its address", u.wait_for(lambda: sorted(x.split("/")[-1] for x in urls() if "fixtures" in x) == ["anim.html", "frame.html", "page.html", "reader.html"], 20), urls())
    check("r: no box and no badge (it's up to date now)", not box_shown(u) and "↑" not in u.line(1) and "↻" not in u.line(1), u.line(1))
    check("r: the restore file is gone", not os.path.exists(os.path.join(sockdir, "upd.restore")))
    stop("upd")

    # ------------------------------------------------ termium update from the shell; a newer client attaching
    inst2 = os.path.join(tmp, "inst2"); os.makedirs(inst2)
    shutil.copy(cur_bin, os.path.join(inst2, "termium"))
    o = term(os.path.join(inst2, "termium"), "-s", "shell", "--incognito", PAGE, state="st-shell", env={"TERMIUM_NO_UPDATE_CHECK": "1"})
    o.wait_text("termium test page", 40)
    o.key("ctrl+b"); o.key("d"); exit_code(o)
    r = cli(os.path.join(inst2, "termium"), "update", state="st-shell")
    check("termium update: updates a release binary (exit 0)", r.returncode == 0 and f"Updated to termium {NEXT}" in r.stdout and "downloading" in r.stdout, (r.returncode, r.stdout, r.stderr))
    check("termium update: says running sessions keep the old version until restarted", "shell" in r.stdout and "keep" in r.stdout and "press r" in r.stdout, r.stdout)
    r2 = subprocess.run([os.path.join(inst2, "termium"), "--version"], capture_output=True, text=True)
    check("termium update: the new binary reports the new version", r2.stdout.strip() == f"termium {NEXT}", r2.stdout)
    r = cli(os.path.join(inst2, "termium"), "update", state="st-shell")
    check("termium update again: up to date (exit 0)", r.returncode == 0 and f"termium {NEXT} is up to date" in r.stdout, (r.returncode, r.stdout))
    q = term(os.path.join(inst2, "termium"), "attach", "shell", state="st-shell", env={"TERMIUM_NO_UPDATE_CHECK": "1"})
    check("a newer client attaching to the old session: offered a restart", wait_box(q, 30, f"termium {NEXT} is installed") and "r restart" in q.text(), q.text()[-500:])
    q.key("escape")
    check("...Esc: later, with the ↻ badge", q.wait_for(lambda: f"↻ v{NEXT}" in q.line(1), 5), q.line(1))
    stop("shell")

    # ------------------------------------------------ refusals
    r = subprocess.run(["bun", os.path.join(ROOT, "src", "main.ts"), "update"], env=dict(os.environ, **env_for("cli")), capture_output=True, text=True, timeout=60)
    check("from source: termium update refuses cleanly", r.returncode == 1 and "runs from source" in r.stderr and "install.sh" in r.stderr, (r.returncode, r.stderr))
    ro = os.path.join(tmp, "ro"); os.makedirs(ro)
    shutil.copy(cur_bin, os.path.join(ro, "termium")); os.chmod(ro, 0o555)
    r = cli(os.path.join(ro, "termium"), "update")
    check("unwritable folder: termium update refuses cleanly", r.returncode == 1 and "can't write to" in r.stderr and sha(os.path.join(ro, "termium")) == sha(cur_bin), (r.returncode, r.stderr))
    os.chmod(ro, 0o755)
    r = cli(cur_bin, "update", TERMIUM_UPDATE_URL="http://127.0.0.1:1/latest")
    check("termium update offline: fails with exit 1", r.returncode == 1 and "could not check for updates" in r.stderr, (r.returncode, r.stderr))

    # ------------------------------------------------ a client of another protocol
    p = term(cur_bin, "-s", "proto", "--incognito", PAGE, state="st-proto", env={"TERMIUM_NO_UPDATE_CHECK": "1"})
    p.wait_text("termium test page", 40)
    p.key("ctrl+b"); p.key("d"); exit_code(p)
    pp = term(proto_bin, "attach", "proto", state="st-proto")
    code = exit_code(pp, 15)
    out = output(pp)
    check("another protocol: refused with a clear message (exit 1)", code == 1 and "can't talk to this termium" in out and f"runs termium {CUR}" in out and "termium kill proto" in out,
          (code, out[-400:]))
    check("...and the session is left running", server_pid("proto") is not None)
    stop("proto")
finally:
    for t in terms:
        if t.alive:
            try:
                os.kill(t.pid, signal.SIGKILL); os.waitpid(t.pid, 0)
            except Exception:
                pass
            t.alive = False
    for name in ("t0", "t1", "t2", "t3", "t4", "offer", "arm", "skip", "bad", "upd", "shell", "proto"):
        stop(name)
    httpd.shutdown()
    time.sleep(1)
    shutil.rmtree(tmp, ignore_errors=True)

print("FAILED: " + ", ".join(failures) if failures else "ALL PASSED")
sys.exit(1 if failures else 0)
