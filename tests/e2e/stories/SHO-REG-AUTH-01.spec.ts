import { mkdirSync, writeFileSync } from 'node:fs';
import { test, local2691 } from '../helpers/2691-admin';
import { expect } from './qa';

test('SHO-REG-AUTH-01: production session cookie survives reload and replay is denied', async ({ admin }) => {
  if (!local2691) throw new Error('This cookie case requires the guarded local production-mode server.');
  const evidenceDir = 'test-results/auth-session-cookie';
  const context = admin.page.context();
  const cookie = (await context.cookies()).find((item) => item.name === 'sho_session');
  expect(cookie).toBeDefined();
  expect(cookie!.httpOnly).toBe(true);
  expect(cookie!.secure).toBe(true);
  expect(cookie!.sameSite).toBe('Lax');
  expect(cookie!.path).toBe('/');
  expect(cookie!.expires * 1000 - Date.now()).toBeGreaterThan(29 * 86400_000);
  expect(cookie!.expires * 1000 - Date.now()).toBeLessThan(31 * 86400_000);

  await admin.page.goto('/projects');
  await expect(admin.page).not.toHaveURL(/\/signin(?:\?|$)/);
  expect(await admin.page.evaluate(() => document.cookie.includes('sho_session='))).toBe(false);
  const before = await admin.api.get('/api/auth/me');
  expect(before.status).toBe(200);
  await admin.page.reload();
  await expect(admin.page).not.toHaveURL(/\/signin(?:\?|$)/);
  const after = await admin.api.get('/api/auth/me');
  expect(after.status).toBe(200);
  expect(after.json.user.id).toBe(before.json.user.id);
  expect(await admin.page.evaluate(() => document.cookie.includes('sho_session='))).toBe(false);

  const signout = await admin.api.post('/api/auth/signout');
  expect(signout.status).toBe(204);
  await context.addCookies([{ name: cookie!.name, value: cookie!.value, domain: cookie!.domain, path: cookie!.path, httpOnly: true, secure: true, sameSite: 'Lax' }]);
  expect((await admin.api.get('/api/auth/me')).status).toBe(401);
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(`${evidenceDir}/verification.json`, JSON.stringify({ productionMode: true, httpOnly: true, secure: true, sameSite: 'Lax', path: '/', expiryAbout30Days: true, notVisibleToDocumentCookie: true, identitySurvivedReload: true, replayDeniedAfterSignout: true }, null, 2));
  writeFileSync(`${evidenceDir}/cleanup.json`, JSON.stringify({ sessionRevoked: true, cleanup: true }, null, 2));
});
