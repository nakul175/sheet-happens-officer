import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import test from 'node:test';
const base='c2700202ed0789dab36a33dfde2a0edff57f07c0';
const allowed=new Set(['src/components/TaskModal.tsx','src/components/HolySheetDocuments.tsx','src/app/(app)/projects/[id]/ProjectView.tsx','src/lib/holy-sheet-links.ts','src/app/api/projects/[id]/documents/route.ts','src/app/api/tasks/[id]/documents/route.ts','prisma/schema.prisma','prisma/migrations/20261027120000_holy_sheet_links/migration.sql']);
test('SHO-3062 extends the reviewed launcher and preserves canonical auth and release gates',()=>{
 execFileSync('git',['merge-base','--is-ancestor',base,'HEAD']);
 const files=execFileSync('git',['diff','--name-only',base,'--','src','prisma'],{encoding:'utf8'}).trim().split('\n').filter(Boolean);
 for(const file of files)assert.ok(allowed.has(file),`Unexpected runtime change: ${file}`);
 for(const path of ['src/lib/auth.ts','src/lib/central-client.ts','src/lib/central-status.ts','src/lib/attach-central-session.ts','scripts/acceptance/holy3-launcher-scope.test.mjs','scripts/acceptance/accepted15-scope.test.mjs','src/lib/shutdown.ts','server.js'])assert.equal(execFileSync('git',['diff',base,'--',path],{encoding:'utf8'}),'',`Preserve ${path}`);
});
