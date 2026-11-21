# Changelog

All notable changes to termium are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - TBD

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
- Persistent profile or `--incognito`; leftover browsers from a killed
  termium are stopped on the next start.
