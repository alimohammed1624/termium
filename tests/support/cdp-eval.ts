// Test helper: evaluate an expression in every page of a running termium's
// browser and print JSON, through the browser's DevTools port (every
// session has one, on loopback; found through the profile's DevToolsActivePort).
// Usage: bun tests/support/cdp-eval.ts <profile-dir> <expression>
import { readFileSync } from "node:fs";
const [profile, expr] = process.argv.slice(2);
const [port] = readFileSync(`${profile}/DevToolsActivePort`, "utf8").split("\n");
const targets: any[] = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
// All pages at once: a page that never answers (hung, crashed, paused) costs
// its 5 s once, not 5 s in turn per page (several could outlast a caller's timeout).
const results: any[] = await Promise.all(
  targets.filter((t) => t.type === "page").map(async (t) => {
    const value = await new Promise((resolve) => {
      // A page can vanish (or be paused) between listing and connecting; don't hang on it.
      const timer = setTimeout(() => resolve(undefined), 5000);
      const ws = new WebSocket(t.webSocketDebuggerUrl);
      ws.addEventListener("error", () => { clearTimeout(timer); resolve(undefined); });
      ws.addEventListener("open", () =>
        ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true } })));
      ws.addEventListener("message", (ev) => {
        const m = JSON.parse(String(ev.data));
        if (m.id === 1) { clearTimeout(timer); ws.close(); resolve(m.result?.result?.value ?? null); }
      });
    });
    // A page that didn't answer (busy, or showing a dialog) is listed with a null value.
    return { url: t.url, title: t.title, value: value === undefined ? null : value, answered: value !== undefined };
  }),
);
console.log(JSON.stringify(results));
process.exit(0);
