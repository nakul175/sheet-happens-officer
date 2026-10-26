import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

const production = "ee59582dffcbd8cc3067e689b2bb73cf63781cb7";
const allowed = new Set([
  "docs/team-intake-workspace-assignment.md",
  "src/app/(app)/projects/[id]/ProjectView.tsx",
  "src/app/api/projects/[id]/assignment-people/route.ts",
  "src/app/api/tasks/[id]/assign/route.ts",
  "src/app/api/tasks/[id]/collaborators/route.ts",
  "src/components/TaskModal.tsx",
  "src/components/WorkspaceTaskPerson.tsx",
  "src/lib/project-task-membership.ts",
  "src/lib/deals.ts",
  "src/lib/schemas.ts",
  "src/lib/tasks.ts",
  "tests/workspace-task-membership.test.ts",
  "tests/workspace-task-person-ui.test.tsx",
  "tests/usage-month.test.tsx",
  "tests/usage-month-figure-2951.test.ts",
  "tests/no-proc-environ-2917.test.ts",
  "vitest.sho-3038.config.mts",
  "scripts/acceptance/sho-3038-scope.test.mjs",
  ".github/workflows/scoped4-validation.yml",
]);

test("sequential release changes only explicitly reviewed surfaces", () => {
  const changed = execFileSync("git", ["diff", "--name-only", production, "--"], { encoding: "utf8" })
    .trim().split("\n").filter(Boolean);
  assert.ok(changed.length);
  for (const file of changed) assert.ok(allowed.has(file), file);
});

test("SHO-3038 does not change schema, migrations, server entry, or central auth", () => {
  for (const path of ["prisma", "package.json", "package-lock.json", "server.js", "src/app/api/auth", "src/app/api/suite"])
    assert.equal(execFileSync("git", ["diff", production, "--", path], { encoding: "utf8" }), "", path);
});
