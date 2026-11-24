// Test helper: another DevTools client on a session's endpoint (as an
// agent's Puppeteer or Playwright would be), speaking raw CDP.
// Usage:
//   bun tests/support/cdp-ext.ts create <browserURL> <url>          prints the new target's id
//   bun tests/support/cdp-ext.ts create-isolated <browserURL> <url> <seconds>   in a new browser context, kept that long
//   bun tests/support/cdp-ext.ts close <browserURL> <targetId>
//   bun tests/support/cdp-ext.ts viewport <browserURL> <url-part> <w> <h> <seconds>
//       sets the page's viewport from this client, prints what the page reports,
//       stays connected for <seconds>, then disconnects (its override goes with it)
import { CDP } from "../../src/cdp";

const [cmd, browserURL, ...rest] = process.argv.slice(2);
const version = await (await fetch(`${browserURL}/json/version`)).json();
const cdp = await CDP.connect(version.webSocketDebuggerUrl);
if (cmd === "create") {
  const { targetId } = await cdp.send("Target.createTarget", { url: rest[0] });
  console.log(targetId);
} else if (cmd === "create-isolated") {
  // A tab in a new browser context (Playwright's newContext()), kept for <seconds> while connected.
  const [url, secs] = rest;
  const { browserContextId } = await cdp.send("Target.createBrowserContext", {});
  const { targetId } = await cdp.send("Target.createTarget", { url, browserContextId });
  console.log(targetId);
  await Bun.sleep(Number(secs) * 1000);
} else if (cmd === "close") {
  await cdp.send("Target.closeTarget", { targetId: rest[0] });
  console.log("closed");
} else if (cmd === "viewport") {
  const [part, w, h, secs] = rest;
  const { targetInfos } = await cdp.send("Target.getTargets");
  const t = targetInfos.find((t: any) => t.type === "page" && t.url.includes(part));
  if (!t) throw new Error(`no page with ${part}`);
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: Number(w), height: Number(h), deviceScaleFactor: 1, mobile: false }, sessionId);
  const r = await cdp.send("Runtime.evaluate", { expression: "[innerWidth, innerHeight]", returnByValue: true }, sessionId);
  console.log(JSON.stringify(r.result.value));
  await Bun.sleep(Number(secs) * 1000);
} else {
  throw new Error(`unknown command ${cmd}`);
}
cdp.close();
process.exit(0);
