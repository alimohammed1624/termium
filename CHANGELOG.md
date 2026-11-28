# Changelog

All notable changes to termium are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- `termium open [URL] --split right|down` opens the session in a real
  split of the terminal termium runs in, next to the current pane: tmux,
  herdr, and kitty (with remote control). Agents get the same with
  `termium ctl split right|down [URL]`, which keeps the focus where it
  was. Elsewhere (Ghostty, WezTerm) it says why and suggests termium's
  own splits.

## [0.3.0] - 2026-11-25

### Added
- Agent control: `termium ctl` drives a session from a script or coding
  agent without a terminal and without attaching (the attached terminal
  keeps its screen and keyboard and shows every action live): `tabs`,
  `open`, `select`, `close`, `snapshot` (accessibility tree with stable
  `TAB:NODE@DOC` element ids), `text`, `click`, `type`, `key`, `scroll`,
  `shot`, `eval`, `wait`, `dialog`; `--json` output, exit status
  0/1/2/3/4/5 (done, failed, usage, no session, timeout, partly done).
- `termium start [-s NAME] [URL]` starts a session in the background with
  no terminal (pages opened then are 1280x800; a terminal that attaches
  sizes them, and they keep that size when it detaches).
- Every session's browser has a DevTools endpoint on `127.0.0.1` (any free
  port); `termium devtools [NAME] [--json]` prints it, for Puppeteer,
  Playwright `connectOverCDP` and chrome-devtools-mcp. Tabs they open or
  close show in termium; a viewport they hold is shown stretched (with the
  mouse mapped to match) and termium's comes back when they disconnect.
  This replaces the tests' `TERMIUM_TEST_DEVTOOLS_PORT`.
- `termium --skill` prints a SKILL.md that teaches an agent to use all of
  the above.
- Update check: when a terminal attaches, the session asks GitHub for
  termium's latest release in the background (never delaying anything;
  silent when offline; one 3 s deadline; stopped on detach) and caches the
  answer in `~/.local/state/termium/update-check.json`. A newer release
  shows `↑ vX.Y.Z` in the tab bar and the upgrade command in `Ctrl+B ?`,
  and is offered once as a notice in the address line that never takes
  the keyboard (typing and pasting always reach the page): `Ctrl+B U`, or
  a click on the notice or badge, opens a box with `u` update now, `l`
  later, `s` skip this version. The session owns the check, so attaching
  and detaching don't repeat it, and a detached session never checks.
- Self-update: `u`, or `termium update` from a shell, downloads the
  release archive for this platform, verifies it against `SHA256SUMS` and
  replaces the binary in place (never for a run from source, nor when its
  folder isn't writable; on any failure, the `install.sh` command to
  update by hand). Only a native executable for this machine is accepted.
  Concurrent updates take turns under a lock and never replace a newer
  binary with an older one; the update cache is changed under a lock too
  (best effort: never waited for long).
- Restart into an update: a running session keeps the old version until
  it restarts; `r` restarts it from the new binary in the same terminal,
  reopening its spaces, tabs and splits (kept for the next start, with
  the launch options it had, unless every page reopened) from the binary
  the update replaced. It asks first if a page may have unsaved changes. After
  `termium update` from a shell, the next attach offers the same. Attaching to a session of termium 0.2.0 says it runs
  the older version and offers to restart it (its pages close).
- `termium check-update` prints one line (exit 0 up to date, 100 newer
  release available, 1 could not check, 2 bad usage); `termium update`
  exits 0 updated or up to date, 1 failed, 2 bad usage.
- `--no-update-check`, `TERMIUM_NO_UPDATE_CHECK=1` or a set `CI`
  variable turn the check and all update news off for that terminal.
- `termium ls` says which termium a session runs when it isn't this one.

### Changed
- A terminal that attaches or takes over a session starts typing into the
  page: the address bar, help or a yes/no question left open by the
  previous terminal is closed.
- Attaching to a session of a termium that speaks another session
  protocol says how to end it (`termium kill NAME`).

### Fixed
- `--browser ./path` is made absolute when the session starts, so a
  restart from another directory finds it.
