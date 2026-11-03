// Native session denial matrix against the disposable local application only.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { db } from '@/lib/db';
import { account, BASE, OUTBOX, project, type Account } from './helpers';
import { assertLocalFixture } from './e2e/local-fixture-guard';

const prefix = 'zzsession' + randomUUID().replaceAll('-', '');
const accounts: Account[] = [], projects: string[] = [];
const evidence: { scenario: string; method: string; path: string; result: string }[] = [];
let safe = false, browser: Browser | undefined, sentinel: Account;
beforeAll(async () => {
  assertLocalFixture(process.env.DATABASE_URL, BASE);
  if (!resolve(OUTBOX).startsWith(resolve(process.cwd()) + sep)) throw Error('PRIVATE_CHECKOUT_OUTBOX_REQUIRED');
  safe = true;
  mkdirSync('test-results/session-validity', { recursive: true });
  browser = await chromium.launch({ headless: true });
  sentinel = await account(prefix + 'sentinel'); accounts.push(sentinel);
});
afterAll(async () => {
  await browser?.close();
  if (!safe) return;
  let cleanup = false;
  try {
    if (sentinel) expect((await sentinel.c.get('/api/auth/me')).status).toBe(200);
  } finally {
    try {
      const ids = accounts.map((a) => a.id), emails = accounts.map((a) => a.email);
      await db.notification.deleteMany({ where: { projectId: { in: projects } } });
      await db.actionLog.deleteMany({ where: { projectId: { in: projects } } });
      await db.project.deleteMany({ where: { id: { in: projects } } });
      await db.auditLog.deleteMany({ where: { actorId: { in: ids } } });
      await db.loginAttempt.deleteMany({ where: { email: { in: emails } } });
      await db.user.deleteMany({ where: { id: { in: ids } } });
      for (const name of readdirSync(OUTBOX)) {
        if (!name.endsWith('.json')) continue;
        const path = resolve(OUTBOX, name), mail = JSON.parse(readFileSync(path, 'utf8'));
        if (emails.includes(mail.to)) rmSync(path);
      }
      expect(await db.user.count({ where: { id: { in: ids } } })).toBe(0);
      expect(await db.project.count({ where: { id: { in: projects } } })).toBe(0);
      cleanup = true;
    } finally {
      mkdirSync('test-results/session-validity', { recursive: true });
      writeFileSync('test-results/session-validity/matrix.json', JSON.stringify({ fixture: prefix, scope: 'native-local-http-and-browser', centralAuthority: 'component-tested-separately; no external Accounts access', cleanup, probes: evidence }, null, 2));
    }
  }
});

for (const scenario of ['expired', 'revoked', 'deactivated', 'unverified'] as const) {
  it(`${scenario}: the original cookie cannot read/write private APIs or enter protected pages`, async () => {
    const who = await account(prefix + scenario); accounts.push(who);
    const privateMarker = prefix + '-private-' + scenario;
    const p = await project(who, who, [], privateMarker); projects.push(p.id);
    const originalCookie = who.c.cookie;
    const token = originalCookie.slice(originalCookie.indexOf('=') + 1);
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const session = await db.session.findUniqueOrThrow({ where: { tokenHash } });
    const context = await browser!.newContext({ baseURL: BASE });
    // Block any external navigation/subresource; no real identity provider is used.
    await context.route('**/*', (route) => new URL(route.request().url()).origin === new URL(BASE).origin ? route.continue() : route.abort());
    await context.addCookies([{ name: 'sho_session', value: token, url: BASE, httpOnly: true, sameSite: 'Lax' }]);
    const page = await context.newPage();
    try {
      await page.goto(`/projects/${p.id}`);
      await page.getByRole('heading', { name: privateMarker, exact: true }).waitFor({ state: 'visible' });
      await page.screenshot({ path: `test-results/session-validity/${scenario}-valid.png`, fullPage: true });
      if (scenario === 'expired') await db.session.update({ where: { id: session.id }, data: { expiresAt: new Date(0) } });
      if (scenario === 'revoked') await db.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
      if (scenario === 'deactivated') await db.user.update({ where: { id: who.id }, data: { deactivatedAt: new Date() } });
      if (scenario === 'unverified') await db.user.update({ where: { id: who.id }, data: { emailVerifiedAt: null } });
      const beforeUser = await db.user.findUniqueOrThrow({ where: { id: who.id } });
      const beforeProject = await db.project.findUniqueOrThrow({ where: { id: p.id } });
      const beforeActions = await db.actionLog.count({ where: { actorId: who.id } });
      const calls: [string, string, unknown?][] = [
        ['GET', '/api/auth/me'], ['GET', '/api/projects'], ['POST', '/api/projects', { name: 'Denied', leaderId: who.id }],
        ['GET', `/api/projects/${p.id}`], ['PATCH', `/api/projects/${p.id}`, { name: 'Denied' }], ['GET', '/api/my-tasks'],
        ['GET', '/api/team'], ['GET', `/api/team/${who.id}`], ['GET', '/api/notifications'], ['POST', '/api/notifications/read-all', {}],
        ['GET', '/api/search?q=private'], ['PATCH', '/api/profile', { name: 'Denied' }], ['GET', '/api/profile/density'],
        ['PUT', '/api/profile/density', { compact: true }], ['GET', '/api/profile/sessions'], ['POST', '/api/profile/sessions/sign-out-others', {}],
        ['POST', '/api/profile/start-guide', {}], ['GET', '/api/deals'], ['GET', '/api/orgs'], ['GET', '/api/leaders'],
        ['GET', '/api/review'], ['GET', '/api/quick-add?text=x'], ['GET', '/api/audit'], ['POST', '/api/actions/bulk-undo', { ids: ['synthetic-missing'] }],
      ];
      for (const [method, path, body] of calls) {
        // Deliberately keep the same invalid cookie despite any Set-Cookie response.
        const response = await fetch(BASE + path, { method, redirect: 'manual', headers: { cookie: originalCookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
        expect(response.status, method + ' ' + path).toBe(401);
        expect(await response.json()).toEqual({ error: 'Not signed in' });
        evidence.push({ scenario, method, path, result: '401_NO_PRIVATE_DATA' });
      }
      for (const path of ['/projects', `/projects/${p.id}`, '/my-tasks', '/team', '/profile']) {
        // Reinstall the original cookie before every navigation as well.
        await context.addCookies([{ name: 'sho_session', value: token, url: BASE, httpOnly: true, sameSite: 'Lax' }]);
        const response = await page.goto(path);
        await page.waitForURL((url) => url.pathname === '/signin', { timeout: 10_000 });
        expect(await page.locator('body').innerText()).not.toContain(privateMarker);
        if (response) expect(await response.text()).not.toContain(privateMarker);
        evidence.push({ scenario, method: 'BROWSER', path, result: 'SIGNIN_NO_PRIVATE_DATA' });
      }
      expect(await db.user.findUniqueOrThrow({ where: { id: who.id } })).toEqual(beforeUser);
      expect(await db.project.findUniqueOrThrow({ where: { id: p.id } })).toEqual(beforeProject);
      expect(await db.actionLog.count({ where: { actorId: who.id } })).toBe(beforeActions);
      expect((await db.session.findUniqueOrThrow({ where: { id: session.id } })).lastSeenAt).toEqual(session.lastSeenAt);
      await page.screenshot({ path: `test-results/session-validity/${scenario}-denied.png`, fullPage: true });
    } catch (error) {
      await page.screenshot({ path: `test-results/session-validity/${scenario}-failure.png`, fullPage: true }).catch(() => {});
      throw error;
    } finally { await context.close(); }
  }, 60_000);
}
