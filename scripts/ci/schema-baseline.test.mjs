import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
const baseline=JSON.parse(readFileSync('deploy/schema-baseline.json','utf8'));
test('recorded schema history matches every checked-in migration byte',()=>{
 const names=readdirSync('prisma/migrations',{withFileTypes:true}).filter(x=>x.isDirectory()).map(x=>x.name).sort();
 assert.deepEqual(names,Object.keys(baseline.migrations).sort());
 for(const name of names)assert.equal(createHash('sha256').update(readFileSync(`prisma/migrations/${name}/migration.sql`)).digest('hex'),baseline.migrations[name],name);
});
test('3054 reconciliation keeps the approved nullable expansion unchanged',()=>{
 assert.equal(baseline.migrations['20261029030000_bid_deadline_time'],'0e58d00815cad1af702ef9f18d90e115026a916ffcb3849faa813f288835c568');
 const schema=readFileSync('prisma/schema.prisma','utf8');
 assert.match(schema,/submissionDeadline\s+DateTime\? @db.Date/);
 assert.match(schema,/submissionDeadlineAt\s+DateTime\? @db.Timestamptz\(3\)/);
 assert.match(schema,/submissionDeadlineZone\s+String\?/);
});
test('maintainer data reference retains multiline project and section partial indexes',()=>{
 const reference=readFileSync('docs/data/MODEL-REFERENCE.md','utf8');
 assert.match(reference,/CREATE UNIQUE INDEX "ProjectMember_one_leader_per_project"\s+ON "ProjectMember" \("projectId"\) WHERE "role" = 'LEADER';/);
 assert.match(reference,/CREATE UNIQUE INDEX "Section_one_done_per_project"\s+ON "Section" \("projectId"\) WHERE "isDone" = true;/);
});
test('maintainer data reference includes complete custom trigger definitions and search-path pins',()=>{
 const reference=readFileSync('docs/data/MODEL-REFERENCE.md','utf8');
 assert.match(reference,/CREATE OR REPLACE FUNCTION "enforce_max_sections"\(\)[\s\S]*?RETURN NEW;\s*END;\s*\$\$ LANGUAGE plpgsql;\s*ALTER FUNCTION "enforce_max_sections"\(\) SET search_path FROM CURRENT;/);
 assert.match(reference,/CREATE OR REPLACE FUNCTION "enforce_task_section_in_project"\(\)[\s\S]*?RETURN NEW;\s*END;\s*\$\$ LANGUAGE plpgsql;\s*ALTER FUNCTION "enforce_task_section_in_project"\(\) SET search_path FROM CURRENT;/);
 assert.match(reference,/CREATE FUNCTION holy_sheet_task_move\(\)[\s\S]*?RETURN NEW;\s*END \$\$;\s*ALTER FUNCTION holy_sheet_task_move\(\) SET search_path FROM CURRENT;\s*CREATE TRIGGER holy_sheet_task_move[\s\S]*?EXECUTE FUNCTION holy_sheet_task_move\(\);/);
 assert.match(reference,/ALTER TABLE "TaskLink" ADD CONSTRAINT "TaskLink_exactly_one_target"\s+CHECK \(\("organisationId" IS NOT NULL\)::int \+ \("contactId" IS NOT NULL\)::int = 1\);/);
});
