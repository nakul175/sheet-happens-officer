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
