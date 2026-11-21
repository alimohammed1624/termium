// Finds and launches a headless Helium (or any Chromium) process and returns
// its DevTools WebSocket URL.

import { appendFileSync, closeSync, existsSync, openSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";

const CANDIDATES = [
  "helium-browser",
  "helium",
  "/opt/helium-browser-bin/helium",
  "/opt/helium/helium",
  "/usr/lib/helium/helium",
  "/Applications/Helium.app/Contents/MacOS/Helium",
];

export function findBrowser(explicit?: string): string {
  const list = [explicit, process.env.TERMIUM_BROWSER, ...CANDIDATES].filter(
    (c): c is string => !!c,
  );
  for (const c of list) {
    if (c.includes("/")) {
      if (existsSync(c)) return c;
    } else {
      const found = Bun.which(c);
      if (found) return found;
    }
  }
  throw new Error(
    "Could not find Helium. Install it, or pass --browser <path> (or set TERMIUM_BROWSER).",
  );
}

export interface LaunchedBrowser {
  proc: Subprocess<"ignore", "ignore", number>;
  wsUrl: string;
}

/**
 * Starts the browser headless and waits for its DevTools endpoint. The
 * browser's own output goes straight to `logPath`: piping it through our
 * event loop could fill the pipe and freeze the browser while we're busy
 * writing frames to the terminal.
 */
export async function launchBrowser(
  bin: string,
  profileDir: string,
  logPath: string,
  timeoutMs = 30_000,
): Promise<LaunchedBrowser> {
  const args = [
    bin,
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-session-crashed-bubble",
    "about:blank",
  ];
  const portFile = join(profileDir, "DevToolsActivePort");
  rmSync(portFile, { force: true });
  appendFileSync(logPath, `\n--- ${new Date().toISOString()} ${args.join(" ")}\n`);
  const logFd = openSync(logPath, "a");
  const proc = Bun.spawn(args, { stdin: "ignore", stdout: "ignore", stderr: logFd });
  closeSync(logFd);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      const tail = readTail(logPath);
      const hint = /ProcessSingleton|profile.*in use|SingletonLock/i.test(tail)
        ? " The profile seems to be in use by another termium; pass --profile <dir> or --incognito."
        : "";
      throw new Error(`Browser exited with code ${proc.exitCode} before it was ready.${hint}\n${tail}`);
    }
    if (existsSync(portFile)) {
      const [port, path] = readFileSync(portFile, "utf8").split("\n");
      if (port && path) return { proc, wsUrl: `ws://127.0.0.1:${port.trim()}${path.trim()}` };
    }
    await Bun.sleep(25);
  }
  proc.kill(9);
  throw new Error(`Browser did not start within ${timeoutMs / 1000}s. See ${logPath}`);
}

function readTail(path: string): string {
  try {
    return readFileSync(path, "utf8").trim().slice(-1500);
  } catch {
    return "";
  }
}
