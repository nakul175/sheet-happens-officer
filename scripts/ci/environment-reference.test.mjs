import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [file] : [];
  });
}

test('every direct application/server environment read is in the maintainer reference', () => {
  const source = [...sourceFiles('src'), 'server.js'];
  const keys = new Set(source.flatMap((file) =>
    [...readFileSync(file, 'utf8').matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)].map((match) => match[1])));
  const table = readFileSync('docs/runbooks/environment-reference.md', 'utf8')
    .split('\n').filter((line) => line.startsWith('|')).join('\n');
  const missing = [...keys].filter((key) => !new RegExp(`\\b${key}\\b`).test(table)).sort();
  assert.deepEqual(missing, [], `undocumented direct environment reads: ${missing.join(', ')}`);
  assert.ok(keys.has('DATABASE_URL') && keys.has('APLYD_NATIVE_LOGOUT_ENABLED'));
});
