// SHO-2559 AC2/AC5. The real suite must fail before this guard can pass.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, statSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
const target = new URL(process.env.TASKBOARD_URL ?? 'http://localhost:3000');
assert.ok(['localhost', '127.0.0.1'].includes(target.hostname), 'Negative control refuses every remote target');
const directory = 'test-results/viewport';
mkdirSync(directory, { recursive: true });
const result = spawnSync(process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'run', '-c', 'vitest.viewport.config.mts', 'tests/viewport/viewport.test.ts', '-t', 'Sign in @ 320 px$'], {
  encoding: 'utf8', timeout: 120_000,
  env: { ...process.env, NO_COLOR: '1', SHO_VIEWPORT_NEGATIVE_CONTROL: '1' },
});
const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '');
writeFileSync(`${directory}/negative-control.log`, output);
assert.equal(result.error, undefined, 'The suite must finish; timeout/startup failure is not a negative-control pass');
assert.ok(result.status !== null && result.status !== 0, 'Injected 400px regression must fail the actual suite');
for (const expected of ['Sign in at 320 px', 'div#sho-2559-negative-control', 'screen is 320 px', 'screenshot: test-results/viewport/Sign-in-320.png']) {
  assert.ok(output.includes(expected), `Failure must name ${expected}; see negative-control.log`);
}
assert.ok(statSync(`${directory}/Sign-in-320.png`).size > 0, 'Failure screenshot must exist');
const proofScreenshot = `${directory}/negative-control-400px-320.png`;
copyFileSync(`${directory}/Sign-in-320.png`, proofScreenshot);
writeFileSync(`${directory}/negative-control.json`, JSON.stringify({ screen: 'Sign in', width: 320, element: 'div#sho-2559-negative-control', injectedWidth: 400, suiteExitCode: result.status, screenshot: proofScreenshot, expectedFailureProven: true }, null, 2));
console.log('Proved: real Sign in @320px suite fails on a 400px element, names screen/width/element, and saves a screenshot.');
