import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
test('shared task authorization does not depend on task/deal/record mutation services',()=>{
 const text=readFileSync('src/lib/task-access.ts','utf8');
 assert.doesNotMatch(text,/from ["']@\/lib\/(tasks|deals|records)["']/);
 for(const file of ['deals','records'])assert.doesNotMatch(readFileSync(`src/lib/${file}.ts`,'utf8'),/from ["']@\/lib\/tasks["']/);
});
test('task mutations call the small transaction-scoped deal rule without loading deal mutations',()=>{
 const tasks=readFileSync('src/lib/tasks.ts','utf8');
 const rule=readFileSync('src/lib/deal-next-step.ts','utf8');
 assert.match(tasks,/from ["']@\/lib\/deal-next-step["']/);
 assert.doesNotMatch(tasks,/from ["']@\/lib\/deals["']/);
 assert.doesNotMatch(rule,/from ["']@\/lib\/(tasks|deals|records)["']/);
});
