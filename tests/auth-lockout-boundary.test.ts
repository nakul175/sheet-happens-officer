// SHO-REG-AUTH-03: lockout stays active just inside the 15-minute window,
// then a correct password succeeds after the failures age beyond it.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { account, BASE, OUTBOX, PW, type Account } from './helpers';
import { assertLocalFixture } from './e2e/local-fixture-guard';

vi.mock('next/server', () => ({ connection: vi.fn() }));
import { POST as signIn } from '@/app/api/auth/signin/route';

const prefix = `zzlockout${randomUUID().replaceAll('-', '')}`;
const evidenceDir = 'test-results/auth-lockout-boundary';
const owned: Account[] = [];
let safe = false;
let verified = false;

beforeAll(() => {
  assertLocalFixture(process.env.DATABASE_URL, BASE);
  if (!resolve(OUTBOX).startsWith(resolve(process.cwd()) + sep)) throw Error('PRIVATE_CHECKOUT_OUTBOX_REQUIRED');
  safe = true;
  mkdirSync(evidenceDir, { recursive: true });
});

afterAll(async () => {
  if (!safe) return;
  const ids = owned.map((person) => person.id);
  const emails = owned.map((person) => person.email);
  let cleanup = false;
  try {
    // Locked probes may have null actorId; discover them by this unique email.
    const locked = await db.auditLog.findMany({ where: { event: 'SIGN_IN_LOCKED' } });
    const lockedIds = locked.filter((row) => row.data && typeof row.data === 'object' && 'email' in row.data && emails.includes(String(row.data.email))).map((row) => row.id);
    await db.auditLog.deleteMany({ where: { OR: [{ actorId: { in: ids } }, { id: { in: lockedIds } }] } });
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
    expect(await db.auditLog.count({ where: { id: { in: lockedIds } } })).toBe(0);
    cleanup = true;
  } finally {
    writeFileSync(`${evidenceDir}/cleanup.json`, JSON.stringify({ verified, cleanup, ownedPeople: ids.length }, null, 2));
  }
});

it('locks on the fifth failure, denies a sixth and recovers beyond the window', async () => {
  const who = await account(`${prefix}member`); owned.push(who);
  const sentinel = await account(`${prefix}sentinel`); owned.push(sentinel);
  expect((await db.user.findUniqueOrThrow({ where: { id: who.id } })).orgRole).toBe('MEMBER');
  const sentinelBefore = await db.user.findUniqueOrThrow({ where: { id: sentinel.id } });
  const successfulSigninsBefore = await db.auditLog.count({ where: { event: 'SIGN_IN', actorId: who.id } });
  const wrongPassword = `wrong-${randomUUID()}`;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const reply = await who.c.post('/api/auth/signin', { email: who.email, password: wrongPassword });
    expect(reply.status, `failure ${attempt}`).toBe(401);
  }
  expect(await db.loginAttempt.count({ where: { email: who.email, success: false } })).toBe(5);
  const sixth = await who.c.post('/api/auth/signin', { email: who.email, password: PW });
  expect(sixth.status).toBe(429);
  expect(sixth.json).toEqual({ error: 'Too many attempts. Try again in 15 minutes.' });

  const insideWindow = new Date(Date.now() - 15 * 60_000 + 10_000);
  await db.loginAttempt.updateMany({ where: { email: who.email }, data: { createdAt: insideWindow } });
  expect((await who.c.post('/api/auth/signin', { email: who.email, password: PW })).status).toBe(429);
  const outsideWindow = new Date(Date.now() - 15 * 60_000 - 10_000);
  await db.loginAttempt.updateMany({ where: { email: who.email }, data: { createdAt: outsideWindow } });
  const recovered = await who.c.post('/api/auth/signin', { email: who.email, password: PW });
  expect(recovered.status).toBe(200);
  expect(recovered.json.user.id).toBe(who.id);
  expect(await db.loginAttempt.count({ where: { email: who.email } })).toBe(0);
  expect(await db.auditLog.count({ where: { event: 'SIGN_IN', actorId: who.id } })).toBe(successfulSigninsBefore + 1);

  const authEvents = await db.auditLog.findMany({ where: { event: { in: ['SIGN_IN_FAILED', 'SIGN_IN_LOCKED'] } } });
  const events = authEvents.filter((row) => row.data && typeof row.data === 'object' && 'email' in row.data && row.data.email === who.email);
  expect(events.filter((row) => row.event === 'SIGN_IN_FAILED')).toHaveLength(5);
  expect(events.filter((row) => row.event === 'SIGN_IN_LOCKED')).toHaveLength(3);
  expect(JSON.stringify(events)).not.toContain(wrongPassword);
  expect(await db.user.findUniqueOrThrow({ where: { id: sentinel.id } })).toEqual(sentinelBefore);

  verified = true;
  writeFileSync(`${evidenceDir}/verification.json`, JSON.stringify({ fifthFailure: 401, sixthAttempt: 429, insideWindow: 429, outsideWindow: 200, failedAttempts: 5, lockedAuditRows: 3, failedAuditRows: 5, attemptsClearedOnRecovery: true, unrelatedSentinelPreserved: true }, null, 2));
});

