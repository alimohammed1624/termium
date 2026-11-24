# Changelog

All notable changes to termium are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
