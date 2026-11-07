import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { test, local2691 } from '../helpers/2691-admin';
import { BASE, Client, OUTBOX, PW } from '../local-api';
import { expect } from './qa';

test('SHO-REG-AUTH-05: scanner GET leaves verification untouched; one browser click consumes it without sign-in', async ({ admin, browser }) => {
  if (!local2691 || !['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL ?? '').hostname) ||
    !/^\/sho_test(?:_[\w-]+)?$/.test(new URL(process.env.DATABASE_URL ?? '').pathname) || process.env.TASKBOARD_URL !== BASE)
    throw new Error('Verification audit requires the guarded local server and disposable database.');
  const fixture = randomUUID();
  const email = `nakul17+zz-reg-auth05-${fixture}@aplyd.com`;
  const directory = 'test-results/auth-verification-replay';
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const context = await browser.newContext({ baseURL: BASE });
  const createdMailFiles: string[] = [];
  let userId = '';
  try {
    const signup = await new Client().post('/api/auth/signup', { name: 'ZZ-TEST Verification audit', email, password: PW });
    expect(signup.status).toBe(201);
    expect(signup.json.emailSent).toBe(true);
    const user = await pool.query<{ id: string; emailVerifiedAt: Date | null }>('SELECT id, "emailVerifiedAt" FROM "User" WHERE email=$1', [email]);
    expect(user.rows).toHaveLength(1);
    userId = user.rows[0].id;
    expect(user.rows[0].emailVerifiedAt).toBeNull();
    let token = '';
    for (const filename of readdirSync(OUTBOX)) {
      const file = path.join(OUTBOX, filename);
      let mail: { to?: string; subject?: string; text?: string };
      try { mail = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
      if (mail.to !== email) continue;
      createdMailFiles.push(file);
      if (mail.subject?.includes('Verify')) token = mail.text?.match(/token=([\w-]+)/)?.[1] ?? '';
    }
    expect(token).toMatch(/^[\w-]{43}$/);
    const hash = createHash('sha256').update(token).digest('hex');
    const state = () => pool.query<{ emailVerifiedAt: Date | null; usedAt: Date | null }>(
      'SELECT u."emailVerifiedAt", t."usedAt" FROM "User" u JOIN "AuthToken" t ON t."userId"=u.id WHERE u.id=$1 AND t."tokenHash"=$2', [userId, hash]);
    const page = await context.newPage();
    const scanner = await page.goto(`/verify?token=${token}`);
    expect(scanner?.status()).toBe(200);
    await expect(page.getByRole('button', { name: 'Verify my email' })).toBeEnabled();
    expect((await state()).rows).toEqual([{ emailVerifiedAt: null, usedAt: null }]);
    expect((await context.request.get('/api/auth/me')).status()).toBe(401);
    await page.getByRole('button', { name: 'Verify my email' }).click();
    await expect(page.getByRole('heading', { name: 'Email verified' })).toBeVisible();
    const verified = (await state()).rows;
    expect(verified).toHaveLength(1);
    expect(verified[0].emailVerifiedAt).not.toBeNull();
    expect(verified[0].usedAt).not.toBeNull();
    expect((await context.request.get('/api/auth/me')).status()).toBe(401);
    expect((await context.request.post('/api/auth/verify', { data: { token } })).status()).toBe(400);
    mkdirSync(directory, { recursive: true });
    writeFileSync(`${directory}/verification.json`, JSON.stringify({ fixture, scannerDidNotVerify: true, browserClickVerified: true,
      tokenConsumedOnce: true, replayDenied: true, signedOutThroughout: true, disposableDatabase: true }, null, 2));
  } finally {
    await context.close();
    if (userId) {
      expect((await admin.api.post(`/api/team/${userId}/deactivate`, { reassign: 'leaders' })).status).toBe(200);
      const result = await pool.query<{ deactivatedAt: Date | null }>('SELECT "deactivatedAt" FROM "User" WHERE id=$1', [userId]);
      expect(result.rows[0]?.deactivatedAt).not.toBeNull();
    }
    for (const file of createdMailFiles) unlinkSync(file);
    await pool.end();
    mkdirSync(directory, { recursive: true });
    writeFileSync(`${directory}/cleanup.json`, JSON.stringify({ fixture, userDeactivated: Boolean(userId), ownedOutboxRemoved: true, cleanup: true }, null, 2));
  }
});