it('serializes concurrent failures at the per-email lockout boundary', async () => {
  // The helper appends a timestamp; keep the local part below the email limit.
  const who = await account(`${prefix}r`); owned.push(who);
  const sentinel = await account(`${prefix}s`); owned.push(sentinel);
  const sentinelBefore = await db.user.findUniqueOrThrow({ where: { id: sentinel.id } });
  const wrongPassword = `wrong-${randomUUID()}`;
  const replies = await Promise.all(Array.from({ length: 12 }, () => who.c.post('/api/auth/signin', { email: who.email, password: wrongPassword })));
  const statuses = replies.map((reply) => reply.status);
  expect(statuses.filter((status) => status === 401)).toHaveLength(5);
  expect(statuses.filter((status) => status === 429)).toHaveLength(7);
  expect(await db.loginAttempt.count({ where: { email: who.email, success: false } })).toBe(5);
  expect((await who.c.post('/api/auth/signin', { email: who.email, password: PW })).status).toBe(429);
  expect(await db.user.findUniqueOrThrow({ where: { id: sentinel.id } })).toEqual(sentinelBefore);
  writeFileSync(`${evidenceDir}/race-verification.json`, JSON.stringify({ concurrentRequests: 12, invalidResponses: 5, lockedResponses: 7, recordedFailures: 5, correctPasswordStillLocked: true, unrelatedSentinelPreserved: true }, null, 2));
});

it('expires a failure exactly at the 15-minute cutoff', async () => {
  const who = await account(`${prefix}cutoff`); owned.push(who);
  const wrongPassword = `wrong-${randomUUID()}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    expect((await who.c.post('/api/auth/signin', { email: who.email, password: wrongPassword })).status).toBe(401);
  }
  const fixedNow = Date.now();
  const cutoff = fixedNow - 15 * 60_000;
  const now = vi.spyOn(Date, 'now').mockReturnValue(fixedNow);
  // Invoke the route in this process so the fixed clock also controls its count query.
  const request = () => new Request(`${BASE}/api/auth/signin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: who.email, password: wrongPassword }),
  });
  try {
    await db.loginAttempt.updateMany({ where: { email: who.email }, data: { createdAt: new Date(cutoff + 1) } });
    expect((await signIn(request())).status).toBe(429);
    await db.loginAttempt.updateMany({ where: { email: who.email }, data: { createdAt: new Date(cutoff) } });
    const expired = await signIn(request());
    expect(expired.status).toBe(401);
    expect(await db.loginAttempt.count({ where: { email: who.email } })).toBe(6);
    writeFileSync(`${evidenceDir}/exact-cutoff.json`, JSON.stringify({ windowMinutes: 15, oneMillisecondInside: 429, exactlyAtCutoff: 401, expiredAttemptsIgnored: true }, null, 2));
  } finally {
    now.mockRestore();
  }
});
