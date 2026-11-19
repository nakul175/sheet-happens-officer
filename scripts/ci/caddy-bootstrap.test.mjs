import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function normalized(source) {
  return source.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
}

test('cloud-init installs the reviewed Tasks Caddy routing candidate without drift', () => {
  const bootstrap = readFileSync('deploy/cloud-init.yaml', 'utf8');
  const start = bootstrap.indexOf('  - path: /etc/sho/Caddyfile\n    content: |\n');
  assert.notEqual(start, -1, 'Caddyfile write_files entry missing');
  // Keep parsing bounded to the indented YAML block; the next write_files item
  // starts at two spaces and must not become part of the Caddyfile.
  const lines = bootstrap.slice(start).split('\n').slice(2);
  const block = [];
  for (const line of lines) {
    if (line && !line.startsWith('      ')) break;
    block.push(line.startsWith('      ') ? line.slice(6) : '');
  }
  const installed = normalized(block.join('\n'));
  const reviewed = normalized(readFileSync('deploy/Caddyfile.tasks.candidate', 'utf8'));
  assert.deepEqual(installed, reviewed);
});
