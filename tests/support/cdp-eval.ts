// Test helper: evaluate an expression in every page of a running termium's
// browser and print JSON. termium talks to its browser over a pipe; tests
// start it with TERMIUM_TEST_DEVTOOLS_PORT=1 so the browser also opens a
// DevTools port (found through the profile's DevToolsActivePort).
// Usage: bun tests/support/cdp-eval.ts <profile-dir> <expression>
import { readFileSync } from "node:fs";
const [profile, expr] = process.argv.slice(2);
const [port] = readFileSync(`${profile}/DevToolsActivePort`, "utf8").split("\n");
const targets: any[] = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const results: any[] = [];
for (const t of targets.filter((t) => t.type === "page")) {
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
  if (value !== undefined) results.push({ url: t.url, title: t.title, value });
}
console.log(JSON.stringify(results));
process.exit(0);
