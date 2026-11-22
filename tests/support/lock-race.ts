// Test helper: tries to take termium's profile lock; prints "won" or "lost".
// Usage: bun tests/support/lock-race.ts <profile-dir> <start-at-ms>
import { lockProfile } from "../../src/browser";
const [profile, startAt] = process.argv.slice(2);
while (Date.now() < Number(startAt)) {} // start together
try {
  lockProfile(profile!);
  console.log("won");
  await Bun.sleep(3000); // hold it while the others try
} catch {
  console.log("lost");
}
process.exit(0);
