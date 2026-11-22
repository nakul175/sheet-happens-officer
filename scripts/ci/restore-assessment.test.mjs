import { test } from 'node:test';import assert from 'node:assert/strict';
import { createRequire } from 'node:module';const {assessPresence}=createRequire(import.meta.url)('../../deploy/restore-assessment.cjs');
test('almost-empty restore can never be called verified',()=>{const r=assessPresence({User:100,Task:100},{User:1,Task:0});assert.equal(r.status,'INCONCLUSIVE');assert.equal(r.exitCode,2);});
test('identical counts cannot prove data content or restore success',()=>{assert.equal(assessPresence({User:100,Task:100},{User:100,Task:100}).exitCode,2);});
test('missing tables and no users fail',()=>{assert.equal(assessPresence({User:100,Task:100},{User:1}).exitCode,1);assert.equal(assessPresence({User:100},{User:0}).exitCode,1);});
test('older valid snapshot remains inconclusive until independently verified',()=>{assert.equal(assessPresence({User:100,Task:100},{User:90,Task:80}).status,'INCONCLUSIVE');});
