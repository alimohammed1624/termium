// Stands in for ssh in tests/tunnel.test.ts: takes ssh's -D 127.0.0.1:PORT
// and listens there (no proxying). Destination "denied" fails as a refused
// login; with FAKE_SSH_EXIT_MS it exits on its own after that long (a drop).
// FAKE_SSH_PIDFILE: where to write its pid.
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";

const argv = process.argv.slice(2);
const d = argv[argv.indexOf("-D") + 1]!;
const dest = argv[argv.length - 1]!;
if (dest === "denied") {
  console.error("me@denied: Permission denied (publickey).");
  process.exit(255);
}
if (process.env.FAKE_SSH_PIDFILE) writeFileSync(process.env.FAKE_SSH_PIDFILE, String(process.pid));
const port = Number(d.split(":").pop());
const srv = createServer((s) => s.end());
srv.listen(port, "127.0.0.1");
const ms = Number(process.env.FAKE_SSH_EXIT_MS);
if (ms > 0) setTimeout(() => process.exit(255), ms);
