import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import test from 'node:test';
const base='a476ca42584267ffdec089c8e893bf9ee09c3dc1';
const allowed=new Set(["src/app/(app)/deals/DealsView.tsx", "tests/deal-filter-browser.story.ts", "vitest.deal-filters.config.mts", "scripts/acceptance/sho3134-prod-scope.test.mjs"]);
test('SHO-3134 adds only the phone disclosure follow-up on the a476 Workload lineage',()=>{
 execFileSync('git',['merge-base','--is-ancestor',base,'HEAD']);
 const files=execFileSync('git',['diff','--name-only',base,'--'],{encoding:'utf8'}).trim().split('\n').filter(Boolean);
 for(const file of files)assert.ok(allowed.has(file),file);
 for(const path of ['prisma','package.json','package-lock.json','src/lib/auth.ts','src/app/api/auth','src/app/api/suite','src/lib/suite-oauth.ts','src/lib/shutdown.ts','server.js','deploy','tests/deploy-return-path-log.test.ts','.github/workflows/deploy.yml','.github/workflows/scoped4-validation.yml','.github/workflows/accepted15-validation.yml','src/app/(app)/workload','src/app/api/workload','src/lib/workload.ts'])
  assert.equal(execFileSync('git',['diff',base,'--',path],{encoding:'utf8'}),'',`Preserve ${path}`);
 for(const route of ['src/app/api/suite/authorize/route.ts','src/app/api/suite/status/route.ts','src/app/api/suite/token/route.ts','src/app/api/suite/userinfo/route.ts'])
  execFileSync('git',['cat-file','-e',`HEAD:${route}`]);
});
