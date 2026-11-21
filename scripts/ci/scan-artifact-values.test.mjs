import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const scanner = fileURLToPath(new URL('./scan-artifact-values.mjs', import.meta.url));

test('artifact upload is withheld on raw, encoded and symlinked secret content without printing values', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sho-artifact-scan-'));
  const marker = 'synthetic-private-value/12345';
  const run = (target = dir) => spawnSync(process.execPath, [scanner, target], {
    encoding: 'utf8',
    env: { ...process.env, JOB_SECRET: marker, STAGING_USER: 'synthetic-user', STAGING_PASS: 'synthetic-password' },
  });
  try {
    await mkdir(path.join(dir, 'nested'));
    const file = path.join(dir, 'nested', 'result.json');
    await writeFile(file, '{"ok":true}');
    assert.equal(run().status, 0);
    for (const value of [marker, encodeURIComponent(marker), Buffer.from('synthetic-user:synthetic-password').toString('base64')]) {
      await writeFile(file, value);
      const result = run();
      assert.equal(result.status, 1);
      assert.match(result.stderr, /ARTIFACT_SECRET_MATCH/);
      assert.doesNotMatch(result.stderr + result.stdout, /synthetic-private-value/);
    }
    await rm(file);
    await symlink('/tmp', file);
    const result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ARTIFACT_SYMLINK/);
    await rm(file);
    const source = path.join(dir, 'archive-source');
    await mkdir(source);
    const report = path.join(source, 'report.json');
    await writeFile(report, '{"ok":true}');
    const archive = path.join(dir, 'report.zip');
    const pack = () => spawnSync('zip', ['-q', '-FS', archive, 'report.json'], { cwd: source });
    const packed = pack();
    assert.equal(packed.status, 0);
    assert.equal(run(archive).status, 0);
    await writeFile(report, marker);
    assert.equal(pack().status, 0);
    await rm(source, { recursive: true });
    const zipped = run(archive);
    assert.equal(zipped.status, 1);
    assert.match(zipped.stderr, /ARTIFACT_SECRET_MATCH/);
    assert.doesNotMatch(zipped.stderr + zipped.stdout, /synthetic-private-value/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
