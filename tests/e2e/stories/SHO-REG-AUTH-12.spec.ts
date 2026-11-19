import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { BrowserContext } from '@playwright/test';
import { test, BASE_URL, expect } from './qa';
import { auditLoopbackIgnoreHTTPSErrors } from '../base-url';
import { PW, zzTestData } from '../local-api';

test('SHO-REG-AUTH-12: profile forms and session controls affect only the signed-in Member', async ({ browser }) => {
  const database = new URL(process.env.DATABASE_URL ?? '');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(BASE_URL).hostname)
    || !['localhost', '127.0.0.1', '[::1]'].includes(database.hostname)
    || !/^\/sho_test(?:_[\w-]+)?$/.test(database.pathname)
    || process.env.TASKBOARD_URL !== BASE_URL)
    throw new Error('Auth-12 requires one guarded loopback app and synthetic sho_test database.');

  const fixture = zzTestData('auth12-profile');
  const contexts: BrowserContext[] = [];
  const evidenceDir = 'test-results/auth-profile-session';
  const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  try {
    const member = await fixture.person('member');
    const bystander = await fixture.person('bystander');
    const bystanderBefore = fingerprint({
      me: (await bystander.c.get('/api/auth/me')).json.user,
      density: (await bystander.c.get('/api/profile/density')).json,
    });
    expect((await member.c.post('/api/auth/signout')).status).toBe(204);

    const newContext = async () => {
      const context = await browser.newContext({ baseURL: BASE_URL, ignoreHTTPSErrors: auditLoopbackIgnoreHTTPSErrors() });
      contexts.push(context);
      return context;
    };
    const first = await newContext();
    const second = await newContext();
    for (const context of [first, second]) {
      const reply = await context.request.post('/api/auth/signin', { data: { email: member.email, password: PW } });
      expect(reply.status()).toBe(200);
      expect((await reply.json()).user.orgRole).toBe('MEMBER');
    }

    const page = await first.newPage();
    await page.goto('/profile');
    await page.getByRole('textbox', { name: 'Name' }).fill('ZZ-TEST Updated Member');
    await page.getByRole('button', { name: 'Save name' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
    await page.getByRole('button', { name: /Account and utilities/ }).click();
    await page.getByRole('button', { name: 'Compact' }).click();
    await expect.poll(async () => (await (await first.request.get('/api/profile/density')).json()).compact).toBe(true);
    await page.reload();
    await expect(page.getByRole('textbox', { name: 'Name' })).toHaveValue('ZZ-TEST Updated Member');

    await page.getByRole('button', { name: 'Sign out of all other devices' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Signed out of 1 other device.' })).toBeVisible();
    expect((await second.request.get('/api/auth/me')).status()).toBe(401);
    expect((await first.request.get('/api/auth/me')).status()).toBe(200);

    const restoredSecond = await second.request.post('/api/auth/signin', { data: { email: member.email, password: PW } });
    expect(restoredSecond.status()).toBe(200);
    const nextPassword = 'zz-updated-profile-pass-9';
    await page.getByLabel('Current password', { exact: true }).fill(PW);
    await page.getByLabel('New password', { exact: true }).fill(nextPassword);
    await page.getByLabel('Confirm new password', { exact: true }).fill(nextPassword);
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Password changed.' })).toBeVisible();
    expect((await second.request.get('/api/auth/me')).status()).toBe(401);
    expect((await first.request.get('/api/auth/me')).status()).toBe(200);

    const third = await newContext();
    const fresh = await third.request.post('/api/auth/signin', { data: { email: member.email, password: nextPassword } });
    expect(fresh.status()).toBe(200);
    expect((await (await third.request.get('/api/profile/density')).json()).compact).toBe(true);
    expect((await (await third.request.get('/api/auth/me')).json()).user.name).toBe('ZZ-TEST Updated Member');
    mkdirSync(evidenceDir, { recursive: true });
    await page.screenshot({ path: `${evidenceDir}/synthetic-profile.png`, fullPage: true });

    await page.getByRole('button', { name: 'Sign out everywhere' }).click();
    await expect(page).toHaveURL(/\/signin(?:\?|$)/);
    expect((await first.request.get('/api/auth/me')).status()).toBe(401);
    expect((await third.request.get('/api/auth/me')).status()).toBe(401);
    const bystanderAfter = fingerprint({
      me: (await bystander.c.get('/api/auth/me')).json.user,
      density: (await bystander.c.get('/api/profile/density')).json,
    });
    expect(bystanderAfter).toBe(bystanderBefore);
    writeFileSync(`${evidenceDir}/verification.json`, JSON.stringify({ verifiedMember: true, nameAndDensityPersisted: true, otherSessionRevoked: true, passwordRevokedOtherSession: true, newPasswordAllowed: true, signOutAllRevokedBoth: true, unrelatedAccountFingerprint: bystanderBefore, unrelatedAccountPreserved: true }, null, 2));
  } finally {
    for (const context of contexts) await context.close();
    const problems = await fixture.cleanUp();
    expect(problems).toEqual([]);
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(`${evidenceDir}/cleanup.json`, JSON.stringify({ ownedContextsClosed: true, ownedMembersDeactivated: true, cleanup: true }, null, 2));
  }
});
