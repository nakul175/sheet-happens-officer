import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
const base='afc38bd3e2973b0c4b0974a59d3c43e443648bb2';
const allowed=new Set(['src/lib/suite-oauth.ts','src/components/TaskModal.tsx','src/components/HolySheetDocuments.tsx','src/app/(app)/projects/[id]/ProjectView.tsx','src/lib/holy-sheet-links.ts','src/app/api/projects/[id]/documents/route.ts','src/app/api/tasks/[id]/documents/route.ts','src/components/HolySheetLauncher.tsx','src/lib/holy-sheet-url.ts','src/app/api/tasks/[id]/holy-sheet/route.ts','src/lib/holy-qa-identity.ts','src/lib/central-client.ts','src/lib/central-status.ts','src/lib/attach-central-session.ts','src/app/api/auth/aplyd/callback/route.ts','prisma/schema.prisma','prisma/migrations/20261027120000_holy_sheet_links/migration.sql']);
test('SHO-3062 extends the reviewed launcher and preserves canonical auth and release gates',()=>{
 execFileSync('git',['merge-base','--is-ancestor',base,'HEAD']);
 // SHO-2909: add only the reviewed accessibility prerequisite; retain integration and protected-surface gates.
 for (const path of ['src/app/(app)/Shell.tsx', 'src/app/(app)/projects/projects.css', 'src/components/PeopleSelect.tsx']) allowed.add(path);
 // SHO-2666: permit only the reviewed native cleanup and existing-session sign-out action.
 const lintFixes = new Map([
  ['src/app/(app)/Shell.tsx', '250c54e8da1d4c99430869bad55cf30e57ac65c8b4f6a35a41b4280c1c42dcfb'],
  ['src/app/(app)/Bell.tsx', 'f036ebb12c0b13d989205e3f482392d08b7656768ac888aec52147cf76338d1c'],
  ['src/app/(app)/MyTasks.tsx', '726661d4f316407e37308a68248e00f7c76d9158a81e21be0d4ea5bf5a5f73b9'],
  ['src/app/actions/sign-out.ts', '687c57290de4fe4b32dcf0a3af85d20be624a74a16411b66712f073211a78cb8'],
  ['src/lib/activity-text.ts', '282d326704f8e33107350a3fe5bfa198812e2f4dc40ab3c865fb54ed5dfd19ba'],
  ['src/lib/records.ts', 'b3498efac86311a5e184ca1af5f6e429be952cc746314357f7eae25bcbea3b85'],
 ]);
 for (const [path, sha] of lintFixes) { allowed.add(path); assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), sha, `Preserve reviewed SHO-2666 file ${path}`); }
 const files=execFileSync('git',['diff','--name-only',base,'--','src','prisma'],{encoding:'utf8'}).trim().split('\n').filter(Boolean);
 for(const file of files)assert.ok(allowed.has(file),`Unexpected runtime change: ${file}`);
 assert.equal(execFileSync('git',['diff','c2700202ed0789dab36a33dfde2a0edff57f07c0','--','scripts/acceptance/holy3-launcher-scope.test.mjs'],{encoding:'utf8'}),'');
 for(const path of ['src/lib/auth.ts','.github/workflows/scoped4-validation.yml','.github/workflows/accepted15-validation.yml','src/lib/shutdown.ts','server.js'])assert.equal(execFileSync('git',['diff',base,'--',path],{encoding:'utf8'}),'',`Preserve ${path}`);
});
