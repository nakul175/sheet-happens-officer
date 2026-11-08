import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pruneReleases } from '../../deploy/prune-releases.mjs';

function fixture() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'sho-retention-')));
  const root = path.join(dir, 'releases');
  mkdirSync(root);
  const names = 'abcdef'.split('').map((letter) => letter.repeat(40));
  for (let i = 0; i < 5; i++) {
    const rel = path.join(root, names[i]);
    mkdirSync(path.join(rel, '.next'), { recursive: true });
    writeFileSync(path.join(rel, 'COMMIT'), names[i]);
    writeFileSync(path.join(rel, '.next/BUILD_ID'), 'build-' + i);
    utimesSync(rel, new Date(100000 + i * 1000), new Date(100000 + i * 1000));
  }
  const incomplete = path.join(root, names[5]);
  mkdirSync(incomplete); // Reserved upload: never delete it.
  const unknown = path.join(root, 'old release with spaces');
  mkdirSync(unknown);writeFileSync(path.join(unknown, 'marker'), 'preserve');
  const outside = path.join(dir, 'outside');
  mkdirSync(outside);writeFileSync(path.join(outside, 'marker'), 'preserve');
  symlinkSync(outside, path.join(root, '9'.repeat(40)));
  const active = path.join(root, names[4]);
  const previous = path.join(root, names[0]); // Older than the retention window, still protected.
  symlinkSync(active, path.join(dir, 'current'));
  return { dir, root, names, active, previous, incomplete, unknown, outside };
}

test('retention removes only old complete releases and protects active, rollback and unknown trees', async () => {
  const f = fixture();
  try {
    const result = await pruneReleases(f.root, f.active, f.previous, 3);
    assert.deepEqual(result.removed, [f.names[1]]);
    assert.equal(result.retained, 4);
    for (const name of [f.names[0], f.names[2], f.names[3], f.names[4]]) assert.equal(existsSync(path.join(f.root, name)), true);
    assert.equal(existsSync(path.join(f.root, f.names[1])), false);
    assert.equal(existsSync(f.incomplete), true);
    assert.equal(readFileSync(path.join(f.unknown, 'marker'), 'utf8'), 'preserve');
    assert.equal(readFileSync(path.join(f.outside, 'marker'), 'utf8'), 'preserve');
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('retention refuses a changed active pointer before deleting anything', async () => {
  const f = fixture();
  try {
    await assert.rejects(pruneReleases(f.root, f.previous, f.active, 3), /ACTIVE_RELEASE_CHANGED/);
    assert.equal(existsSync(path.join(f.root, f.names[1])), true);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('retention refuses an incomplete protected release before deleting anything', async () => {
  const f = fixture();
  try {
    await assert.rejects(pruneReleases(f.root, f.active, f.incomplete, 3), /PROTECTED_RELEASE_INCOMPLETE/);
    assert.equal(existsSync(path.join(f.root, f.names[1])), true);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
