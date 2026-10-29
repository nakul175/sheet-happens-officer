import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import test from 'node:test';
const base='5ba6d6ca107e1eeddbfd8a93a8c4939f2a128217';
const allowed=new Set(["src/app/(app)/deals/DealsView.tsx", "tests/deal-filter-browser.story.ts", "vitest.deal-filters.config.mts", "scripts/acceptance/sho3134-prod-scope.test.mjs", "scripts/acceptance/sho2589-scope.test.mjs", "scripts/acceptance/sho-3038-scope.test.mjs", "scripts/acceptance/sho3062-scope.test.mjs", ".github/workflows/approved-projects-ui.yml", ".github/workflows/sho3062-validation.yml"]);
test('SHO-3134 adds only the phone disclosure follow-up to qualified Workload',()=>{
 execFileSync('git',['merge-base','--is-ancestor',base,'HEAD']);
 const files=execFileSync('git',['diff','--name-only',base,'--'],{encoding:'utf8'}).trim().split('\n').filter(Boolean);
 for(const file of files)assert.ok(allowed.has(file),file);
 for(const path of ['prisma','package.json','package-lock.json','src/lib/auth.ts','src/app/api/auth','src/app/api/suite','src/lib/suite-oauth.ts','src/lib/shutdown.ts','server.js','deploy','.github/workflows/scoped4-validation.yml','.github/workflows/accepted15-validation.yml','src/app/(app)/workload','src/app/api/workload','src/lib/workload.ts'])
  assert.equal(execFileSync('git',['diff',base,'--',path],{encoding:'utf8'}),'',`Preserve ${path}`);
});
