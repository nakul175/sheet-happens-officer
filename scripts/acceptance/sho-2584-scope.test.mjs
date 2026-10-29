import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import test from "node:test";
const base="2cf4e6d3c4eb3b7a74554ff8bbcae5e3758177ff";
const allowed=new Set([
  "package-lock.json",
  "package.json",
  "src/components/concierge/Concierge.tsx",
  "src/components/concierge/types.ts",
  "src/lib/concierge/crm-reads.ts",
  "src/lib/concierge/engine.ts",
  "src/lib/concierge/thread.ts",
  "src/lib/concierge/tools.ts",
  "src/lib/concierge/types.ts",
  "src/lib/orgs.ts",
  "src/lib/records.ts",
  "tests/concierge-crm-2584.test.ts",
  "tests/crm-visible-quick-http.test.ts",
  "tests/e2e/local/SHO-2584.browser.test.ts",
  ".github/workflows/sho-2584-validation.yml",
  "scripts/acceptance/sho-2584-scope.test.mjs"
]);
test("SHO-2584 changes only reviewed files from verified live baseline",()=>{
 execFileSync("git",["merge-base","--is-ancestor",base,"HEAD"]);
 const files=execFileSync("git",["diff","--name-only",base,"HEAD"],{encoding:"utf8"}).trim().split("\n").filter(Boolean);
 for(const file of files)assert.ok(allowed.has(file),`Unapproved release file: ${file}`);
 for(const path of ["prisma","server.js","src/lib/auth.ts","src/lib/shutdown.ts","src/lib/central-client.ts","src/lib/suite-oauth.ts","deploy"])
  assert.equal(execFileSync("git",["diff",base,"HEAD","--",path],{encoding:"utf8"}),"",`Preserve ${path}`);
});
