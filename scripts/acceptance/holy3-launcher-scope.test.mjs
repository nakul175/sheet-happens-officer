import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

const base = "1135b8ef8d4924b73bfb387d4e7d2305025934c4";
const allowed = new Set([
  "src/components/TaskModal.tsx", "src/components/HolySheetLauncher.tsx",
  "src/lib/holy-sheet-url.ts", "src/app/api/tasks/[id]/holy-sheet/route.ts",
]);
test("launcher changes stay scoped to the canonical central-login release", () => {
  execFileSync("git", ["merge-base", "--is-ancestor", base, "HEAD"]);
  const files = execFileSync("git", ["diff", "--name-only", base, "--", "src"], {encoding: "utf8"}).trim().split("\n").filter(Boolean);
  assert.ok(files.length > 0);
  for (const file of files) assert.ok(allowed.has(file), `Unexpected runtime delta: ${file}`);
  for (const path of ["prisma", "src/lib/auth.ts", "src/lib/central-client.ts", "src/lib/central-status.ts", "src/lib/attach-central-session.ts", "src/lib/shutdown.ts", "src/lib/sho-accept.so", "server.js"]) {
    assert.equal(execFileSync("git", ["diff", base, "--", path], {encoding: "utf8"}), "", `Preserve canonical ${path}`);
  }
});
