import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessEnvironmentProtection, verifyEnvironmentProtection } from '../../deploy/verify-environment-protection.mjs';

const protectedEnvironment = {
  protection_rules: [{ type: 'required_reviewers', prevent_self_review: true, reviewers: [{ type: 'User', reviewer: { id: 1 } }] }],
  can_admins_bypass: false,
};

test('rejects the currently observed unprotected production environment', () => {
  assert.equal(assessEnvironmentProtection({ protection_rules: [], can_admins_bypass: true }), 'REQUIRED_REVIEWERS_MISSING');
});

test('requires a distinct reviewer and no administrator bypass', () => {
  assert.equal(assessEnvironmentProtection({ ...protectedEnvironment, protection_rules: [{ ...protectedEnvironment.protection_rules[0], prevent_self_review: false }] }), 'SELF_REVIEW_ALLOWED');
  assert.equal(assessEnvironmentProtection({ ...protectedEnvironment, can_admins_bypass: true }), 'ADMIN_BYPASS_ALLOWED');
  assert.equal(assessEnvironmentProtection(protectedEnvironment), null);
});

test('fails closed when the environment cannot be read', async () => {
  await assert.rejects(verifyEnvironmentProtection('owner/repo', async () => ({ ok: false })), /ENVIRONMENT_UNAVAILABLE/);
  await assert.rejects(verifyEnvironmentProtection('owner/repo', async () => { throw new Error('offline'); }), /offline/);
  await assert.rejects(verifyEnvironmentProtection('owner/repo?unsafe', async () => { throw new Error('unexpected request'); }), /INVALID_REPOSITORY/);
});

test('accepts only a protected production environment from the repository API', async () => {
  const urls = [];
  const result = await verifyEnvironmentProtection('owner/repo', async (url) => {
    urls.push(url);
    return { ok: true, json: async () => protectedEnvironment };
  });
  assert.equal(result, 'PRODUCTION_APPROVAL_PROTECTED');
  assert.deepEqual(urls, ['https://api.github.com/repos/owner/repo/environments/production']);
});
