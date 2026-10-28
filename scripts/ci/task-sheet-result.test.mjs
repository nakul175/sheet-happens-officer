import test from 'node:test';
import assert from 'node:assert/strict';
import { assertTaskSheetPassed } from './task-sheet-result.mjs';
function report() { return { stats:{expected:9,unexpected:0,skipped:0,flaky:0}, errors:[], suites:[{suites:[{specs:Array.from({length:9},()=>({tests:[{expectedStatus:'passed',status:'expected',results:[{status:'passed'}]}]}))}]}] }; }
const first = r => r.suites[0].suites[0].specs[0].tests[0];
test('accepts nine actual ordinary passes in nested suites',()=>assert.doesNotThrow(()=>assertTaskSheetPassed(report())));
test('refuses an expected failure despite nine aggregate expected results',()=>{const r=report();first(r).expectedStatus='failed';first(r).results[0].status='failed';assert.throws(()=>assertTaskSheetPassed(r));});
test('refuses an actual failure',()=>{const r=report();first(r).results[0].status='failed';assert.throws(()=>assertTaskSheetPassed(r));});
test('refuses missing cases despite aggregate count',()=>{const r=report();r.suites[0].suites[0].specs.pop();assert.throws(()=>assertTaskSheetPassed(r));});
test('refuses retries rather than silently accepting recovered runs',()=>{const r=report();first(r).results.unshift({status:'failed'});assert.throws(()=>assertTaskSheetPassed(r));});
test('refuses top-level errors and skipped or flaky aggregates',()=>{for(const change of [r=>r.errors.push({message:'fixture'}),r=>r.stats.skipped=1,r=>r.stats.flaky=1]){const r=report();change(r);assert.throws(()=>assertTaskSheetPassed(r));}});
