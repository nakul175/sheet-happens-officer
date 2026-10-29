// NJ authorized these six stories; preserve the incident-recovered runtime and schema.
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import test from "node:test";
const base="2cf4e6d3c4eb3b7a74554ff8bbcae5e3758177ff";
const allowed=new Set([
  "tests/e2e/local/SHO-2584.browser.test.ts",
  "package-lock.json",
  "package.json",
  "src/app/(app)/Bell.tsx",
  "src/app/(app)/MyTasks.tsx",
  "src/app/(app)/Shell.tsx",
  "src/app/(app)/projects/[id]/activity/Activity.tsx",
  "src/app/(app)/team/[id]/Person.tsx",
  "src/app/actions/sign-out.ts",
  "src/components/DealBoard.tsx",
  "src/components/DealPanel.tsx",
  "src/components/concierge/Concierge.tsx",
  "src/components/concierge/types.ts",
  "src/lib/activity-text.ts",
  "src/lib/concierge/crm-reads.ts",
  "src/lib/concierge/engine.ts",
  "src/lib/concierge/thread.ts",
  "src/lib/concierge/tools.ts",
  "src/lib/concierge/types.ts",
  "src/lib/deals.ts",
  "src/lib/feed.ts",
  "src/lib/orgs.ts",
  "src/lib/records.ts",
  "src/lib/schemas.ts",
  "src/lib/tasklist.ts",
  "tests/bid-stage-lifecycle.test.ts",
  "tests/comments-19-1.test.ts",
  "tests/concierge-crm-2584.test.ts",
  "tests/crm-visible-quick-http.test.ts",
  "tests/e2e/local/SHO-2666.browser.test.ts",
  "tests/e2e/stories/APL-2691.spec.ts",
  "tests/person-approved.test.tsx",
  "tests/settings-activity-trash-approved.test.tsx",
  "tests/sho-3050-acceptance.test.ts",
  "tests/sho-3136-branding.test.tsx",
  ".github/workflows/e5-six-story-validation.yml",
  "scripts/acceptance/e5-six-story-scope.test.mjs"
]);
test("six-story release changes only reviewed files from the exact live baseline",()=>{
 execFileSync("git",["merge-base","--is-ancestor",base,"HEAD"]);
 const files=execFileSync("git",["diff","--name-only",base,"HEAD"],{encoding:"utf8"}).trim().split("\n").filter(Boolean);
 for(const file of files)assert.ok(allowed.has(file),`Unapproved release file: ${file}`);
 for(const path of ["prisma","server.js","src/lib/auth.ts","src/lib/shutdown.ts","src/lib/central-client.ts","src/lib/suite-oauth.ts","deploy"])
  assert.equal(execFileSync("git",["diff",base,"HEAD","--",path],{encoding:"utf8"}),"",`Preserve ${path}`);
});
