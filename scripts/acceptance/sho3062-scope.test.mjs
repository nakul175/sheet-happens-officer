import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import test from 'node:test';
import {readFileSync} from 'node:fs';
const base='afc38bd3e2973b0c4b0974a59d3c43e443648bb2';
const allowed=new Set(['src/lib/suite-oauth.ts','src/components/TaskModal.tsx','src/components/HolySheetDocuments.tsx','src/app/(app)/projects/[id]/ProjectView.tsx','src/lib/holy-sheet-links.ts','src/app/api/projects/[id]/documents/route.ts','src/app/api/tasks/[id]/documents/route.ts','src/components/HolySheetLauncher.tsx','src/lib/holy-sheet-url.ts','src/app/api/tasks/[id]/holy-sheet/route.ts','src/lib/holy-qa-identity.ts','src/lib/central-client.ts','src/lib/central-status.ts','src/lib/attach-central-session.ts','src/app/api/auth/aplyd/callback/route.ts','prisma/schema.prisma','prisma/migrations/20261027120000_holy_sheet_links/migration.sql']);
test('SHO-3062 extends the reviewed launcher and preserves canonical auth and release gates',()=>{
 execFileSync('git',['merge-base','--is-ancestor',base,'HEAD']);
 const files=execFileSync('git',['diff','--name-only',base,'--','src','prisma'],{encoding:'utf8'}).trim().split('\n').filter(Boolean);
 for(const file of files)assert.ok(allowed.has(file) || file === 'src/lib/feed.ts',`Unexpected runtime change: ${file}`);
 // SHO-2727 is the only additional runtime delta permitted on the deployed native release.
 // Compare the whole file against the frozen production source plus the reviewed predicate;
 // allowing feed.ts here does not permit arbitrary feed changes.
 const priorFeed=execFileSync('git',['show','5a87eacc668ebcd4e7070f14e05bbc72182b102b:src/lib/feed.ts'],{encoding:'utf8'});
 const expectedFeed=priorFeed
  .replace('  const hiddenDeals = await hiddenDealIds(user, page.map((n) => n.projectId));','  const hiddenDeals = await hiddenDealIds(user, page.map((n) => n.projectId));\n  const hideCrm = !crmVisible(user);')
  .replace('      const notice = noticeForReader(n, !!n.projectId && hiddenDeals.has(n.projectId));','      // A typed deal notice remains private even after its project was purged or its FK was omitted.\n      const notice = noticeForReader(n, (hideCrm && n.type.startsWith("DEAL_")) || (!!n.projectId && hiddenDeals.has(n.projectId)));');
 assert.notEqual(expectedFeed,priorFeed);
 assert.equal(readFileSync('src/lib/feed.ts','utf8'),expectedFeed,'SHO-2727 must be exactly the reviewed orphan-notice predicate');
 assert.equal(execFileSync('git',['diff','c2700202ed0789dab36a33dfde2a0edff57f07c0','--','scripts/acceptance/holy3-launcher-scope.test.mjs'],{encoding:'utf8'}),'');
 for(const path of ['src/lib/auth.ts','.github/workflows/scoped4-validation.yml','.github/workflows/accepted15-validation.yml','src/lib/shutdown.ts','server.js'])assert.equal(execFileSync('git',['diff',base,'--',path],{encoding:'utf8'}),'',`Preserve ${path}`);
});
