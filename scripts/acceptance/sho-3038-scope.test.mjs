import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";

const production = "ee59582dffcbd8cc3067e689b2bb73cf63781cb7";
const allowed = new Set([
  ".env.example",
  "src/app/api/qa/mail/route.ts",
  "src/app/api/qa/accounts/route.ts",
  "src/app/api/auth/signin/route.ts",
  "src/lib/email.ts",
  "src/lib/mail-sink.ts",
  "tests/e2e/stories/APL-2681.spec.ts",
  "tests/e2e/stories/APL-2682.spec.ts",
  "tests/e2e/stories/APL-2465.spec.ts",
  "tests/mail-sink-client.ts",
  "tests/mail-sink.test.ts",
  "tests/qa-account-provisioning.test.ts",
  "tests/staging-editor.test.ts",
  "vitest.sho-2681.config.mts",
  "vitest.sho-2682.config.mts",
  "vitest.sho-2703.config.mts",
  "docs/team-intake-workspace-assignment.md",
  "docs/team-intake-bid-stages.md",
  "docs/project-trash-3047.md",
  "docs/vertical-boards-3048.md",
  "prisma/migrations/20261026110000_project_vertical_boards/migration.sql",
  "src/app/(app)/projects/new/NewProject.tsx",
  "src/app/api/verticals/route.ts",
  "src/app/api/projects/[id]/classification/route.ts",
  "tests/project-verticals-3048.test.ts",
  "tests/project-verticals-ui-3048.test.tsx",
  "tests/project-verticals-db-3048.test.ts",
  "tests/failed-flag-views.test.tsx",
  "vitest.sho-3048.config.mts",
  "prisma/migrations/20261026100000_recoverable_project_delete/migration.sql",
  "src/app/(app)/projects/ProjectsView.tsx",
  "src/app/(app)/projects/[id]/members/Members.tsx",
  "src/app/api/projects/route.ts",
  "src/app/api/projects/[id]/delete/route.ts",
  "src/app/api/projects/[id]/restore/route.ts",
  "src/lib/projects.ts",
  "src/lib/access.ts",
  "src/lib/search.ts",
  "src/lib/feed.ts",
  "src/lib/notify.ts",
  "tests/project-delete-3047.test.ts",
  "tests/project-delete-db-3047.test.ts",
  "tests/project-delete-ui-3047.test.tsx",
  "tests/reported-delete-org-edit.test.tsx",
  "tests/viewport/return-to.story.test.ts",
  "vitest.sho-3047.config.mts",
  "vitest.reported-delete-org-edit.config.mts",
  "prisma/schema.prisma",
  "prisma/migrations/20261024101000_deal_classification_revenue/migration.sql",
  "prisma/migrations/20261024110000_stage_delivery_category/migration.sql",
  "prisma/migrations/20261024110100_bid_stage_mapping/migration.sql",
  "src/app/(app)/projects/[id]/ProjectView.tsx",
  "src/app/(app)/accounts/[id]/OrgView.tsx",
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
  "src/lib/deal-date-filter.ts",
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
  "tests/deal-date-filter.test.ts",
  "tests/review-commercial-counts.test.tsx",
  "tests/usage-month.test.tsx",
  "tests/usage-month-figure-2951.test.ts",
  "tests/no-proc-environ-2917.test.ts",
  "vitest.sho-3038.config.mts",
  "vitest.sho-3044.config.mts",
  "vitest.sho-3042.config.mts",
  "vitest.sho-3041.config.mts",
  "vitest.sho-3043.config.mts",
  "scripts/acceptance/sho-3038-scope.test.mjs",
  "scripts/staging-editor.ts",
  ".github/workflows/scoped4-validation.yml",
]);

test("sequential release changes only explicitly reviewed surfaces", () => {
  const changed = execFileSync("git", ["diff", "--name-only", production, "--"], { encoding: "utf8" })
    .trim().split("\n").filter(Boolean);
  assert.ok(changed.length);
  for (const file of changed) assert.ok(allowed.has(file), file);
});

test("sequential release does not change package/runtime entry or central suite auth", () => {
  for (const path of ["package.json", "package-lock.json", "server.js", "src/app/api/suite"])
    assert.equal(execFileSync("git", ["diff", production, "--", path], { encoding: "utf8" }), "", path);
});

test("the only local-auth delta is the reviewed staging-only ZZ admin guard", () => {
  const diff = execFileSync("git", ["diff", production, "--", "src/app/api/auth"], { encoding: "utf8" });
  const digest = createHash("sha256").update(diff).digest("hex");
  assert.equal(digest, "d758bdd4254d4b67d83d0fb34e523cd269a66930705bfc79f6e85ba3602223af");
});
