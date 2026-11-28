#!/usr/bin/env python3
"""Tab audio against the real stack (termium + Helium): the ♪ / 🔇 icon on
tabs and spaces, muting by clicking it, by Ctrl+B m and by `termium ctl
mute/unmute`, for an <audio> element, a Web Audio oscillator and audio in a
cross-site iframe; mute surviving tab switches; the icon clearing once the
sound stops.

Real silence is checked where the sound goes: the browser plays into a null
sink of a private PipeWire started here (no devices of its own, nothing
reaches the speakers) and the sink's monitor is measured. The page is checked
too: a muted tab still plays (not paused or suspended), it is just silent.

Needs pipewire, wireplumber, pipewire-pulse, pactl and parec; skipped
without them. Usage: python3 tests/audio.py
"""
import array, json, math, os, shutil, signal, socket, subprocess, sys, tempfile, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
from drive import Term

TOOLS = ("pipewire", "wireplumber", "pipewire-pulse", "pactl", "parec")
if not all(shutil.which(t) for t in TOOLS):
    print("SKIP tests/audio.py: needs " + ", ".join(TOOLS))
    sys.exit(0)

failures = []
def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))
    if not cond:
        failures.append(name)

SESSION = os.environ.get("TERMIUM_TEST_SESSION", "audio")
main = os.path.join(ROOT, "src", "main.ts")
tmp = tempfile.mkdtemp(prefix="taudio-")
procs = []

# ---- a private PipeWire with one null sink, and no devices (alsa, bluez... off)
art = os.path.join(tmp, "audio"); os.makedirs(os.path.join(art, "cfg", "wireplumber", "wireplumber.conf.d"))
os.chmod(art, 0o700)
with open(os.path.join(art, "cfg", "wireplumber", "wireplumber.conf.d", "90-test.conf"), "w") as f:
    f.write("wireplumber.profiles = { main = {\n" + "".join(f"  {k} = disabled\n" for k in (
        "monitor.alsa", "monitor.alsa-midi", "monitor.bluez", "monitor.bluez-midi", "monitor.v4l2", "monitor.libcamera",
        "support.dbus", "support.reserve-device", "support.portal-permissionstore", "monitor.bluez.seat-monitoring")) + "} }\n")
PULSE = f"unix:{art}/pulse/native"
AENV = dict(os.environ, XDG_RUNTIME_DIR=art, PIPEWIRE_RUNTIME_DIR=art, PULSE_RUNTIME_PATH=f"{art}/pulse", PULSE_SERVER=PULSE,
            XDG_CONFIG_HOME=f"{art}/cfg", XDG_STATE_HOME=f"{art}/state", DBUS_SESSION_BUS_ADDRESS="unix:path=/nonexistent")
