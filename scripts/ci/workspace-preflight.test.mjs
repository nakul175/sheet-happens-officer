import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assessWorkspaceContract } from '../../deploy/verify-workspace-contract.mjs';

test('release refuses ambiguous or unapproved workspace state', () => {
  assert.equal(assessWorkspaceContract({ mode: undefined, workspaces: 0, foreignUsers: 0 }), 'WORKSPACE_COUNT_INVALID');
  assert.equal(assessWorkspaceContract({ mode: undefined, workspaces: 2, foreignUsers: 0 }), 'WORKSPACE_COUNT_INVALID');
  assert.equal(assessWorkspaceContract({ mode: undefined, workspaces: 1, foreignUsers: 1 }), 'WORKSPACE_USER_MISMATCH');
  assert.equal(assessWorkspaceContract({ mode: 'true', workspaces: 1, foreignUsers: 0 }), 'WORKSPACE_MODE_UNAPPROVED');
  assert.equal(assessWorkspaceContract({ mode: undefined, workspaces: 1, foreignUsers: 0 }), null);
});

test('read-only workspace preflight runs before migration check, build and switch', () => {
  const release = readFileSync(new URL('../../deploy/release.sh', import.meta.url), 'utf8');
  const preflight = release.indexOf('node "$REL/deploy/verify-workspace-contract.mjs"');
  assert.ok(preflight > release.indexOf('npm ci --include=dev'));
  assert.ok(preflight < release.indexOf('prisma migrate status'));
  assert.ok(preflight < release.indexOf('npx next build'));
  assert.ok(preflight < release.indexOf('switch "$REL"'));
  const source = readFileSync(new URL('../../deploy/verify-workspace-contract.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(UPDATE|DELETE|INSERT|ALTER|DROP|CREATE)\b/);
});
