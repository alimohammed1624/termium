// Test helper: evaluate an expression in every page of a running termium's
// browser (found through the profile's DevToolsActivePort) and print JSON.
// Usage: bun tests/support/cdp-eval.ts <profile-dir> <expression>
import { readFileSync } from "node:fs";
const [profile, expr] = process.argv.slice(2);
const [port] = readFileSync(`${profile}/DevToolsActivePort`, "utf8").split("\n");
const targets: any[] = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const results: any[] = [];
for (const t of targets.filter((t) => t.type === "page")) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  const value = await new Promise((resolve) => {
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id === 1) resolve(m.result?.result?.value ?? null);
    });
    ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true } }));
  });
  ws.close();
  results.push({ url: t.url, title: t.title, value });
}
console.log(JSON.stringify(results));
process.exit(0);
