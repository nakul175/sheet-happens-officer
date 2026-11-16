import { test } from 'node:test';import assert from 'node:assert/strict';import { readFileSync } from 'node:fs';
import { renderService } from '../../deploy/render-service.mjs';
const read=p=>readFileSync(new URL('../../'+p,import.meta.url),'utf8');const m=JSON.parse(read('deploy/runtime-manifest.json'));
test('tracked unit and bootstrap are generated from the same observed profile',()=>{const unit=renderService(m);assert.equal(read('deploy/sho.service'),unit);assert.ok(read('deploy/cloud-init.yaml').includes(unit.split('\n').filter((l,i,a)=>i<a.length-1).map(l=>'      '+l+'\n').join('')));});
test('native entry, stop grace, required suite sources and no schedules preserved',()=>{assert.match(renderService(m),/ExecStart=\/usr\/bin\/node --import tsx server.js/);assert.match(renderService(m),/TimeoutStopSec=40/);assert.equal(m.environmentFiles.length,5);assert.doesNotMatch(read('deploy/cloud-init.yaml'),/path: \/etc\/cron|crontab|job.sh reminders/);});
test('renderer rejects injected unit directives',()=>assert.throws(()=>renderService({...m,user:'deploy\nUser=root'}),/Invalid/));