AENV.pop("PIPEWIRE_REMOTE", None)
for prog in ("pipewire", "wireplumber", "pipewire-pulse"):
    procs.append(subprocess.Popen([prog], env=AENV, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
    time.sleep(1)
for _ in range(50):
    if subprocess.run(["pactl", "info"], env=AENV, capture_output=True).returncode == 0:
        break
    time.sleep(0.2)
subprocess.run(["pactl", "load-module", "module-null-sink", "sink_name=termiumtest"], env=AENV, capture_output=True)
subprocess.run(["pactl", "set-default-sink", "termiumtest"], env=AENV, capture_output=True)

def rms(secs=1.0):
    """Loudness of what reaches the sink, over `secs` (16-bit: a tone is thousands, silence 0)."""
    r = subprocess.run(["timeout", "-s", "INT", str(secs), "parec", "--latency-msec=20", "-d", "termiumtest.monitor",
                        "--format=s16le", "--channels=1", "--rate=8000", "--raw"], env=AENV, capture_output=True)
    a = array.array("h", r.stdout[: len(r.stdout) // 2 * 2])
    return math.sqrt(sum(x * x for x in a) / max(1, len(a)))

# ---- fixtures on two sites (127.0.0.1 and localhost: the iframe is cross-site, its own process)
with socket.socket() as so:
    so.bind(("127.0.0.1", 0)); PORT = so.getsockname()[1]
srv = subprocess.Popen([shutil.which("python3") or sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1",
                        "--directory", os.path.join(ROOT, "tests", "fixtures")], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
procs.append(srv)
time.sleep(0.5)
BASE = f"http://127.0.0.1:{PORT}/audio.html"
FRAME = f"{BASE}?mode=frame&src=" + f"http://localhost:{PORT}/audio.html%3Fmode%3Dmedia%26auto%3D1"

# Only this sink: no audio device, and no ALSA fallback either.
alsa = os.path.join(tmp, "asound.conf")
with open(alsa, "w") as f:
    f.write("pcm.!default { type null }\n")
ENV = {"PULSE_SERVER": PULSE, "ALSA_CONFIG_PATH": alsa, "DBUS_SESSION_BUS_ADDRESS": "unix:path=/nonexistent"}
t = Term(["bun", main, "-s", SESSION, "--profile", os.path.join(tmp, "profile"), f"{BASE}?mode=media"], cwd=ROOT, env=ENV)
CENV = dict(os.environ, PULSE_SERVER=PULSE, XDG_RUNTIME_DIR=t.runtime_dir, TERMIUM_NO_UPDATE_CHECK="1")

def ctl(*args):
    return subprocess.run(["bun", main, "ctl", "-s", SESSION, *args], cwd=ROOT, env=CENV, stdin=subprocess.DEVNULL,
                          capture_output=True, text=True, timeout=60)

def ctl_json(*args):
    r = ctl(*args, "--json")
    try:
        return json.loads(r.stdout)
    except ValueError:
        return {"_error": (r.returncode, r.stdout, r.stderr)}

def tab(id_):
    tabs = ctl_json("tabs")
    return next((x for x in tabs if isinstance(x, dict) and x.get("id") == id_), {}) if isinstance(tabs, list) else {}

def cell_of(row, ch):
    """1-based column of `ch` on a screen row (wide characters take two cells), or None."""
    with t.lock:
        line = t.screen.buffer[row - 1]
        for x in range(t.cols):
            if line[x].data == ch:
                return x + 1
    return None

def tabbar():
    return t.line(1)

def prefix(k):
    t.key("ctrl+b"); t.key(k)
    time.sleep(0.3)

try:
    check("termium starts", t.wait_for(lambda: "audio" in t.line(1), 40), t.text()[:400])
    ctl("open", f"{BASE}?mode=osc", "--new-tab")
    ctl("open", FRAME, "--new-tab")
    tabs = ctl_json("tabs")
    ids = {m: next(x["id"] for x in tabs if f"mode={m}" in x["url"]) for m in ("media", "osc", "frame")}
    check("nothing plays yet: no icon", "♪" not in tabbar() and "🔇" not in tabbar(), tabbar())

    def play(mode):
        ctl("eval", "start()", "--tab", str(ids[mode]))
        ok = t.wait_for(lambda: tab(ids[mode]).get("audible") is True, 15, 0.3)
        check(f"{mode}: ctl tabs says it plays", ok, json.dumps(tab(ids[mode])))
        check(f"{mode}: ♪ on its tab", t.wait_for(lambda: "♪" in tabbar(), 5), tabbar())
        check(f"{mode}: ♪ on its space in the sidebar", "♪" in t.line(3), t.line(3))
        q = rms()
        check(f"{mode}: sound reaches the sink", q > 1000, f"rms {q:.0f}")

    def silent(mode, how):
        check(f"{mode}: muted ({how}) per ctl tabs", t.wait_for(lambda: tab(ids[mode]).get("muted") is True, 5, 0.3), json.dumps(tab(ids[mode])))
        check(f"{mode}: 🔇 on its tab ({how})", t.wait_for(lambda: "🔇" in tabbar(), 5), tabbar())
        q = rms()
        check(f"{mode}: silent at the sink ({how})", q < 50, f"rms {q:.0f}")

    def loud(mode, how):
        check(f"{mode}: unmuted ({how}) per ctl tabs", t.wait_for(lambda: tab(ids[mode]).get("muted") is False, 5, 0.3), json.dumps(tab(ids[mode])))
        check(f"{mode}: back to ♪ ({how})", t.wait_for(lambda: "♪" in tabbar() and "🔇" not in tabbar(), 5), tabbar())
        q = rms()
        check(f"{mode}: sound again ({how})", q > 1000, f"rms {q:.0f}")

    def stop(mode):
        ctl("eval", "stop()", "--tab", str(ids[mode]))
        check(f"{mode}: icon clears once it stops", t.wait_for(lambda: "♪" not in tabbar() and "🔇" not in tabbar(), 15), tabbar())
        check(f"{mode}: ctl tabs: no longer playing", not tab(ids[mode]).get("audible"), json.dumps(tab(ids[mode])))
        check(f"{mode}: and the sidebar", "♪" not in t.line(3), t.line(3))

    # 1. <audio>, in a background tab (the frame tab is in front): click its icon.
    play("media")
    t.click_cell(cell_of(1, "♪"), 1)
    silent("media", "click")
    st = ctl_json("eval", "state()", "--tab", str(ids["media"])).get("value") or {}
    time.sleep(0.5)
    st2 = ctl_json("eval", "state()", "--tab", str(ids["media"])).get("value") or {}
    check("media: the page still plays, unaware (not paused, not el.muted, time runs)",
          st.get("paused") is False and st.get("muted") is False and (st2.get("time") or 0) > (st.get("time") or 0), f"{st} {st2}")
    check("media: clicking the icon didn't switch tabs", tab(ids["frame"]).get("active") is True, json.dumps(ctl_json("tabs")))
    # Survives switching to it and away.
    for n in ("1", "3"):
        prefix(n)
        check(f"media: still muted after switching to tab {n}", tab(ids["media"]).get("muted") is True and "🔇" in tabbar(), tabbar())
    q = rms()
    check("media: still silent after the switches", q < 50, f"rms {q:.0f}")
    t.click_cell(cell_of(1, "🔇"), 1)
    loud("media", "click")
    stop("media")

    # 2. Web Audio: ctl mute / unmute.
    play("osc")
    r = ctl("mute", str(ids["osc"]))
    check("osc: ctl mute answers", r.returncode == 0 and r.stdout.startswith(f"muted {ids['osc']}"), r.stdout + r.stderr)
    silent("osc", "ctl")
    st = ctl_json("eval", "state()", "--tab", str(ids["osc"])).get("value") or {}
    check("osc: the AudioContext still runs (the page can't tell)", st.get("ctx") == "running", str(st))
    ctl("select", str(ids["osc"]))
    ctl("select", str(ids["frame"]))
    check("osc: still muted after ctl select to it and away", tab(ids["osc"]).get("muted") is True, json.dumps(tab(ids["osc"])))
    r = ctl("unmute", str(ids["osc"]))
    check("osc: ctl unmute answers", r.returncode == 0, r.stdout + r.stderr)
    loud("osc", "ctl")
    stop("osc")

    # 3. A cross-site iframe playing (its own renderer): Ctrl+B m on its tab.
    play("frame")
    prefix("m")
    silent("frame", "Ctrl+B m")
    prefix("1")
    prefix("3")
    check("frame: still muted after switching away and back", tab(ids["frame"]).get("muted") is True, json.dumps(tab(ids["frame"])))
    prefix("m")
    loud("frame", "Ctrl+B m")
    stop("frame")

    r = ctl("mute", "99")
    check("ctl mute of no such tab fails", r.returncode == 1 and "no tab 99" in r.stderr, r.stderr)
    check("terminal still attached", t.alive and "audio" in t.line(1), t.text()[:300])
finally:
    try:
        t.close()
    finally:
        for p in reversed(procs):
            p.send_signal(signal.SIGTERM)
        for p in procs:
            try:
                p.wait(5)
            except subprocess.TimeoutExpired:
                p.kill()
        shutil.rmtree(tmp, ignore_errors=True)

print(f"\n{len(failures)} failure(s)" + (": " + ", ".join(failures) if failures else ""))
sys.exit(1 if failures else 0)
