import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const baseline = "fffd4ed47f4bfb0f6a249f33f211a911afece1e8";
const allowed = new Set([
  "src/app/(app)/app.css", "src/app/(app)/team/Team.tsx", "src/app/(app)/usage/screen.tsx",
  "src/app/api/deals/pipelines/[id]/route.ts", "src/lib/deals.ts", "src/lib/team.ts",
  "src/lib/usage-percent.ts", "src/lib/usage.ts",
  "src/lib/concierge/engine.ts", "src/lib/concierge/tools.ts", "src/lib/concierge/claims.ts", "src/lib/model.ts", "src/lib/concierge/limits.ts", "src/lib/concierge/echo.ts",
]);
test("accepted15 contains only the reviewed runtime delta", () => {
  const changed = execFileSync("git", ["diff", "--name-only", baseline, "--", "src"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  assert.ok(changed.length > 0);
  for (const file of changed) assert.ok(allowed.has(file), `Unapproved runtime delta: ${file}`);
  assert.equal(execFileSync("git", ["diff", baseline, "--", "prisma"], { encoding: "utf8" }), "", "No schema migration belongs to accepted15");
});
test("central login and accepted shutdown runtime are preserved", () => {
  for (const file of ["src/lib/auth.ts", "src/lib/central-client.ts", "src/lib/central-status.ts", "src/app/signin/page.tsx", "src/app/signin/SignInForm.tsx", "src/lib/shutdown.ts", "src/lib/sho-accept.so", "server.js"]) {
    assert.deepEqual(readFileSync(file), execFileSync("git", ["show", `${baseline}:${file}`]), file);
  }
});
test("SHO-3024: a return-path log setting is either implemented or absent", () => {
  const scripts = JSON.stringify(JSON.parse(readFileSync("package.json", "utf8")).scripts);
  const proxy = existsSync("src/proxy.ts") ? readFileSync("src/proxy.ts", "utf8") : "";
  if (scripts.includes("RETURN_PATH_LOG")) {
    assert.match(proxy, /process\.env\.RETURN_PATH_LOG\s*===\s*["']1["']/);
    assert.match(proxy, /console\.info/);
  } else {
    assert.ok(!proxy.includes("RETURN_PATH_LOG"), "Do not carry an unadvertised dead logging reference");
  }
});
