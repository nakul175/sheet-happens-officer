import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import test from 'node:test';
const base='afc38bd3e2973b0c4b0974a59d3c43e443648bb2';
const allowed=new Set(['src/lib/suite-oauth.ts','src/components/TaskModal.tsx','src/components/HolySheetDocuments.tsx','src/app/(app)/projects/[id]/ProjectView.tsx','src/lib/holy-sheet-links.ts','src/app/api/projects/[id]/documents/route.ts','src/app/api/tasks/[id]/documents/route.ts','src/components/HolySheetLauncher.tsx','src/lib/holy-sheet-url.ts','src/app/api/tasks/[id]/holy-sheet/route.ts','src/lib/holy-qa-identity.ts','src/lib/central-client.ts','src/lib/central-status.ts','src/lib/attach-central-session.ts','src/app/api/auth/aplyd/callback/route.ts','prisma/schema.prisma','prisma/migrations/20261027120000_holy_sheet_links/migration.sql',
 'src/app/api/suite/token/route.ts','src/lib/holy-sheet-checklist-tasks.ts','src/lib/holy-sheet-checklist-tasks.test.ts','src/lib/suite-oauth-holy-sheet.test.ts',
 'src/app/api/integrations/holy-sheet/checklist/projects/route.ts','src/app/api/integrations/holy-sheet/checklist/projects/[projectId]/assignees/route.ts','src/app/api/integrations/holy-sheet/checklist/review/route.ts','src/app/api/integrations/holy-sheet/checklist/tasks/route.ts','src/app/api/integrations/holy-sheet/checklist/intents/[intentId]/route.ts',
 'prisma/migrations/20261028223000_holy_sheet_checklist_tasks/migration.sql']);
// SHO-2909: reviewed accessibility prerequisite; keep the existing integration allowlist and protected surfaces.
for (const path of ['src/app/(app)/Shell.tsx', 'src/app/(app)/projects/projects.css', 'src/components/PeopleSelect.tsx']) allowed.add(path);
test('SHO-3062 extends the reviewed launcher and preserves canonical auth and release gates',()=>{
 execFileSync('git',['merge-base','--is-ancestor',base,'HEAD']);
 const files=execFileSync('git',['diff','--name-only',base,'--','src','prisma'],{encoding:'utf8'}).trim().split('\n').filter(Boolean);
 for(const file of files)assert.ok(allowed.has(file),`Unexpected runtime change: ${file}`);
 assert.equal(execFileSync('git',['diff','c2700202ed0789dab36a33dfde2a0edff57f07c0','--','scripts/acceptance/holy3-launcher-scope.test.mjs'],{encoding:'utf8'}),'');
 for(const path of ['src/lib/auth.ts','.github/workflows/scoped4-validation.yml','.github/workflows/accepted15-validation.yml','src/lib/shutdown.ts','server.js'])assert.equal(execFileSync('git',['diff',base,'--',path],{encoding:'utf8'}),'',`Preserve ${path}`);
});
