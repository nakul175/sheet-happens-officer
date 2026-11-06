// SHO-REG-AUTH-02: unknown and known-account failures have the same public answer
// and distinct, secret-free audit records. Runs only on the disposable local CI DB.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { account, BASE, OUTBOX, type Account } from './helpers';
import { assertLocalFixture } from './e2e/local-fixture-guard';

const prefix = `zzauthfail${randomUUID().replaceAll('-', '')}`;
const unknownEmail = `${prefix}unknown@aplyd.com`;
const wrongPassword = `wrong-${randomUUID()}`;
const evidenceDir = 'test-results/auth-failure-audit';
const owned: Account[] = [];
let failedAuditIds: string[] = [];
let safe = false;
let verified = false;

beforeAll(() => {
  assertLocalFixture(process.env.DATABASE_URL, BASE);
  if (!resolve(OUTBOX).startsWith(resolve(process.cwd()) + sep)) throw Error('PRIVATE_CHECKOUT_OUTBOX_REQUIRED');
  if (!existsSync('server.log')) throw Error('LOCAL_SERVER_LOG_REQUIRED');
  safe = true;
  mkdirSync(evidenceDir, { recursive: true });
});

afterAll(async () => {
  if (!safe) return;
  const ids = owned.map((person) => person.id);
  const emails = [...owned.map((person) => person.email), unknownEmail];
  let cleanup = false;
  try {
    // Find the null-actor unknown-account row even if an earlier assertion failed.
    const unknownRows = await db.auditLog.findMany({ where: { event: 'SIGN_IN_FAILED', actorId: null } });
    const unknownIds = unknownRows.filter((row) => row.data && typeof row.data === 'object' && 'email' in row.data && row.data.email === unknownEmail).map((row) => row.id);
    failedAuditIds = [...new Set([...failedAuditIds, ...unknownIds])];
    await db.auditLog.deleteMany({ where: { OR: [{ actorId: { in: ids } }, { id: { in: failedAuditIds } }] } });
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
    expect(await db.auditLog.count({ where: { id: { in: failedAuditIds } } })).toBe(0);
    cleanup = true;
  } finally {
    writeFileSync(`${evidenceDir}/cleanup.json`, JSON.stringify({ verified, cleanup, ownedPeople: ids.length, failedAuditRows: failedAuditIds.length }, null, 2));
  }
});

it('returns the same generic 401 and records both failures without leaking the password', async () => {
  const known = await account(`${prefix}known`); owned.push(known);
  const sentinel = await account(`${prefix}sentinel`); owned.push(sentinel);
  expect((await db.user.findUniqueOrThrow({ where: { id: known.id } })).orgRole).toBe('MEMBER');
  const sentinelBefore = await db.user.findUniqueOrThrow({ where: { id: sentinel.id } });
  const started = new Date(Date.now() - 1000);
  const body = { password: wrongPassword };
  const knownReply = await known.c.post('/api/auth/signin', { email: known.email, ...body });
  const unknownReply = await known.c.post('/api/auth/signin', { email: unknownEmail, ...body });

  expect(knownReply.status).toBe(401);
  expect(unknownReply.status).toBe(401);
  expect(knownReply.json).toEqual(unknownReply.json);
  expect(knownReply.json).toEqual({ error: 'Email or password is incorrect.' });
  expect(knownReply.setCookie).toBeNull();
  expect(unknownReply.setCookie).toBeNull();
  expect(JSON.stringify([knownReply.json, unknownReply.json])).not.toContain(wrongPassword);

  const attempts = await db.loginAttempt.findMany({ where: { email: { in: [known.email, unknownEmail] } } });
  expect(attempts).toHaveLength(2);
  expect(attempts.map((row) => [row.email, row.success]).sort()).toEqual([[known.email, false], [unknownEmail, false]].sort());
  const auditRows = (await db.auditLog.findMany({ where: { event: 'SIGN_IN_FAILED', createdAt: { gte: started } } }))
    .filter((row) => row.data && typeof row.data === 'object' && 'email' in row.data && [known.email, unknownEmail].includes(String(row.data.email)));
  failedAuditIds = auditRows.map((row) => row.id);
  expect(auditRows).toHaveLength(2);
  expect(auditRows.map((row) => [String((row.data as { email: string }).email), row.actorId]).sort())
    .toEqual([[known.email, known.id], [unknownEmail, null]].sort());
  expect(JSON.stringify(auditRows)).not.toContain(wrongPassword);
  expect(readFileSync('server.log', 'utf8')).not.toContain(wrongPassword);
  expect(await db.user.findUniqueOrThrow({ where: { id: sentinel.id } })).toEqual(sentinelBefore);

  verified = true;
  writeFileSync(`${evidenceDir}/verification.json`, JSON.stringify({ knownAndUnknown: 'same generic 401', noCookieIssued: true, failureAttempts: 2, failedAuditRows: 2, secretAbsentFromResponsesAuditAndServerLog: true, unrelatedSentinelPreserved: true }, null, 2));
});
