---
name: termium
description: Drive a termium browser session (headless Chromium shown live in a person's terminal) from the shell - open pages, read an accessibility snapshot, click, type, wait, screenshot, eval - or attach Puppeteer, Playwright or chrome-devtools-mcp to it. Use when asked to browse, test or check a web page with termium, or to use a browser while a person watches it in their terminal (tmux, herdr).
---

# termium for agents

termium runs a Chromium browser in a background **session**; a person's
terminal can attach to it and show the pages. You drive a session from the
shell without a terminal and without taking over the person's screen:
everything you do shows in their terminal as it happens (your actions are
also named in termium's status line as `agent: ...`).

Never run plain `termium`, `termium URL` or `termium attach` yourself: they
need an interactive terminal and take it over.

## Sessions

```sh
termium ls                          # running sessions; "attached" = a person is watching
termium start -s agent [URL]        # start a session with no terminal (returns once it's up)
termium kill agent                  # end a session you started
```

- `-s NAME` picks the session for every command (default: `default`, the
  person's usual one). Each session has its own browser profile.
- `termium start` is safe to repeat: on a running session it says
  `already running` and exits 0 (a URL opens in a new tab).
- The person can watch your session with `termium attach agent` in a
  pane of their own.

## Driving a page: snapshot, act by id, wait, verify

```sh
termium ctl -s agent open https://example.com/login --new-tab   # waits for the load
termium ctl -s agent snapshot              # accessibility tree, ids like [3:142]
termium ctl -s agent type 3:57 "ada@example.com"
termium ctl -s agent type 3:58 "hunter2" --submit                # Enter after
termium ctl -s agent wait text "Welcome"   # or: wait selector CSS | wait url PART | wait load
termium ctl -s agent text                  # read the result
termium ctl -s agent snapshot              # ids for the new page
```

Snapshot lines look like `- button "Sign in" [3:58] disabled`. An id is
`TAB:NODE`: it names its tab, so `click 3:58` acts on tab 3 whichever tab
is focused. Ids stay valid while the element exists; after a navigation or
a big change, take a new snapshot (a stale id fails with exit 1).

| Command | Does |
| --- | --- |
| `tabs [--json]` | list tabs: id, title, url, space, tab, pane; `*` = focused |
| `open URL [--new-tab] [--background] [--no-wait]` | navigate the focused tab (or `--tab N`), or open a new tab; waits for the load |
| `select TAB` / `close [TAB] [--force]` | show and focus a tab / close it |
| `snapshot [TAB]` | accessibility tree as text, with element ids |
| `text [TAB]` | the page's readable text |
| `click ID` / `click --xy X,Y` | click an element (or a point in CSS pixels); `--double`, `--right` |
| `type ID TEXT [--append] [--submit]` | replace a field's text; on a `<select>`, choose that option |
| `key KEY...` | press keys: `Enter`, `Tab`, `Escape`, `ctrl+a`, `shift+Tab`, `ArrowDown`, `a` |
| `scroll [ID] up\|down\|left\|right [PX]` | scroll the page (or the area under an element) |
| `shot [TAB] [-o FILE] [--full]` | save a PNG; prints its path (default: a temp file) |
| `eval JS [TAB]` | run JavaScript in the page (promises awaited); prints JSON |
| `wait load\|selector CSS\|text TEXT\|url PART [--gone]` | wait until it's there (or gone) |
| `dialog accept\|dismiss [TEXT]` | answer an alert/confirm/prompt/"Leave page?" |

Options: `--tab N` (`-t N`) for commands that act on a tab, `--json` for
machine-readable output, `--timeout SEC` (default 30). Exit status: 0 done,
1 failed (stale id, no such tab, page error, dialog in the way), 2 usage,
3 no such session, 4 timed out. Errors go to stderr in one line.

## The DevTools endpoint (Puppeteer, Playwright, chrome-devtools-mcp)

Every session's browser also listens for DevTools clients on loopback:

```sh
termium devtools -s agent            # http://127.0.0.1:PORT
termium devtools -s agent --json     # {name, pid, browserURL, webSocketDebuggerUrl}
```

Use it instead of ctl when you need network or console access, request
interception, file uploads, performance traces, or an existing script.

- chrome-devtools-mcp: `npx chrome-devtools-mcp@latest --browser-url=http://127.0.0.1:PORT`
  (for Claude Code: `claude mcp add termium -- npx chrome-devtools-mcp@latest --browser-url=http://127.0.0.1:PORT`)
- Playwright: `const browser = await chromium.connectOverCDP("http://127.0.0.1:PORT");`
  then `const page = await browser.contexts()[0].newPage();`
- Puppeteer: `const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:PORT", defaultViewport: null });`
  and finish with `await browser.disconnect()`. Never `browser.close()`:
  it quits the session's browser.

Pages you create appear as tabs in termium (focused, so the person sees
them); pages you close disappear. termium sizes pages to the person's
panes: leave the viewport alone (`defaultViewport: null`). An override you
set (`setViewport`, Puppeteer's default 800x600) holds while you're
connected, shown stretched in termium, and is undone when you disconnect.
The port changes each time the session starts: ask `termium devtools`.

## With a person watching

- Prefer your own session (`termium start -s agent`) or your own tab
  (`open --new-tab`). Don't navigate, close or type into tabs you didn't
  open unless asked; `tabs` shows which one the person has focused (`*`).
- Say what you're about to do before anything destructive or hard to undo
  (submitting, buying, deleting, sending, logging out), and ask first.
- The default session holds the person's logins: act as them only as asked.
- Don't `kill` a session you didn't start, and don't call `Browser.close`.

## Limits

- Snapshots include same-site iframes, not cross-site ones (separate
  processes), nor canvas content: use `shot` and `click --xy`, or the
  DevTools endpoint.
- `--xy` takes CSS pixels of the page's viewport (`eval "[innerWidth,
  innerHeight]"`); a `shot` is in device pixels (`devicePixelRatio` times).
- A page showing a JavaScript dialog blocks other commands on it until
  `dialog accept` or `dismiss`.
- No file uploads or downloads in ctl (downloads land in the person's
  download directory); use the DevTools endpoint for uploads.
- Pages opened while no terminal is attached (after `termium start`, say)
  are 1280x800. A page that was shown in a terminal keeps that pane's size
  and pixel ratio after the terminal detaches (on a HiDPI terminal, a
  small viewport at 2x, say): check `eval "[innerWidth, innerHeight,
  devicePixelRatio]"` rather than assuming. When a person attaches, pages
  take their pane sizes.
- While the person at the terminal is editing the address, answering a
  prompt or reading help, `select` waits until they're done (it never
  throws their edit away); every command also takes `--tab N` to act on a
  tab without showing it.
- In a session's first seconds, Helium's content blocker may abort a
  DevTools client's first navigation (`net::ERR_ABORTED`): retry it
  (`termium ctl open` retries by itself).
- The endpoint has no authentication: while the session runs, any program
  on this machine can connect to it.
