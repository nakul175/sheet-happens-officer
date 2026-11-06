// SHO-REG-AUTH-06: a password reset revokes every pre-existing browser session.
// Guarded synthetic database and two independent Chromium cookie jars only.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { account, BASE, Client, OUTBOX, PW, type Account } from './helpers';
import { assertLocalFixture } from './e2e/local-fixture-guard';

const prefix = `zzresetmulti${randomUUID().replaceAll('-', '')}`;
const newPassword = `new-${randomUUID()}`;
const evidenceDir = 'test-results/auth-reset-multi-session';
const owned: Account[] = [];
const contexts: BrowserContext[] = [];
let browser: Browser | undefined;
let safe = false;
let verified = false;

beforeAll(async () => {
  assertLocalFixture(process.env.DATABASE_URL, BASE);
  if (!resolve(OUTBOX).startsWith(resolve(process.cwd()) + sep)) throw Error('PRIVATE_CHECKOUT_OUTBOX_REQUIRED');
  safe = true;
  mkdirSync(evidenceDir, { recursive: true });
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  const closeFailures: unknown[] = [];
  for (const context of contexts) try { await context.close(); } catch (error) { closeFailures.push(error); }
  try { await browser?.close(); } catch (error) { closeFailures.push(error); }
  if (!safe) return;
  const ids = owned.map((person) => person.id);
  const emails = owned.map((person) => person.email);
  let cleanup = false;
  try {
    const nullActorRows = await db.auditLog.findMany({ where: { event: 'SIGN_IN_LOCKED', actorId: null } });
    const nullActorIds = nullActorRows.filter((row) => row.data && typeof row.data === 'object' && 'email' in row.data && emails.includes(String(row.data.email))).map((row) => row.id);
    await db.auditLog.deleteMany({ where: { OR: [{ actorId: { in: ids } }, { id: { in: nullActorIds } }] } });
    await db.loginAttempt.deleteMany({ where: { email: { in: emails } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
    for (const name of readdirSync(OUTBOX)) {
      if (!name.endsWith('.json')) continue;
      const file = resolve(OUTBOX, name);
      const mail = JSON.parse(readFileSync(file, 'utf8')) as { to?: string };
      if (mail.to && emails.includes(mail.to)) rmSync(file);
    }
    expect(await db.user.count({ where: { id: { in: ids } } })).toBe(0);
    expect(await db.loginAttempt.count({ where: { email: { in: emails } } })).toBe(0);
    cleanup = true;
  } finally {
    writeFileSync(`${evidenceDir}/cleanup.json`, JSON.stringify({ verified, cleanup, ownedPeople: ids.length, browserContexts: contexts.length }, null, 2));
  }
  if (closeFailures.length) throw new AggregateError(closeFailures, 'Owned Chromium contexts did not all close');
});

it('revokes both browser cookies, the earlier API session and the reset token', async () => {
  const who = await account(`${prefix}member`); owned.push(who);
  const sentinel = await account(`${prefix}sentinel`); owned.push(sentinel);
  expect((await db.user.findUniqueOrThrow({ where: { id: who.id } })).orgRole).toBe('MEMBER');
  const sentinelBefore = await db.user.findUniqueOrThrow({ where: { id: sentinel.id } });
  for (let i = 0; i < 2; i++) {
    const context = await browser!.newContext({ baseURL: BASE }); contexts.push(context);
    await context.route('**/*', (route) => new URL(route.request().url()).origin === new URL(BASE).origin ? route.continue() : route.abort());
    const signIn = await context.request.post('/api/auth/signin', { data: { email: who.email, password: PW } });
    expect(signIn.status()).toBe(200);
    const page = await context.newPage();
    await page.goto('/projects');
    expect(new URL(page.url()).pathname).toBe('/projects');
  }
  const oldSessions = await db.session.findMany({ where: { userId: who.id, revokedAt: null }, select: { id: true } });
  expect(oldSessions).toHaveLength(3);

  const anon = new Client();
  for (let i = 0; i < 5; i++) expect((await anon.post('/api/auth/signin', { email: who.email, password: 'wrong-pass-1' })).status).toBe(401);
  expect((await anon.post('/api/auth/signin', { email: who.email, password: PW })).status).toBe(429);
  expect((await anon.post('/api/auth/forgot-password', { email: who.email })).status).toBe(200);
  const mails = readdirSync(OUTBOX).filter((name) => name.endsWith('.json')).sort().map((name) => JSON.parse(readFileSync(resolve(OUTBOX, name), 'utf8')) as { to?: string; subject?: string; text?: string });
  const resetMail = mails.filter((mail) => mail.to === who.email && /Reset/i.test(mail.subject ?? '')).at(-1);
  const token = resetMail?.text?.match(/token=([\w-]+)/)?.[1];
  expect(token).toBeTruthy();

  expect((await anon.post('/api/auth/reset-password', { token, password: newPassword, confirm: newPassword })).status).toBe(200);
  expect((await anon.post('/api/auth/reset-password', { token, password: newPassword, confirm: newPassword })).status).toBe(400);
  expect((await who.c.get('/api/auth/me')).status).toBe(401);
  for (const context of contexts) {
    expect((await context.request.get('/api/auth/me')).status()).toBe(401);
    const page = context.pages()[0];
    await page.goto('/projects');
    await page.waitForURL((url) => url.pathname === '/signin', { timeout: 10_000 });
  }
  const oldRows = await db.session.findMany({ where: { id: { in: oldSessions.map((row) => row.id) } }, select: { revokedAt: true } });
  expect(oldRows).toHaveLength(3);
  expect(oldRows.every((row) => row.revokedAt !== null)).toBe(true);
  expect(await db.loginAttempt.count({ where: { email: who.email } })).toBe(0);
  expect((await new Client().post('/api/auth/signin', { email: who.email, password: PW })).status).toBe(401);
  const fresh = await new Client().post('/api/auth/signin', { email: who.email, password: newPassword });
  expect(fresh.status).toBe(200);
  expect(fresh.json.user.id).toBe(who.id);
  expect(await db.user.findUniqueOrThrow({ where: { id: sentinel.id } })).toEqual(sentinelBefore);

  verified = true;
  writeFileSync(`${evidenceDir}/verification.json`, JSON.stringify({ oldSessions: 3, browserContexts: 2, oldBrowserApiDenied: true, oldBrowserDocumentsRedirected: true, allStoredSessionsRevoked: true, resetTokenReplayDenied: true, oldPasswordDenied: true, newPasswordAccepted: true, lockoutCleared: true, unrelatedSentinelPreserved: true }, null, 2));
}, 60_000);
