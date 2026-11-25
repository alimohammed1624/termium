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
NEXT, BAD, LATER, SCRIPT = (f"{maj}.{mnr}.{pat + n}" for n in (1, 2, 3, 4))
TARGET = {"x86_64": "x86_64", "aarch64": "aarch64", "arm64": "aarch64"}[os.uname().machine] + "-unknown-linux-gnu"
ASSET = f"termium-{TARGET}.tar.gz"

def build(version, out, protocol=None, tag=None):
    """A release binary of this checkout (or of git tag `tag`) claiming `version` (and speaking `protocol`)."""
    src = os.path.join(tmp, f"src-{version}-{protocol}")
    os.makedirs(src)
    if tag:
        subprocess.run(f"git -C {ROOT} archive {tag} src | tar -x -C {src}", shell=True, check=True)
    else:
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
later_bin = build(LATER, os.path.join(tmp, "build", "later", "termium"))
proto_bin = build("9.9.9", os.path.join(tmp, "build", "proto", "termium"), protocol=999)
# The real v0.2.0 (sessions, no update support), as released.
HAVE_020 = subprocess.run(["git", "-C", ROOT, "rev-parse", "-q", "--verify", "v0.2.0^{commit}"], capture_output=True).returncode == 0
old_bin = build("0.2.0", os.path.join(tmp, "build", "v0.2.0", "termium"), tag="v0.2.0") if HAVE_020 else None
package(next_bin, f"v{NEXT}")
package(next_bin, f"v{BAD}", good=False)
package(later_bin, f"v{LATER}")
# A release whose "binary" is a shell script that answers --version (with a matching checksum).
RAN = os.path.join(tmp, "script-ran")
script = os.path.join(tmp, "build", "script", "termium"); os.makedirs(os.path.dirname(script))
open(script, "w").write(f'#!/bin/sh\ntouch {RAN}\necho "termium {SCRIPT}"\n'); os.chmod(script, 0o755)
package(script, f"v{SCRIPT}")
sha = lambda p: hashlib.sha256(open(p, "rb").read()).hexdigest()

# ---- the fake GitHub
LATEST = {"tag": f"v{NEXT}"}
HITS = []
DL = []  # downloads asked for
class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass
    def do_GET(self):
        if self.path.startswith("/latest") or self.path.startswith("/slow"):
            HITS.append((time.time(), self.path, self.headers.get("User-Agent")))
            if self.path.startswith("/slow"):
                time.sleep(10)
            tag = self.path.split("/")[2] if self.path.startswith("/latest/") else LATEST["tag"]
            self.send_response(302)
            self.send_header("Location", f"https://github.com/alimohammed1624/termium/releases/tag/{tag}")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if self.path.startswith("/dl/"):
            DL.append(self.path)
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
         "TMPDIR": TMPD, "CI": "", "TERMIUM_NO_UPDATE_CHECK": "",
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

def notice(t):
    """The update notice in the address line."""
    return "Ctrl+B U" in t.line(2) or "^B U" in t.line(2)
def box_open(t):
    """The update box (opened on purpose) is on screen."""
    return " UPDATE " in t.line(2)
def open_box(t, timeout=5):
    t.key("ctrl+b"); t.key("shift+u")
    return t.wait_for(lambda: box_open(t), timeout)
