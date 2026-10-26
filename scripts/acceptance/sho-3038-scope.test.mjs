import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

const production = "ee59582dffcbd8cc3067e689b2bb73cf63781cb7";
const allowed = new Set([
  "docs/team-intake-workspace-assignment.md",
  "docs/team-intake-bid-stages.md",
  "prisma/schema.prisma",
  "prisma/migrations/20261024101000_deal_classification_revenue/migration.sql",
  "prisma/migrations/20261024110000_stage_delivery_category/migration.sql",
  "prisma/migrations/20261024110100_bid_stage_mapping/migration.sql",
  "src/app/(app)/projects/[id]/ProjectView.tsx",
  "src/app/(app)/deals/new/NewDeal.tsx",
  "src/app/(app)/deals/DealsView.tsx",
  "src/app/(app)/review/ReviewView.tsx",
  "src/app/api/review/route.ts",
  "src/app/api/deals/route.ts",
  "src/app/api/projects/[id]/assignment-people/route.ts",
  "src/app/api/tasks/[id]/assign/route.ts",
  "src/app/api/tasks/[id]/collaborators/route.ts",
  "src/components/TaskModal.tsx",
  "src/components/ConvertDialog.tsx",
  "src/components/DealPanel.tsx",
  "src/components/DealBoard.tsx",
  "src/components/extras/QuickAdd.tsx",
  "src/components/WorkspaceTaskPerson.tsx",
  "src/lib/project-task-membership.ts",
  "src/lib/deal-classification.ts",
  "src/lib/deals.ts",
  "src/lib/review.ts",
  "src/lib/schemas.ts",
  "src/lib/tasks.ts",
  "src/lib/undo.ts",
  "tests/workspace-task-membership.test.ts",
  "tests/helpers.ts",
  "tests/e2e/stories/APL-2466.spec.ts",
  "tests/e2e/stories/APL-2482.spec.ts",
  "tests/e2e/stories/APL-2590.spec.ts",
  "tests/e2e/stories/SHO-3040.spec.ts",
  "tests/workspace-task-person-ui.test.tsx",
  "tests/deal-classification-intake.test.ts",
  "tests/deal-classification-ui.test.tsx",
  "tests/sho-3042-opportunity-reporting.test.tsx",
  "tests/bid-stage-lifecycle.test.ts",
  "tests/bid-stage-migration-intake.test.ts",
  "tests/deal-lifecycle-route.test.ts",
  "tests/deal-lifecycle-ui.test.tsx",
  "tests/review-commercial-counts.test.tsx",
  "tests/usage-month.test.tsx",
  "tests/usage-month-figure-2951.test.ts",
  "tests/no-proc-environ-2917.test.ts",
  "vitest.sho-3038.config.mts",
  "vitest.sho-3044.config.mts",
  "vitest.sho-3042.config.mts",
  "vitest.sho-3041.config.mts",
  "scripts/acceptance/sho-3038-scope.test.mjs",
  ".github/workflows/scoped4-validation.yml",
]);

test("sequential release changes only explicitly reviewed surfaces", () => {
  const changed = execFileSync("git", ["diff", "--name-only", production, "--"], { encoding: "utf8" })
    .trim().split("\n").filter(Boolean);
  assert.ok(changed.length);
  for (const file of changed) assert.ok(allowed.has(file), file);
});

test("sequential release does not change package/runtime entry or central auth", () => {
  for (const path of ["package.json", "package-lock.json", "server.js", "src/app/api/auth", "src/app/api/suite"])
    assert.equal(execFileSync("git", ["diff", production, "--", path], { encoding: "utf8" }), "", path);
});
