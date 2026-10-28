import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
const production = "b0f09e78638dae4575a3095aa69181d834dcf1fa";
const allowed = new Set([
  "src/app/(app)/Shell.tsx", "src/app/(app)/layout.tsx", "src/app/(app)/workload/WorkloadView.tsx", "src/app/(app)/workload/page.tsx", "src/app/(app)/workload/workload.css",
  "src/app/api/workload/route.ts", "src/lib/workload.ts", "tests/viewport/screens.ts", "tests/workload-unit.test.ts", "tests/workload.test.ts", "docs/runbooks/workload-release.md",
  "scripts/acceptance/sho2589-scope.test.mjs", "scripts/acceptance/sho-3038-scope.test.mjs", "scripts/acceptance/sho3062-scope.test.mjs", ".github/workflows/approved-projects-ui.yml", ".github/workflows/sho3062-validation.yml", ".github/workflows/phone-checks.yml",
]);
test("SHO-2589 extends exact live production with only the workload story and its validation", () => {
  execFileSync("git", ["merge-base", "--is-ancestor", production, "HEAD"]);
  const changed = execFileSync("git", ["diff", "--name-only", production, "--"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  for (const file of changed) assert.ok(allowed.has(file), file);
  for (const path of ["prisma", "package.json", "package-lock.json", "src/lib/auth.ts", "src/app/api/auth", "src/app/api/suite", "src/lib/suite-oauth.ts", "src/lib/shutdown.ts", "server.js", "deploy", ".github/workflows/scoped4-validation.yml", ".github/workflows/accepted15-validation.yml"])
    assert.equal(execFileSync("git", ["diff", production, "--", path], { encoding: "utf8" }), "", `Preserve ${path}`);
});