def update_ui(t):
    """Any update news on screen at all."""
    return box_open(t) or notice(t) or "↑" in t.line(1) or "↻" in t.line(1)
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
    t0 = time.time()
    r = cli(cur_bin, "check-update", TERMIUM_UPDATE_URL=f"{BASE}/slow {BASE}/slow")
    took = time.time() - t0
    check(f"check-update: both sources hanging, one 3 s deadline ({took:.2f}s)", r.returncode == 1 and "no answer within 3 s" in r.stderr and took < 3.8, (took, r.stderr))
    LATEST["tag"] = f"v{NEXT}"
    before_cache = cache("cli")
    LATEST["tag"] = "v9.9.9+%2F..%2F.."
    r = cli(cur_bin, "check-update")
    check("check-update: a tag that isn't a plain version (+build, an encoded path) is refused, nothing cached",
          r.returncode == 1 and "no release found" in r.stderr and cache("cli")["latest"] == before_cache["latest"], (r.returncode, r.stdout, r.stderr, cache("cli")))
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
    slow_t, ok1, slow = startup("t1", "st-slow", TERMIUM_UPDATE_URL=f"{BASE}/slow {BASE}/slow")
    check(f"startup with a check that hangs isn't slower (opt-out {base:.2f}s, hanging check {slow:.2f}s)",
          ok0 and ok1 and slow < base + 1.0, (ok0, ok1, base, slow))
    time.sleep(5)
    check("a check that times out is silent: no badge, no notice", not update_ui(slow_t), slow_t.line(1))
    log = open(os.path.join(tmp, "st-slow", "termium", "termium.log")).read()
    check("...and gives up within one 3 s deadline across both sources", "update check: no answer within 3 s" in log, log[-500:])
    stop("t1"); slow_t.close()
    off_t, ok2, off = startup("t2", "st-offline", TERMIUM_UPDATE_URL="http://127.0.0.1:1/latest")
    time.sleep(4)
    check(f"offline: silent and not slower ({off:.2f}s)", ok2 and off < base + 1.0 and not update_ui(off_t), (ok2, off))
    stop("t2"); off_t.close()
    n = len(HITS)
    ci_t, _, _ = startup("t3", "st-ci", CI="1")
    time.sleep(5)
    check("CI set: no check, no badge", len(HITS) == n and not update_ui(ci_t), HITS[n:])
    stop("t3"); ci_t.close()
    n = len(HITS)
    fl_t = term(cur_bin, "-s", "t4", "--incognito", "--no-update-check", PAGE, state="st-flag")
    fl_t.wait_text("termium test page", 40); time.sleep(5)
    check("--no-update-check: no check, no badge", len(HITS) == n and not update_ui(fl_t), HITS[n:])
    stop("t4"); fl_t.close()

    # ------------------------------------------------ the answer shows at once, even while another termium holds the cache
    cl_cache = os.path.join(tmp, "st-clock", "termium", "update-check.json")
    os.makedirs(os.path.dirname(cl_cache), exist_ok=True)
    holder = subprocess.Popen(["bun", "-e", f"const b = await import({json.dumps(os.path.join(ROOT, 'src', 'browser.ts'))}); "
                               f"console.log(b.lockFile({json.dumps(cl_cache + '.lock')})); await Bun.sleep(8000); b.unlockFile({json.dumps(cl_cache + '.lock')});"],
                              stdout=subprocess.PIPE, text=True)
    holder.stdout.readline()
    cl = term(cur_bin, "-s", "clock", "--incognito", PAGE, state="st-clock")
    cl.wait_text("termium test page", 40)
    t0 = time.time()
    shown = cl.wait_for(lambda: badge(cl), 6)
    check(f"with the cache locked, the newer release still shows at once ({time.time() - t0:.1f}s after the page)", shown and time.time() - t0 < 3, cl.line(1))
    holder.wait(); stop("clock")

    # ------------------------------------------------ detaching stops a check under way: nothing is written after
    ab = term(cur_bin, "-s", "abort", "--incognito", PAGE, state="st-abort", env={"TERMIUM_UPDATE_URL": f"{BASE}/slow"})
    ab.wait_text("termium test page", 40); time.sleep(1)
    ab.key("ctrl+b"); ab.key("d"); exit_code(ab)
    time.sleep(12)
    log = open(os.path.join(tmp, "st-abort", "termium", "termium.log")).read()
    check("detach stops the check under way, and no cache is written after", cache("st-abort") is None and "update check: stopped" in log, (cache("st-abort"), log[-300:]))
    stop("abort")

    # ------------------------------------------------ the badge and the notice; typing and pasting always reach the page
    prof = os.path.join(tmp, "prof-offer")
    n = len(HITS)
    a = term(cur_bin, "-s", "offer", "--profile", prof, PAGE, state="st-offer")
    check("the badge shows the newer release in the tab bar", a.wait_for(lambda: badge(a), 40), a.line(1))
    check("the notice shows in the address line", a.wait_for(lambda: notice(a) and f"termium {NEXT} is available (you have {CUR})" in a.line(2), 5), a.line(2))
    shot(a, "update-notice.png")
    a.key("ctrl+l")
    def editing(t):
        """The address is being edited (its text selected: shown in reverse video)."""
        row = t.line(2); i = row.find("http://")
        with t.lock:
            return i >= 0 and t.screen.buffer[1][i].reverse
    check("no notice while the address bar is open", a.wait_for(lambda: editing(a) and not notice(a), 3), a.line(2))
    a.key("escape")
    check("the notice comes back once the address bar closes", a.wait_for(lambda: notice(a), 5))
    a.wait_idle(0.8, 10)
    inp = page_eval("(() => { const r = document.getElementById('inp').getBoundingClientRect(); return [r.x + 10, r.y + r.height/2]; })()", prof)
    a.click(220 + int(inp[0]), 40 + int(inp[1])); time.sleep(0.5)
    a.type("sul usual")
    a.paste(" pasted")
    check("plain keys and pastes go to the page while the notice shows",
          a.wait_for(lambda: page_eval("termiumState().inp", prof) == "sul usual pasted", 5), page_eval("termiumState().inp", prof))
    check("...and none of them answered it", notice(a) and not box_open(a) and (cache("st-offer") or {}).get("skipped") is None, cache("st-offer"))
    check("Ctrl+B U opens the box", open_box(a) and "u update · l later · s skip" in a.text(), a.text()[-400:])
    a.key("enter")
    time.sleep(1)
    check("Enter in the box doesn't update: it closes the box (and goes to the page)", not box_open(a) and notice(a) and not DL, (a.line(2), DL))
    open_box(a); a.key("space"); time.sleep(1)
    check("...nor does Space", not box_open(a) and notice(a) and not DL and page_eval("termiumState().inp", prof) == "sul usual pasted ", page_eval("termiumState().inp", prof))
    a.key("backspace"); time.sleep(0.3)
    open_box(a); a.key("escape")
    check("Escape just closes the box (the offer stays)", a.wait_for(lambda: not box_open(a), 5) and notice(a) and page_eval("termiumState().inp", prof) == "sul usual pasted")
    open_box(a)
    shot(a, "update-offer.png")
    a.key("x")
    check("a key the box doesn't use closes it and goes to the page", a.wait_for(lambda: not box_open(a), 5) and
          a.wait_for(lambda: page_eval("termiumState().inp", prof) == "sul usual pastedx", 5), page_eval("termiumState().inp", prof))
    check("...the notice stays", notice(a))
    open_box(a)
    a.paste("!")
    check("a paste with the box open closes it and reaches the page", a.wait_for(lambda: not box_open(a), 5) and
          a.wait_for(lambda: page_eval("termiumState().inp", prof) == "sul usual pastedx!", 5), page_eval("termiumState().inp", prof))
    # a click on the notice opens the box
    col = a.line(2).find("↑ termium")
    a.click_cell(col + 3, 2)
    check("a click on the notice opens the box", a.wait_for(lambda: box_open(a), 5), a.line(2))
    a.key("l")
    check("l: later closes the box and the notice", a.wait_for(lambda: not box_open(a) and not notice(a), 5), a.line(2))
    check("...the badge stays", badge(a))
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
    time.sleep(3)
    check("re-attach: no new check, no repeated notice", len(HITS) == n and not notice(b), HITS[n:])
    check("Ctrl+B U offers it again on demand", open_box(b))
    # Taken over while the box is open: the new terminal types into the page.
    y = term(cur_bin, "attach", "offer", state="st-offer")
    check("a takeover with the box open starts without it", y.wait_text("termium test page", 15) and y.wait_for(lambda: not box_open(y), 5))
    y.type("s")
    check("...its first keys reach the page, and answer nothing",
          y.wait_for(lambda: page_eval("termiumState().inp", prof) == "sul usual pastedx!s", 5) and (cache("st-offer") or {}).get("skipped") is None,
          (page_eval("termiumState().inp", prof), cache("st-offer")))
    open_box(y)
    # A takeover by a terminal that opted out: no update UI at all, even with the box open.
    c = term(cur_bin, "attach", "offer", "--no-update-check", state="st-offer", cols=120, rows=36)
    check("an opted-out takeover shows the page", c.wait_text("termium test page", 15))
    time.sleep(2)
    check("an opted-out takeover shows no box, notice or badge", not update_ui(c), (c.line(1), c.line(2)))
    c.key("ctrl+b"); c.key("shift+u")
    check("...and Ctrl+B U says update news is off", c.wait_for(lambda: "Update news is off" in c.line(2), 5) and not box_open(c), c.line(2))
    check("...and it didn't check either", len(HITS) == n, HITS[n:])
    w = term(cur_bin, "attach", "offer", state="st-offer", cols=60, rows=24)
    check("taken back by a terminal that wants it: a narrow terminal still shows a (short) badge", w.wait_for(lambda: "↑" in w.line(1), 15), w.line(1))
    shot(w, "update-badge-narrow.png")
    stop("offer")

    # ------------------------------------------------ skip
    s = term(cur_bin, "-s", "skip", "--incognito", PAGE, state="st-skip")
    check("skip: the notice appears", s.wait_for(lambda: notice(s), 40))
    open_box(s); s.key("s")
    check("s: closes the box and the notice and says so", s.wait_for(lambda: not box_open(s) and "skipped" in s.text(), 5))
    sp = os.path.join(tmp, "st-skip", "termium", "update-check.json")
    check("s: the skipped release is saved (0600)", (cache("st-skip") or {}).get("skipped") == f"v{NEXT}" and stat.S_IMODE(os.stat(sp).st_mode) == 0o600, cache("st-skip"))
    stop("skip"); s.close()
    s = term(cur_bin, "-s", "skip", "--incognito", PAGE, state="st-skip")
    check("skipped: the badge still shows after a restart", s.wait_for(lambda: badge(s), 40))
    time.sleep(3)
    check("skipped: ... but it isn't offered again", not notice(s))
    stop("skip"); s.close()

    # ------------------------------------------------ a checksum mismatch is refused
    inst = os.path.join(tmp, "inst-bad"); os.makedirs(inst)
    shutil.copy(cur_bin, os.path.join(inst, "termium"))
    before = sha(os.path.join(inst, "termium"))
    LATEST["tag"] = f"v{BAD}"
    x = term(os.path.join(inst, "termium"), "-s", "bad", "--incognito", PAGE, state="st-bad")
    check("mismatch: the bad release is offered", x.wait_for(lambda: notice(x) and BAD in x.line(2), 40))
    open_box(x); x.key("u")
    check("mismatch: the update fails and says why", x.wait_for(lambda: "update failed" in x.text(), 30) and "does not match its SHA-256" in x.text(), x.text()[-600:])
    check("mismatch: ... and shows how to update by hand", "update by hand" in x.text() and "install.sh" in x.text())
    shot(x, "update-failed.png")
    check("mismatch: the binary is untouched, nothing left beside it", sha(os.path.join(inst, "termium")) == before and os.listdir(inst) == ["termium"], os.listdir(inst))
    x.key("escape")
    check("mismatch: Esc closes", x.wait_for(lambda: "update failed" not in x.text() and not box_open(x), 5))
    stop("bad"); x.close()

    # ------------------------------------------------ a release that isn't a native binary is refused, never run
    LATEST["tag"] = f"v{SCRIPT}"
    inst = os.path.join(tmp, "inst-script"); os.makedirs(inst)
    shutil.copy(cur_bin, os.path.join(inst, "termium"))
    before = sha(os.path.join(inst, "termium"))
    r = cli(os.path.join(inst, "termium"), "update")
    check("a script posing as termium (matching checksum) is refused with the update-by-hand command",
          r.returncode == 1 and "doesn't hold a termium binary for this machine" in r.stderr and "install.sh" in r.stderr, (r.returncode, r.stderr))
    check("...it never ran, and the binary is untouched", not os.path.exists(RAN) and sha(os.path.join(inst, "termium")) == before and os.listdir(inst) == ["termium"])
    LATEST["tag"] = f"v{NEXT}"

    # ------------------------------------------------ "later" holds for the session when a newer release replaced the offer
    os.makedirs(os.path.join(tmp, "st-later", "termium"), exist_ok=True)
    json.dump({"checked_at": 1, "latest": f"v{NEXT}", "skipped": None}, open(os.path.join(tmp, "st-later", "termium", "update-check.json"), "w"))
    LATEST["tag"] = f"v{LATER}"
    lt = term(cur_bin, "-s", "later", "--incognito", PAGE, state="st-later")
    check("later: the cached release is replaced by the newer one found", lt.wait_for(lambda: notice(lt) and LATER in lt.line(2), 40), lt.line(2))
    open_box(lt); lt.key("l")
    check("later: l closes it", lt.wait_for(lambda: not notice(lt) and not box_open(lt), 5))
    lt.key("ctrl+b"); lt.key("d"); exit_code(lt)
    lt2 = term(cur_bin, "attach", "later", state="st-later")
    lt2.wait_text("termium test page", 15); time.sleep(3)
    check("later: not offered again on re-attach", not notice(lt2) and f"↑ v{LATER}" in lt2.line(1), (lt2.line(1), lt2.line(2)))
    stop("later")

    # ------------------------------------------------ a skipped release never shows, even replacing a cached offer
    os.makedirs(os.path.join(tmp, "st-skip2", "termium"), exist_ok=True)
    json.dump({"checked_at": 1, "latest": f"v{NEXT}", "skipped": f"v{LATER}"}, open(os.path.join(tmp, "st-skip2", "termium", "update-check.json"), "w"))
    k = term(cur_bin, "-s", "skip2", "--incognito", PAGE, state="st-skip2")
    check("skipped newer release: the badge shows it", k.wait_for(lambda: f"↑ v{LATER}" in k.line(1), 40), k.line(1))
    time.sleep(2)
    check("...but no offer shows (the cached older one is withdrawn)", not notice(k), k.line(2))
    k.key("ctrl+b"); k.key("shift+u")
    check("...and Ctrl+B U says it was skipped", k.wait_for(lambda: "was skipped" in k.line(2), 5) and not box_open(k), k.line(2))
    stop("skip2")

    # ------------------------------------------------ a release pulled since it was cached: the offer is withdrawn
    os.makedirs(os.path.join(tmp, "st-pulled", "termium"), exist_ok=True)
    json.dump({"checked_at": 1, "latest": f"v{NEXT}", "skipped": None}, open(os.path.join(tmp, "st-pulled", "termium", "update-check.json"), "w"))
    LATEST["tag"] = f"v{CUR}"
    pl = term(cur_bin, "-s", "pulled", "--incognito", PAGE, state="st-pulled")
    pl.wait_text("termium test page", 40)
    check("pulled release: the check finds the latest is this version", pl.wait_for(lambda: (cache("st-pulled") or {}).get("latest") == f"v{CUR}", 15), cache("st-pulled"))
    time.sleep(1)
    check("pulled release: ...and the cached offer and badge are withdrawn", not notice(pl) and not update_ui(pl), (pl.line(1), pl.line(2)))
    stop("pulled")

    # ------------------------------------------------ skipped in another session: withdrawn here on the next attach
    LATEST["tag"] = f"v{NEXT}"
    sx = term(cur_bin, "-s", "skx", "--incognito", PAGE, state="st-skx")
    check("skip elsewhere: offered in one session", sx.wait_for(lambda: notice(sx), 40))
    sx.key("ctrl+b"); sx.key("d"); exit_code(sx)
    sy = term(cur_bin, "-s", "sky", "--incognito", PAGE, state="st-skx")
    sy.wait_for(lambda: notice(sy), 40); open_box(sy); sy.key("s")
    check("skip elsewhere: skipped in another", sy.wait_for(lambda: (cache("st-skx") or {}).get("skipped") == f"v{NEXT}", 5), cache("st-skx"))
    stop("sky")
    sx2 = term(cur_bin, "attach", "skx", state="st-skx")
    sx2.wait_text("termium test page", 15); time.sleep(2)
    check("skip elsewhere: the first session withdraws its offer on re-attach", not notice(sx2) and badge(sx2), (sx2.line(1), sx2.line(2)))
    stop("skx")
    LATEST["tag"] = f"v{NEXT}"

    # ------------------------------------------------ a failed restart keeps its snapshot; a plain retry reopens it as it was
    layout = {"spaces": [{"name": "kept space", "active": 0, "tabs": [{"root": {"url": PAGE}, "focus": 0, "zoomed": False}]}],
              "activeSpace": 0, "sidebar": True, "zoom": 1}
    os.makedirs(sockdir, mode=0o700, exist_ok=True)
    def snapshot(name, profile):
        path = os.path.join(sockdir, f"{name}.restore")
        with open(path, "w") as f:
            json.dump({"v": 1, "at": int(time.time() * 1000), "from": CUR, "layout": layout,
                       "launch": {"profile": profile, "incognito": False, "scale": None, "search": "https://duckduckgo.com/?q=%s"}}, f)
        os.chmod(path, 0o600)
        return path
    def ls_row(name, state):
        out = subprocess.run([cur_bin, "ls"], env=dict(os.environ, **env_for(state)), capture_output=True, text=True).stdout
        return next((l for l in out.splitlines() if l.startswith(name + " ")), "")
    prof5 = os.path.join(tmp, "prof-resume")
    rpath = snapshot("rf", prof5)
    fz = term(cur_bin, "-s", "rf", state="st-rf", env={"TERMIUM_BROWSER": "/no/such/browser"})
    exit_code(fz, 20)
    check("restart snapshot: kept when the session fails to start", os.path.exists(rpath), output(fz)[-200:])
    rf = term(cur_bin, "-s", "rf", state="st-rf")
    check("restart snapshot: a plain retry reopens it", rf.wait_for(lambda: "kept space" in rf.text() and "termium test page" in rf.text(), 40), rf.text()[:300])
    check("restart snapshot: ...under its saved profile", os.path.realpath(prof5) in ls_row("rf", "st-rf"), ls_row("rf", "st-rf"))
    check("restart snapshot: ...and only then removes it", rf.wait_for(lambda: not os.path.exists(rpath), 5))
    stop("rf")
    rpath = snapshot("rf2", os.path.join(tmp, "prof-resume2"))
    rf2 = term(cur_bin, "-s", "rf2", "--incognito", state="st-rf")
    check("restart snapshot: started with other options, it says the snapshot is kept",
          rf2.wait_for(lambda: "Snapshot kept (it was started without --incognito)" in rf2.line(2), 40), rf2.line(2))
    check("restart snapshot: ...keeps it, and starts as asked", os.path.exists(rpath) and "(incognito)" in ls_row("rf2", "st-rf") and "kept space" not in rf2.text(), ls_row("rf2", "st-rf"))
    stop("rf2")
    # Every saved launch option counts: another --scale keeps the snapshot.
    def raw_snapshot(name, launch, lay=layout):
        path = os.path.join(sockdir, f"{name}.restore")
        with open(path, "w") as f:
            json.dump({"v": 1, "at": int(time.time() * 1000), "from": CUR, "layout": lay, "launch": launch}, f)
        os.chmod(path, 0o600)
        return path
    rpath = raw_snapshot("rf3", {"incognito": True, "scale": 1, "search": "https://duckduckgo.com/?q=%s"})
    rf3 = term(cur_bin, "-s", "rf3", "--incognito", "--scale", "1.5", state="st-rf")
    check("restart snapshot: another --scale keeps it, and says so", rf3.wait_for(lambda: "Snapshot kept (it was started with --scale 1)" in rf3.line(2), 40) and os.path.exists(rpath), rf3.line(2))
    stop("rf3")
    # Not every page reopened: kept, and the user told.
    partial = {"spaces": [{"name": "kept space", "active": 0, "tabs": [{"root": {"url": PAGE}, "focus": 0, "zoomed": False},
                                                                      {"root": {"dir": "x"}, "focus": 0, "zoomed": False}]}],
               "activeSpace": 0, "sidebar": True, "zoom": 1}
    rpath = raw_snapshot("rf4", {"incognito": True, "scale": None, "search": "https://duckduckgo.com/?q=%s"}, partial)
    rf4 = term(cur_bin, "-s", "rf4", state="st-rf")
    check("restart snapshot: partly reopened, it's kept and says so",
          rf4.wait_for(lambda: "Not all pages reopened" in rf4.line(2), 40) and "kept space" in rf4.text() and os.path.exists(rpath), (rf4.line(2), os.path.exists(rpath)))
    stop("rf4")
    # A restored page whose site is unreachable keeps its address (shown, reloadable, saved again).
    unreachable = "http://127.0.0.1:9/unreachable.html"
    gone = {"spaces": [{"name": "kept space", "active": 0, "tabs": [{"root": {"url": unreachable}, "focus": 0, "zoomed": False}]}],
            "activeSpace": 0, "sidebar": True, "zoom": 1}
    rpath = raw_snapshot("rf5", {"incognito": True, "scale": None, "search": "https://duckduckgo.com/?q=%s"}, gone)
    rf5 = term(cur_bin, "-s", "rf5", state="st-rf")
    check("restart snapshot: an unreachable page keeps its address", rf5.wait_for(lambda: "127.0.0.1:9/unreachable.html" in rf5.line(2), 40), rf5.line(2))
    check("restart snapshot: ...and counts as reopened (the snapshot goes)", rf5.wait_for(lambda: not os.path.exists(rpath), 10))
    rf5.key("ctrl+r")
    # (Reloaded while its first load may still be held by Helium's content blocker, the page is
    # replaced by a fresh one that shows no address until its navigation starts.)
    check("restart snapshot: ...and still has it after a reload", rf5.wait_for(lambda: "127.0.0.1:9/unreachable.html" in rf5.line(2), 20), rf5.line(2))
    stop("rf5")

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
    check("u: the notice appears", u.wait_for(lambda: notice(u), 40), u.line(2))
    old_server = server_pid("upd")
    open_box(u); u.key("u")
    check("u: the update downloads, verifies and installs", u.wait_for(lambda: f"updated to termium {NEXT}" in u.text(), 60), u.text()[-600:])
    check("u: the box says this session runs the old one until it restarts",
          u.wait_for(lambda: f"keeps running termium {CUR} until it restarts" in u.text() and "r restart" in u.text(), 5), u.text())
    shot(u, "update-done.png")
    r = subprocess.run([os.path.join(inst, "termium"), "--version"], capture_output=True, text=True)
    check("u: the binary (the symlink's target) is the new release", r.stdout.strip() == f"termium {NEXT}", r.stdout)
    check("u: the symlink is still a symlink, and no temp or lock files are left", os.path.islink(os.path.join(link, "termium")) and os.listdir(inst) == ["termium"], os.listdir(inst))
    check("u: the binary is executable", os.access(os.path.join(inst, "termium"), os.X_OK))
    check("u: the session still runs (the old version)", server_pid("upd") == old_server)
    check("u: the badge says a restart is due", f"↻ v{NEXT}" in u.line(1), u.line(1))
    open_box(u); u.key("enter"); time.sleep(1.5)
    check("Enter in the done box doesn't restart: it closes the box", not box_open(u) and server_pid("upd") == old_server and notice(u), u.line(2))
    open_box(u); u.key("r")
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
    check("r: no notice and no badge (it's up to date now)", not notice(u) and "↑" not in u.line(1) and "↻" not in u.line(1), u.line(1))
    check("r: the restore file is gone", not os.path.exists(os.path.join(sockdir, "upd.restore")))
    stop("upd")

    # ------------------------------------------------ the session's binary is updated and restarted into, whoever's terminal is attached
    inst_a = os.path.join(tmp, "inst-a"); os.makedirs(inst_a)
    inst_b = os.path.join(tmp, "inst-b"); os.makedirs(inst_b)
    shutil.copy(cur_bin, os.path.join(inst_a, "termium")); shutil.copy(cur_bin, os.path.join(inst_b, "termium"))
    ta = term(os.path.join(inst_a, "termium"), "-s", "two", "--incognito", PAGE, state="st-two")
    ta.wait_text("termium test page", 40)
    ta.key("ctrl+b"); ta.key("d"); exit_code(ta)
    tb = term(os.path.join(inst_b, "termium"), "attach", "two", state="st-two")
    tb.wait_for(lambda: notice(tb), 30)
    two_pid = server_pid("two")
    open_box(tb); tb.key("u")
    check("two copies: the update replaces the session's binary (A), and says which",
          tb.wait_for(lambda: f"updated to termium {NEXT}" in tb.text(), 60) and "inst-a" in tb.text(), tb.text()[-500:])
    ver = lambda d: subprocess.run([os.path.join(d, "termium"), "--version"], capture_output=True, text=True).stdout.strip()
    check("two copies: A is the new release, B (the attached terminal's) untouched", ver(inst_a) == f"termium {NEXT}" and ver(inst_b) == f"termium {CUR}", (ver(inst_a), ver(inst_b)))
    open_box(tb); tb.key("r")
    check("two copies: r restarts from A", tb.wait_for(lambda: "inst-a" in output(tb) and "restarting session two" in output(tb), 15) and
          tb.wait_for(lambda: server_pid("two") not in (None, two_pid), 30) and tb.wait_for(lambda: f"Restarted: termium {CUR} → {NEXT}" in tb.text(), 40), output(tb)[-300:])
    check("two copies: ls shows the session runs the new termium", f"(termium {NEXT})" in ls_row("two", "st-two"), ls_row("two", "st-two"))
    tb.key("ctrl+b"); tb.key("d"); exit_code(tb)
    tc = term(os.path.join(inst_b, "termium"), "attach", "two", state="st-two")
    tc.wait_text("termium test page", 20); tc.key("ctrl+b"); tc.key("d")
    check("two copies: the older copy attaching says it's older than the session", exit_code(tc) == 0 and f"is older than the one session \"two\" runs ({NEXT})" in output(tc), output(tc)[-300:])
    stop("two")

    # ------------------------------------------------ a newer termium that attached once is what a restart runs
    inst_o = os.path.join(tmp, "inst-old"); os.makedirs(inst_o)
    inst_n = os.path.join(tmp, "inst-new"); os.makedirs(inst_n)
    shutil.copy(cur_bin, os.path.join(inst_o, "termium")); shutil.copy(next_bin, os.path.join(inst_n, "termium"))
    for sess, remove in (("nw", False), ("nw2", True)):
        t1 = term(os.path.join(inst_o, "termium"), "-s", sess, "--incognito", PAGE, state="st-nw")
        t1.wait_text("termium test page", 40); t1.key("ctrl+b"); t1.key("d"); exit_code(t1)
        t2 = term(os.path.join(inst_n, "termium"), "attach", sess, state="st-nw")
        t2.wait_text("termium test page", 20); time.sleep(2); t2.key("ctrl+b"); t2.key("d"); exit_code(t2)
        if remove:
            os.remove(os.path.join(inst_n, "termium"))
        t3 = term(os.path.join(inst_o, "termium"), "attach", sess, state="st-nw")
        old_pid = server_pid(sess)
        check(f"{sess}: an older terminal is offered the restart into the newer termium that attached", t3.wait_for(lambda: f"termium {NEXT} is installed" in t3.line(2), 20), t3.line(2))
        open_box(t3); t3.key("r")
        if not remove:
            check(f"{sess}: r restarts it from that newer binary", t3.wait_for(lambda: "inst-new" in output(t3), 15) and
                  t3.wait_for(lambda: server_pid(sess) not in (None, old_pid), 30) and t3.wait_for(lambda: "Restarted:" in t3.text(), 40), output(t3)[-300:])
            check(f"{sess}: ls shows it runs the newer termium", f"(termium {NEXT})" in ls_row(sess, "st-nw"), ls_row(sess, "st-nw"))
        else:
            check(f"{sess}: that binary is gone: no restart, and it says so", t3.wait_for(lambda: "Can't restart" in t3.line(2), 15) and server_pid(sess) == old_pid
                  and "↻" not in t3.line(1), (t3.line(1), t3.line(2)))
        stop(sess)
    shutil.copy(next_bin, os.path.join(inst_n, "termium"))
    # The newer version known at one path, gone; the same version attaching from another: that one is used.
    inst_n2 = os.path.join(tmp, "inst-new2"); os.makedirs(inst_n2)
    shutil.copy(next_bin, os.path.join(inst_n2, "termium"))
    t1 = term(os.path.join(inst_o, "termium"), "-s", "nw3", "--incognito", PAGE, state="st-nw")
    t1.wait_text("termium test page", 40); t1.key("ctrl+b"); t1.key("d"); exit_code(t1)
    for d in (inst_n, inst_n2):
        t2 = term(os.path.join(d, "termium"), "attach", "nw3", state="st-nw")
        t2.wait_text("termium test page", 20); time.sleep(2); t2.key("ctrl+b"); t2.key("d"); exit_code(t2)
        if d == inst_n:
            os.remove(os.path.join(inst_n, "termium"))
    t3 = term(os.path.join(inst_o, "termium"), "attach", "nw3", state="st-nw")
    old_pid = server_pid("nw3")
    t3.wait_for(lambda: f"termium {NEXT} is installed" in t3.line(2), 20)
    open_box(t3); t3.key("r")
    check("nw3: the same newer version from another path (the first gone) is what r restarts into",
          t3.wait_for(lambda: "inst-new2" in output(t3), 15) and t3.wait_for(lambda: server_pid("nw3") not in (None, old_pid), 30) and
          f"(termium {NEXT})" in ls_row("nw3", "st-nw"), (output(t3)[-300:], ls_row("nw3", "st-nw")))
    stop("nw3")
    shutil.copy(next_bin, os.path.join(inst_n, "termium"))

    # Two verified copies of the newer version; the more recent one removed: r falls back to the earlier one.
    t1 = term(os.path.join(inst_o, "termium"), "-s", "nw4", "--incognito", PAGE, state="st-nw")
    t1.wait_text("termium test page", 40); t1.key("ctrl+b"); t1.key("d"); exit_code(t1)
    for d in (inst_n, inst_n2):
        t2 = term(os.path.join(d, "termium"), "attach", "nw4", state="st-nw")
        t2.wait_text("termium test page", 20); time.sleep(2); t2.key("ctrl+b"); t2.key("d"); exit_code(t2)
    os.remove(os.path.join(inst_n2, "termium"))
    t3 = term(os.path.join(inst_o, "termium"), "attach", "nw4", state="st-nw")
    old_pid = server_pid("nw4")
    t3.wait_for(lambda: f"termium {NEXT} is installed" in t3.line(2), 20)
    open_box(t3); t3.key("r")
    check("nw4: the most recent copy gone, r falls back to the earlier verified one",
          t3.wait_for(lambda: "inst-new/termium" in output(t3), 15) and t3.wait_for(lambda: server_pid("nw4") not in (None, old_pid), 30) and
          f"(termium {NEXT})" in ls_row("nw4", "st-nw"), (output(t3)[-300:], ls_row("nw4", "st-nw")))
    stop("nw4")
    shutil.copy(next_bin, os.path.join(inst_n2, "termium"))

    # ------------------------------------------------ async work started by one terminal does nothing for the next
    # (The session's unsaved-changes probe is made to take 3 s, as a busy page's can.)
    ra = term(os.path.join(inst_o, "termium"), "-s", "rc", "--incognito", PAGE, state="st-nw", env={"TERMIUM_TEST_SLOW_PROBE_MS": "3000"})
    ra.wait_text("termium test page", 40); ra.key("ctrl+b"); ra.key("d"); exit_code(ra)
    rn = term(os.path.join(inst_n, "termium"), "attach", "rc", state="st-nw")
    rn.wait_text("termium test page", 20); time.sleep(2); rn.key("ctrl+b"); rn.key("d"); exit_code(rn)
    ra = term(os.path.join(inst_o, "termium"), "attach", "rc", state="st-nw")
    ra.wait_for(lambda: f"termium {NEXT} is installed" in ra.line(2), 20)
    rc_pid = server_pid("rc")
    open_box(ra); ra.key("r")
    rb = term(os.path.join(inst_o, "termium"), "attach", "rc", "--no-update-check", state="st-nw")
    rb.wait_text("termium test page", 20); time.sleep(4)
    rb.key("enter"); time.sleep(2)
    rclog = open(os.path.join(tmp, "st-nw", "termium", "termium.log")).read()
    check("a restart confirmation started by one terminal never reaches the next, nor restarts for it",
          "restart: the terminal that asked left or opened something else meanwhile; dropped" in rclog and "Restart anyway" not in rb.text() and server_pid("rc") == rc_pid and not update_ui(rb),
          (rb.line(2), server_pid("rc"), rc_pid, rclog[-400:]))
    stop("rc")
    # The same terminal opens the address bar while its slow probe runs: the question doesn't replace their edit.
    ra = term(os.path.join(inst_o, "termium"), "-s", "rc2", "--incognito", PAGE, state="st-nw", env={"TERMIUM_TEST_SLOW_PROBE_MS": "3000"})
    ra.wait_text("termium test page", 40); ra.key("ctrl+b"); ra.key("d"); exit_code(ra)
    rn = term(os.path.join(inst_n, "termium"), "attach", "rc2", state="st-nw")
    rn.wait_text("termium test page", 20); time.sleep(2); rn.key("ctrl+b"); rn.key("d"); exit_code(rn)
    ra = term(os.path.join(inst_o, "termium"), "attach", "rc2", state="st-nw")
    ra.wait_for(lambda: f"termium {NEXT} is installed" in ra.line(2), 20)
    rc_pid = server_pid("rc2")
    open_box(ra); ra.key("r"); time.sleep(0.5)
    ra.key("ctrl+l"); ra.key("ctrl+a"); ra.type("my draft"); time.sleep(4)
    ra.key("enter"); time.sleep(2)
    check("a slow restart question started before the person began editing the address never replaces their edit",
          "Restart anyway" not in ra.text() and server_pid("rc2") == rc_pid, (ra.line(2), server_pid("rc2"), rc_pid))
    stop("rc2")
    sk2_cache = os.path.join(tmp, "st-sk2", "termium", "update-check.json")
    sa = term(cur_bin, "-s", "sk2", "--incognito", PAGE, state="st-sk2")
    sa.wait_for(lambda: notice(sa), 40)
    os.makedirs(os.path.dirname(sk2_cache), exist_ok=True)
    holder = subprocess.Popen(["bun", "-e", f"const b = await import({json.dumps(os.path.join(ROOT, 'src', 'browser.ts'))}); "
                               f"console.log(b.lockFile({json.dumps(sk2_cache + '.lock')})); await Bun.sleep(4000); b.unlockFile({json.dumps(sk2_cache + '.lock')});"],
                              stdout=subprocess.PIPE, text=True)
    holder.stdout.readline()
    open_box(sa); sa.key("s")
    sb = term(cur_bin, "attach", "sk2", "--no-update-check", state="st-sk2")
    sb.wait_text("termium test page", 20); holder.wait(); time.sleep(2)
    check("a skip saved after an opted-out terminal took over says nothing there (but is saved)",
          "skipped" not in sb.line(2) and not update_ui(sb) and (cache("st-sk2") or {}).get("skipped") == f"v{NEXT}", (sb.line(2), cache("st-sk2")))
    stop("sk2")

    # ------------------------------------------------ a restart keeps the session's browser, profile and data dirs, not the restarting shell's
    helium = shutil.which("helium-browser") or shutil.which("helium") or shutil.which("google-chrome")
    edir = os.path.join(tmp, "envb"); os.makedirs(edir)
    os.symlink(helium, os.path.join(edir, "env-browser"))
    data_a = os.path.join(tmp, "data-a")
    e1 = term(os.path.join(inst_o, "termium"), "-s", "renv", PAGE, state="st-renv",
              env={"TERMIUM_BROWSER": os.path.join(edir, "env-browser"), "XDG_DATA_HOME": data_a})
    e1.wait_text("termium test page", 40); e1.key("ctrl+b"); e1.key("d"); exit_code(e1)
    e2 = term(os.path.join(inst_n, "termium"), "attach", "renv", state="st-renv", env={"XDG_DATA_HOME": os.path.join(tmp, "data-b")})
    e2.wait_for(lambda: f"termium {NEXT} is installed" in e2.line(2), 20)
    old_pid = server_pid("renv")
    open_box(e2); e2.key("r")
    check("restart from a shell with another environment: the session restarts", e2.wait_for(lambda: server_pid("renv") not in (None, old_pid), 30)
          and e2.wait_for(lambda: "Restarted:" in e2.text(), 40), output(e2)[-300:])
    rlog = open(os.path.join(tmp, "st-renv", "termium", "termium.log")).read()
    starts = [l for l in rlog.splitlines() if " start " in l]
    check("...with the session's own browser and profile (not the shell's)",
          starts and "env-browser" in starts[-1] and os.path.realpath(os.path.join(data_a, "termium", "profiles", "renv")) in ls_row("renv", "st-renv")
          and not os.path.exists(os.path.join(tmp, "data-b", "termium", "profiles", "renv")), (starts[-1:], ls_row("renv", "st-renv")))
    stop("renv")

    # ------------------------------------------------ a browser chosen by name (on that shell's PATH) survives a restart from a shell without it
    os.symlink(helium, os.path.join(edir, "helium-review"))
    n1 = term(os.path.join(inst_o, "termium"), "-s", "rname", "--incognito", "--browser", "helium-review", PAGE, state="st-rname",
              env={"PATH": edir + os.pathsep + os.environ["PATH"]})
    n1.wait_text("termium test page", 40); n1.key("ctrl+b"); n1.key("d"); exit_code(n1)
    n2 = term(os.path.join(inst_n, "termium"), "attach", "rname", state="st-rname")
    n2.wait_for(lambda: f"termium {NEXT} is installed" in n2.line(2), 20)
    old_pid = server_pid("rname")
    open_box(n2); n2.key("r")
    check("--browser NAME: a restart from a shell without it on PATH still finds it",
          n2.wait_for(lambda: server_pid("rname") not in (None, old_pid), 30) and n2.wait_for(lambda: "Restarted:" in n2.text(), 40), output(n2)[-300:])
    stop("rname")

    # ------------------------------------------------ the session keeps answering while an update checks the new binary
    inst_sv = os.path.join(tmp, "inst-slowv"); os.makedirs(inst_sv)
    shutil.copy(cur_bin, os.path.join(inst_sv, "termium"))
    sv = term(os.path.join(inst_sv, "termium"), "-s", "slowv", "--incognito", PAGE, state="st-slowv", env={"TERMIUM_TEST_VERSION_DELAY_MS": "3000"})
    sv.wait_for(lambda: notice(sv), 40)
    open_box(sv); sv.key("u")
    sv.wait_for(lambda: "verifying" in sv.text() or "installing" in sv.text(), 30)
    t0 = time.time()
    r = subprocess.run([cur_bin, "ctl", "-s", "slowv", "tabs", "--timeout", "2"], env=dict(os.environ, **env_for("st-slowv")),
                       capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=30)
    took = time.time() - t0
    check(f"while the new binary is being checked (3 s), the session answers agents ({took:.1f}s)", r.returncode == 0 and took < 2, (r.returncode, r.stderr))
    check("...and the update completes", sv.wait_for(lambda: f"updated to termium {NEXT}" in sv.text(), 60), sv.text()[-400:])
    stop("slowv")

    # ------------------------------------------------ updated again from a shell (same place, newer still): r runs that one
    inst_nv = os.path.join(tmp, "inst-nv"); os.makedirs(inst_nv)
    shutil.copy(cur_bin, os.path.join(inst_nv, "termium"))
    LATEST["tag"] = f"v{NEXT}"
    nv = term(os.path.join(inst_nv, "termium"), "-s", "nv", "--incognito", PAGE, state="st-nv")
    nv.wait_for(lambda: notice(nv), 40)
    open_box(nv); nv.key("u")
    nv.wait_for(lambda: f"updated to termium {NEXT}" in nv.text(), 60)
    nv.key("escape")
    r = cli(os.path.join(inst_nv, "termium"), "update", state="st-nv", TERMIUM_UPDATE_URL=f"{BASE}/latest/v{LATER}")
    old_pid = server_pid("nv")
    open_box(nv); nv.key("r")
    check("updated to a newer release again from a shell: r restarts into that one",
          r.returncode == 0 and nv.wait_for(lambda: server_pid("nv") not in (None, old_pid), 30) and f"(termium {LATER})" in ls_row("nv", "st-nv"),
          (r.returncode, r.stdout[-200:], output(nv)[-200:], ls_row("nv", "st-nv")))
    stop("nv")

    # ------------------------------------------------ the update box doesn't lose what the person typed into a page's prompt()
    pd = term(cur_bin, "-s", "pdraft", "--incognito", PAGE, state="st-pdraft")
    pd.wait_for(lambda: notice(pd), 40)
    subprocess.run([cur_bin, "ctl", "-s", "pdraft", "eval", "setTimeout(() => { window.ans = prompt('Your name?'); }, 0); 1"],
                   env=dict(os.environ, **env_for("st-pdraft")), capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=30)
    pd.wait_for(lambda: "Your name?" in pd.line(2), 10)
    pd.key("ctrl+a"); pd.key("backspace"); pd.type("draft"); time.sleep(0.3)
    open_box(pd); pd.key("escape")
    check("a prompt()'s answer typed so far comes back after the update box", pd.wait_for(lambda: "Your name?" in pd.line(2) and "draft" in pd.line(2), 5), pd.line(2))
    pd.key("enter"); time.sleep(0.5)
    ans = subprocess.run([cur_bin, "ctl", "-s", "pdraft", "eval", "window.ans", "--json"], env=dict(os.environ, **env_for("st-pdraft")),
                         capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=30).stdout
    check("...and it's what the page gets", '"draft"' in ans, ans)
    stop("pdraft")

    # ------------------------------------------------ a relative --browser survives a restart from another directory
    helium = shutil.which("helium-browser") or shutil.which("helium") or shutil.which("google-chrome")
    bdir = os.path.join(tmp, "bdir"); os.makedirs(bdir)
    os.symlink(helium, os.path.join(bdir, "my-browser"))
    t1 = Term([cur_bin, "-s", "relb", "--incognito", "--browser", "./my-browser", PAGE], cwd=bdir, env=env_for("st-relb")); terms.append(t1)
    check("relative --browser: the session starts", t1.wait_text("termium test page", 40))
    t1.key("ctrl+b"); t1.key("d"); exit_code(t1)
    t2 = term(os.path.join(inst_n, "termium"), "attach", "relb", state="st-relb")  # cwd: elsewhere
    t2.wait_for(lambda: f"termium {NEXT} is installed" in t2.line(2), 20)
    old_pid = server_pid("relb")
    open_box(t2); t2.key("r")
    check("relative --browser: r from another directory restarts it with the same browser",
          t2.wait_for(lambda: server_pid("relb") not in (None, old_pid), 30) and t2.wait_for(lambda: "Restarted:" in t2.text(), 40) and
          not os.path.exists(os.path.join(sockdir, "relb.restore")), (output(t2)[-300:], ls_row("relb", "st-relb")))
    stop("relb")

    # ------------------------------------------------ a skip is reported saved only once it is
    sk_cache = os.path.join(tmp, "st-sklock", "termium", "update-check.json")
    def hold_lock(seconds):
        os.makedirs(os.path.dirname(sk_cache), exist_ok=True)
        h = subprocess.Popen(["bun", "-e", f"const b = await import({json.dumps(os.path.join(ROOT, 'src', 'browser.ts'))}); "
                              f"console.log(b.lockFile({json.dumps(sk_cache + '.lock')})); await Bun.sleep({seconds * 1000}); b.unlockFile({json.dumps(sk_cache + '.lock')});"],
                             stdout=subprocess.PIPE, text=True)
        h.stdout.readline()
        return h
    sk = term(cur_bin, "-s", "sklock", "--incognito", PAGE, state="st-sklock")
    sk.wait_for(lambda: notice(sk), 40)
    holder = hold_lock(14)
    open_box(sk); sk.key("s")
    check("skip, cache locked throughout: says it couldn't be saved", sk.wait_for(lambda: "couldn't save it" in sk.line(2), 16) and
          (cache("st-sklock") or {}).get("skipped") is None, (sk.line(2), cache("st-sklock")))
    holder.wait()
    stop("sklock")
    sk = term(cur_bin, "-s", "sklock", "--incognito", PAGE, state="st-sklock")
    check("skip, not saved: offered again in the next session", sk.wait_for(lambda: notice(sk), 40))
    holder = hold_lock(3)
    open_box(sk); sk.key("s")
    check("skip, cache locked a while: saved once free, then says so", sk.wait_for(lambda: "skipped: not offered again" in sk.line(2), 12) and
          (cache("st-sklock") or {}).get("skipped") == f"v{NEXT}", (sk.line(2), cache("st-sklock")))
    holder.wait()
    stop("sklock")

    # ------------------------------------------------ agents: termium start and ctl never check nor show update news
    def agent(binary, *args, state, timeout=90, **extra):
        # No terminal, as an agent's tool call.
        return subprocess.run([binary, *args], env=dict(os.environ, **env_for(state, **extra)), stdin=subprocess.DEVNULL,
                              capture_output=True, text=True, timeout=timeout, start_new_session=True)
    n = len(HITS)
    r = agent(cur_bin, "start", "-s", "ag", "--incognito", PAGE, state="st-ag")
    r2 = agent(cur_bin, "ctl", "-s", "ag", "tabs", state="st-ag")
    r3 = agent(cur_bin, "ctl", "-s", "ag", "open", f"{BASE}/fixtures/reader.html", state="st-ag")
    time.sleep(4)
    check("agents: termium start and ctl work, and never check for updates", r.returncode == 0 and r2.returncode == 0 and r3.returncode == 0 and len(HITS) == n,
          (r.returncode, r.stderr[-200:], r2.returncode, r2.stderr[-200:], r3.returncode, HITS[n:]))
    at = term(cur_bin, "attach", "ag", state="st-ag")
    check("agents: ...a terminal attaching later gets the check and the notice", at.wait_for(lambda: notice(at), 30) and len(HITS) == n + 1, (at.line(2), HITS[n:]))
    open_box(at)
    r4 = agent(cur_bin, "ctl", "-s", "ag", "tabs", state="st-ag")
    time.sleep(1)
    check("agents: a ctl request isn't an attach: the box the terminal opened stays open, no new check",
          r4.returncode == 0 and box_open(at) and len(HITS) == n + 1, (r4.returncode, at.line(2), HITS[n:]))
    at.key("escape")
    stop("ag")

    # ------------------------------------------------ restart keeps tabs other DevTools clients opened, on a new endpoint
    inst_c = os.path.join(tmp, "inst-ctl"); os.makedirs(inst_c)
    shutil.copy(cur_bin, os.path.join(inst_c, "termium"))
    ac = term(os.path.join(inst_c, "termium"), "-s", "agr", "--incognito", PAGE, state="st-agr")
    ac.wait_text("termium test page", 40)
    def endpoint():
        d = agent(os.path.join(inst_c, "termium"), "devtools", "agr", state="st-agr")
        return d.stdout.strip() if d.returncode == 0 else None
    before = endpoint()
    ext = subprocess.run(["bun", os.path.join(ROOT, "tests/support/cdp-ext.ts"), "create", before or "", f"{BASE}/fixtures/reader.html?ext=1"],
                         capture_output=True, text=True, timeout=30)
    check("restart with agents: a DevTools client opens a tab", ext.returncode == 0 and ac.wait_for(lambda: "2" in ac.line(1) and "reader" in ac.line(1).lower(), 15),
          (before, ext.stderr[-200:], ac.line(1)))
    iso = subprocess.Popen(["bun", os.path.join(ROOT, "tests/support/cdp-ext.ts"), "create-isolated", before or "", f"{BASE}/fixtures/reader.html?iso=1", "120"],
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    iso.stdout.readline()
    check("restart with agents: a DevTools client opens a tab in an isolated context", ac.wait_for(lambda: " 3 " in ac.line(1), 15), ac.line(1))
    ac.wait_for(lambda: notice(ac), 30)
    open_box(ac); ac.key("u")
    ac.wait_for(lambda: f"updated to termium {NEXT}" in ac.text(), 60)
    old_pid = server_pid("agr")
    open_box(ac); ac.key("r")
    check("restart with agents: the session restarts, saying the isolated context's tab isn't reopened",
          ac.wait_for(lambda: server_pid("agr") not in (None, old_pid), 30) and ac.wait_for(lambda: "(1 tab of other" in ac.text(), 40), ac.line(2))
    iso.kill(); iso.wait()
    after = endpoint()
    def page_urls(url):
        import urllib.request
        try:
            return [p["url"] for p in json.load(urllib.request.urlopen(f"{url}/json/list", timeout=5)) if p.get("type") == "page"]
        except Exception as e:
            return [repr(e)]
    check("restart with agents: the DevTools endpoint is back, on its new port, and termium devtools reports it",
          after and after != before and any("page.html" in u for u in page_urls(after)), (before, after, page_urls(after) if after else None))
    check("restart with agents: the tab the DevTools client opened is reopened", ac.wait_for(lambda: any("ext=1" in u for u in page_urls(after)), 20), page_urls(after))
    check("restart with agents: ...but not the isolated context's (it'd lose its isolation)", not any("iso=1" in u for u in page_urls(after)), page_urls(after))
    stop("agr")

    # ------------------------------------------------ with update checks off, the restart into an installed termium still works
    t1 = term(os.path.join(inst_o, "termium"), "-s", "optr", "--incognito", PAGE, state="st-optr", env={"TERMIUM_NO_UPDATE_CHECK": "1"})
    t1.wait_text("termium test page", 40); t1.key("ctrl+b"); t1.key("d"); exit_code(t1)
    t2 = term(os.path.join(inst_n, "termium"), "attach", "optr", state="st-optr", env={"TERMIUM_NO_UPDATE_CHECK": "1"})
    t2.wait_text("termium test page", 20); time.sleep(2); t2.key("ctrl+b"); t2.key("d"); exit_code(t2)
    t3 = term(os.path.join(inst_o, "termium"), "attach", "optr", state="st-optr", env={"TERMIUM_NO_UPDATE_CHECK": "1"})
    t3.wait_text("termium test page", 20); time.sleep(1.6)
    old_pid = server_pid("optr")
    open_box(t3); t3.key("r")
    check("opted out: Ctrl+B U, r restarts into the installed termium",
          t3.wait_for(lambda: server_pid("optr") not in (None, old_pid), 30) and t3.wait_for(lambda: "Restarted:" in t3.text(), 40)
          and f"(termium {NEXT})" in ls_row("optr", "st-optr"), (output(t3)[-300:], ls_row("optr", "st-optr")))
    stop("optr")

    # ------------------------------------------------ two updaters at once never downgrade
    for i in range(3):
        cc = os.path.join(tmp, f"inst-race{i}"); os.makedirs(cc)
        shutil.copy(cur_bin, os.path.join(cc, "termium"))
        procs = [subprocess.Popen([os.path.join(cc, "termium"), "update"], env=dict(os.environ, **env_for("cli", TERMIUM_UPDATE_URL=f"{BASE}/latest/v{v}")),
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for v in (NEXT, LATER)]
        outs = [p.communicate(timeout=120) for p in procs]
        got = subprocess.run([os.path.join(cc, "termium"), "--version"], capture_output=True, text=True).stdout.strip()
        check(f"concurrent updaters (run {i + 1}): both succeed and the newer release stays", all(p.returncode == 0 for p in procs) and got == f"termium {LATER}"
              and sorted(os.listdir(cc)) == ["termium"], (got, [p.returncode for p in procs], outs, os.listdir(cc)))
    # Two updaters to the same release: one updates, the other says another update got there first.
    cc = os.path.join(tmp, "inst-same"); os.makedirs(cc)
    shutil.copy(cur_bin, os.path.join(cc, "termium"))
    procs = [subprocess.Popen([os.path.join(cc, "termium"), "update"], env=dict(os.environ, **env_for("cli", TERMIUM_UPDATE_URL=f"{BASE}/latest/v{LATER}")),
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in range(2)]
    outs = [p.communicate(timeout=120)[0] for p in procs]
    check("two updaters to one release: one says updated, the other that another update already installed it",
          sorted(("Updated to termium" in o, "already installed by another update" in o) for o in outs) == [(False, True), (True, False)], outs)

    # ------------------------------------------------ termium update from the shell; a newer client attaching
    inst2 = os.path.join(tmp, "inst2"); os.makedirs(inst2)
    shutil.copy(cur_bin, os.path.join(inst2, "termium"))
    prof6 = os.path.join(tmp, "prof-shell")
    o = term(os.path.join(inst2, "termium"), "-s", "shell", "--profile", prof6, PAGE, state="st-shell", env={"TERMIUM_NO_UPDATE_CHECK": "1"})
    o.wait_text("termium test page", 40)
    o.key("ctrl+b"); o.key("d"); exit_code(o)
    r = cli(os.path.join(inst2, "termium"), "update", state="st-shell")
    check("termium update: updates a release binary (exit 0)", r.returncode == 0 and f"Updated to termium {NEXT}" in r.stdout and "downloading" in r.stdout, (r.returncode, r.stdout, r.stderr))
    check("termium update: says running sessions keep the old version until restarted", "shell" in r.stdout and "keep" in r.stdout and "Ctrl+B U, then r" in r.stdout, r.stdout)
    r2 = subprocess.run([os.path.join(inst2, "termium"), "--version"], capture_output=True, text=True)
    check("termium update: the new binary reports the new version", r2.stdout.strip() == f"termium {NEXT}", r2.stdout)
    r = cli(os.path.join(inst2, "termium"), "update", state="st-shell")
    check("termium update again: up to date (exit 0)", r.returncode == 0 and f"termium {NEXT} is up to date" in r.stdout, (r.returncode, r.stdout))
    # Opted out: no update news, but a restart into the termium now installed is still offered on Ctrl+B U.
    qo = term(os.path.join(inst2, "termium"), "attach", "shell", state="st-shell", env={"TERMIUM_NO_UPDATE_CHECK": "1"})
    qo.wait_text("termium test page", 20); time.sleep(1)
    qo.key("ctrl+b"); qo.key("shift+u")
    check("opted out: Ctrl+B U still offers the restart into the installed termium", qo.wait_for(lambda: box_open(qo) and "is installed" in qo.text(), 10), qo.line(2))
    qo.key("escape"); time.sleep(0.5); qo.key("ctrl+b"); qo.key("d"); exit_code(qo)
    q = term(os.path.join(inst2, "termium"), "attach", "shell", state="st-shell")
    check("a newer client attaching to the old session: a restart is offered", q.wait_for(lambda: notice(q) and f"↻ termium {NEXT} is installed" in q.line(2), 30), q.line(2))
    open_box(q)
    check("...the box offers r restart", f"termium {NEXT}" in q.text() and "is installed" in q.text() and "r restart" in q.text(), q.text()[-500:])
    q.key("l")
    check("...l: later, with the ↻ badge", q.wait_for(lambda: not box_open(q) and f"↻ v{NEXT}" in q.line(1), 5), q.line(1))
    # A page with unsaved changes: restarting asks first.
    q.wait_idle(0.8, 10)
    g = page_eval("(() => { const r = document.getElementById('guard').getBoundingClientRect(); return [r.x + 10, r.y + r.height/2]; })()", prof6)
    q.click(220 + int(g[0]), 40 + int(g[1])); time.sleep(0.3); q.type("x"); time.sleep(0.5)
    shell_pid = server_pid("shell")
    open_box(q); q.key("r")
    check("r with unsaved changes asks first", q.wait_for(lambda: "may have unsaved changes. Restart anyway?" in q.line(2), 10), q.line(2))
    q.key("escape"); time.sleep(1.5)
    check("...Esc keeps the session", server_pid("shell") == shell_pid and "Restart anyway" not in q.line(2))
    open_box(q); q.key("r")
    q.wait_for(lambda: "Restart anyway?" in q.line(2), 10); q.key("enter")
    check("...Enter there restarts it", q.wait_for(lambda: server_pid("shell") not in (None, shell_pid), 40) and q.wait_for(lambda: "Restarted:" in q.text(), 40), output(q)[-200:])
    stop("shell")

    # ------------------------------------------------ refusals and failures always say how to update by hand
    r = subprocess.run(["bun", os.path.join(ROOT, "src", "main.ts"), "update"], env=dict(os.environ, **env_for("cli")), capture_output=True, text=True, timeout=60)
    check("from source: termium update refuses cleanly", r.returncode == 1 and "runs from source" in r.stderr and "install.sh" in r.stderr, (r.returncode, r.stderr))
    ro = os.path.join(tmp, "ro"); os.makedirs(ro)
    shutil.copy(cur_bin, os.path.join(ro, "termium")); os.chmod(ro, 0o555)
    r = cli(os.path.join(ro, "termium"), "update")
    check("unwritable folder: termium update refuses cleanly", r.returncode == 1 and "can't write to" in r.stderr and "install.sh" in r.stderr and sha(os.path.join(ro, "termium")) == sha(cur_bin), (r.returncode, r.stderr))
    os.chmod(ro, 0o755)
    r = cli(cur_bin, "update", TERMIUM_UPDATE_URL="http://127.0.0.1:1/latest")
    check("termium update offline: fails (exit 1) with the update-by-hand command", r.returncode == 1 and "could not check for updates" in r.stderr and "Update by hand" in r.stderr and "install.sh" in r.stderr, (r.returncode, r.stderr))

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

    # ------------------------------------------------ a session started by the real termium 0.2.0
    if not old_bin:
        print("SKIP termium 0.2.0 sessions: no v0.2.0 tag in this checkout")
    else:
        prof4 = os.path.join(tmp, "prof-legacy")
        l0 = term(old_bin, "-s", "legacy", "--profile", prof4, PAGE, state="st-legacy")
        check("0.2.0: the old termium starts its session", l0.wait_text("termium test page", 40))
        old_pid = server_pid("legacy")
        l0.key("ctrl+b"); l0.key("d"); exit_code(l0)
        lq = term(cur_bin, "attach", "legacy", "--no-update-check", state="st-legacy")
        check("0.2.0: with --no-update-check, no question", lq.wait_text("termium test page", 20) and "[y/N]" not in output(lq), output(lq)[-300:])
        lq.key("ctrl+b"); lq.key("d")
        check("0.2.0: ...and no restart instructions on detach", exit_code(lq) == 0 and "termium kill legacy" not in output(lq), output(lq)[-300:])
        # A question left open while the session is replaced: answering it does nothing to the new one.
        g0 = term(old_bin, "-s", "lgx", "--incognito", PAGE, state="st-legacy")
        g0.wait_text("termium test page", 40); g0.key("ctrl+b"); g0.key("d"); exit_code(g0)
        g1 = term(cur_bin, "attach", "lgx", state="st-legacy")
        g1.wait_for(lambda: "[y/N]" in output(g1), 10)
        cli(cur_bin, "kill", "lgx", state="st-legacy")
        g2 = term(cur_bin, "-s", "lgx", "--incognito", PAGE, state="st-legacy")
        g2.wait_text("termium test page", 40)
        new_pid = server_pid("lgx")
        g1.write("y\r")
        check("0.2.0: a question about a session replaced meanwhile expires, and the new one is left alone",
              exit_code(g1, 15) == 1 and "changed while you answered" in output(g1) and server_pid("lgx") == new_pid, (output(g1)[-300:], new_pid, server_pid("lgx")))
        stop("lgx")
        # A paste at the question (bracketed or not) is never an answer; Enter alone is no.
        if os.path.exists(os.path.join(sockdir, "legacy.asked")):
            os.remove(os.path.join(sockdir, "legacy.asked"))
        lp = term(cur_bin, "attach", "legacy", state="st-legacy")
        lp.wait_for(lambda: "[y/N]" in output(lp), 10)
        lp.write("\x1b[200~yellow pasted text\r\x1b[201~"); time.sleep(0.5)
        lp.write("yellow pasted text\r"); time.sleep(0.5)
        check("0.2.0: a paste at the question isn't taken for yes", server_pid("legacy") == old_pid and "termium test page" not in lp.text())
        lp.write("\r")
        check("0.2.0: ...and Enter alone then means no: it attaches", lp.wait_text("termium test page", 20) and server_pid("legacy") == old_pid, output(lp)[-300:])
        lp.key("ctrl+b"); lp.key("d"); exit_code(lp)
        # Ctrl+D (end of input) at the question is a no, not a hang.
        os.remove(os.path.join(sockdir, "legacy.asked")) if os.path.exists(os.path.join(sockdir, "legacy.asked")) else None
        le = term(cur_bin, "attach", "legacy", state="st-legacy")
        le.wait_for(lambda: "[y/N]" in output(le), 10)
        le.write("\x04")
        check("0.2.0: Ctrl+D at the question means no: it attaches", le.wait_text("termium test page", 20) and server_pid("legacy") == old_pid, output(le)[-300:])
        le.key("ctrl+b"); le.key("d"); exit_code(le)
        os.remove(os.path.join(sockdir, "legacy.asked"))
        l1 = term(cur_bin, "attach", "legacy", state="st-legacy")
        check(f"0.2.0: attaching from {CUR} says the session runs 0.2.0 and asks to restart it",
              l1.wait_for(lambda: f"runs termium 0.2.0, older than this termium ({CUR})" in output(l1) and "[y/N]" in output(l1), 10), output(l1)[-400:])
        l1.write("n\r")
        check("0.2.0: answering no attaches to it as it is", l1.wait_text("termium test page", 20) and server_pid("legacy") == old_pid)
        l1.key("ctrl+b"); l1.key("d")
        check("0.2.0: detaching repeats how to restart it", exit_code(l1) == 0 and "termium kill legacy && termium -s legacy" in output(l1), output(l1)[-300:])
        l2 = term(cur_bin, "attach", "legacy", state="st-legacy")
        check("0.2.0: asked once per session: a second attach goes straight in", l2.wait_text("termium test page", 20) and "[y/N]" not in output(l2))
        l2.key("ctrl+b"); l2.key("d"); exit_code(l2)
        os.remove(os.path.join(sockdir, "legacy.asked"))
        l3 = term(cur_bin, "attach", "legacy", state="st-legacy")
        l3.wait_for(lambda: "[y/N]" in output(l3), 10)
        l3.write("y\r")
        check("0.2.0: answering yes restarts it from this termium, same profile",
              l3.wait_for(lambda: server_pid("legacy") not in (None, old_pid), 40) and l3.wait_for(lambda: "SPACES" in l3.text(), 30), output(l3)[-300:])
        info = subprocess.run([cur_bin, "ls"], env=dict(os.environ, **env_for("st-legacy")), capture_output=True, text=True).stdout
        check("0.2.0: ...ls shows it now runs this termium, on the same profile", "legacy" in info and "(termium" not in info and os.path.realpath(prof4) in info, info)
        stop("legacy")
finally:
    for t in terms:
        if t.alive:
            try:
                os.kill(t.pid, signal.SIGKILL); os.waitpid(t.pid, 0)
            except Exception:
                pass
            t.alive = False
    for name in ("t0", "t1", "t2", "t3", "t4", "abort", "offer", "skip", "bad", "later", "skip2", "skx", "sky", "two", "nw", "nw2", "nw3", "nw4", "rc", "rc2", "sk2", "relb", "ag", "agr", "renv", "rname", "slowv", "nv", "clock", "pdraft", "optr", "pulled", "lgx", "sklock", "rf", "rf2", "rf3", "rf4", "rf5", "upd", "shell", "proto", "legacy"):
        stop(name)
    httpd.shutdown()
    time.sleep(1)
    shutil.rmtree(tmp, ignore_errors=True)

print("FAILED: " + ", ".join(failures) if failures else "ALL PASSED")
sys.exit(1 if failures else 0)