- After re-attaching at another size, the first picture of a page could
  be one of the old shape (the browser's first frame after a resize can
  carry the new size in its metadata but the old picture). Right after a
  resize, until a frame of the new shape comes (2 s at most), frames of
  another shape are dropped.

## [0.2.0] - 2026-11-24

### Added
- Detachable sessions, like tmux: the browser, its pages and all of
  termium's spaces, tabs and splits live in a background session server;
  `termium` attaches the terminal to it (starting it if needed).
  `Ctrl+B d` detaches, and attaching again from any terminal redraws
  everything at that terminal's size. `termium attach [name]`,
  `termium ls`, `termium kill [name]` and `-s/--session NAME` for several
  sessions; each named session has its own profile
  (`~/.local/share/termium/profiles/NAME`), so several run at once. A
  second attach takes the session over and tells the first
  terminal. Closing or killing the terminal only detaches; if the session
  dies, the attached terminal gets its screen back with a message.
  Sessions listen on a private Unix socket in `$XDG_RUNTIME_DIR/termium`;
  sockets left by a killed session are cleaned up.
- tmux support: pictures go through tmux's passthrough as unicode
  placeholders (so they stay in their pane through splits, zoom and
  redraws), as temporary files when the terminal is on the same machine.
  A clear message if `allow-passthrough` is off.
- Works inside herdr panes (`Ctrl+B Ctrl+B d` detaches termium there and
  in tmux).

### Changed
- Launch options (`--profile`, `--incognito`, `--browser`, `--scale`,
  `--search`) apply when a session starts; given to a running session
  they're an error.

### Fixed
- No more flicker: redraws (switching tabs, splitting, toggling the
  sidebar, resizing) are synchronized updates (DECSET 2026), and a page's
  old picture is deleted only after its new one is placed.
- A pane no longer stops updating when the page's screen capture fails to
  start (for example right after a page is replaced); the start is retried.
- A page that hangs is now always replaced on the next navigation; the
  hang watchdog could skip one whose loading had already finished.
- After an incognito termium is killed, the next start now reliably
  removes its profile: it stops the dead browser's helper processes first,
  so they can't write files back into it.

## [0.1.0] - 2026-11-22

Initial release.

### Added
- A Chromium browser in the terminal: drives your installed Helium
  (Chromium) headless over the DevTools protocol and draws each pane's
  screencast with the kitty graphics protocol (Ghostty, kitty, WezTerm).
- Spaces (like browser windows) in a sidebar, tabs per space, and split
  panes per tab, each a live page, with herdr-style Ctrl+B prefix keys and
  full mouse support (tabs, spaces, buttons, pane titles, divider dragging).
- Address bar with search, back/forward/reload, and keyboard shortcuts that
  keep working while it is open.
- Pixel-precise mouse and kitty-protocol keyboard input, bracketed paste,
  Ctrl+C copy to the system clipboard (OSC 52), page zoom.
- JavaScript alert/confirm/prompt/beforeunload dialogs, popups and
  `target=_blank` links as tabs, downloads to the XDG download directory,
  file uploads, and in-page menus for `<select>` (headless Chromium never
  paints native ones).
- Presents as regular Chrome (no "HeadlessChrome" or `navigator.webdriver`),
  so sites don't serve bot checks.
- Persistent profile or `--incognito`; leftover browsers and incognito
  profiles from a killed termium are cleaned up on the next start, and a
  second termium on a profile in use refuses without disturbing the first.
- DevTools over a private pipe rather than a TCP port.
- Closing a pane runs the page's beforeunload check (closing a tab or space
  keeps everything if you stay); downloads never replace existing files,
  even from two termiums at once; paste fires the page's paste event
  without exposing the clipboard to other sites.
- Crashed or hung pages are replaced on the next reload or navigation.
- Sharp rendering on HiDPI terminals (full device resolution).
- Browser shortcuts that would act on the hidden browser are not passed on.
- Ctrl+Q asks first if a page may have unsaved changes (again to force).
- termium takes its own profile lock, so two termiums started at the same
  instant can't both run on one profile.
- Nothing is copied out of password fields.
