import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('slow production burst keeps health identity and emits parseable JSON with assertions', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sho-slow-identity-'));
  try {
    mkdirSync(path.join(root, '.next'));
    writeFileSync(path.join(root, '.next/BUILD_ID'), 'fixture-build');
    // Reuse tsx from the checkout; no dependency installation in this fixture.
    symlinkSync(path.resolve('node_modules'), path.join(root, 'node_modules'), 'dir');
    writeFileSync(path.join(root, 'server.js'), `
const http = require('node:http');
const s = http.createServer((req, res) => {
  if (req.url === '/api/health') return res.end(JSON.stringify({release: process.env.RELEASE}));
  console.log('sho-hit');
  setTimeout(() => res.end('done\\n'), Number(new URL(req.url, 'http://localhost').searchParams.get('ms')));
});
s.listen(Number(process.env.PORT), '127.0.0.1', () => console.log('sho ready ' + s.address().port));
process.on('SIGTERM', () => s.close(() => { console.log('graceful shutdown: drained in-flight requests'); process.exit(0); }));
`);
    const out = spawnSync(process.execPath, ['scripts/drain-burst.mjs', '5', '0', '--production', '--slow', '--assert'], {
      encoding: 'utf8', timeout: 30000,
      env: {...process.env, SHO_APP_ROOT: root, RELEASE: 'fixture-sha'},
    });
    assert.equal(out.status, 0, out.stderr);
    const doc = JSON.parse(out.stdout);
    assert.equal(doc.release, 'fixture-sha');
    assert.equal(doc.stillOpenAtSigterm, 5);
    assert.equal(doc.inFlight.bodyDone, 5);
    assert.match(out.stderr, /mode=slow: PASS/);
  } finally { rmSync(root, {recursive:true, force:true}); }
});
