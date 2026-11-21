import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { account, BASE, PW, type Account } from './helpers';
import { assertLocalFixture } from './e2e/local-fixture-guard';

vi.mock('next/server', () => ({ connection: vi.fn() }));
import { POST } from '@/app/api/suite/password/route';

const prefix = `zzapexlock${randomUUID().replaceAll('-', '')}`;
const secret = 'synthetic-only-accounts-client-0000000000';
const owned: Account[] = [];
const evidenceDir = 'test-results/apex-password-bridge-lockout';
let safe = false;

beforeAll(() => {
  assertLocalFixture(process.env.DATABASE_URL, BASE);
  vi.stubEnv('APLYD_APEX_PASSWORD_BRIDGE', 'true');
  vi.stubEnv('SUITE_ACCOUNTS_CLIENT_SECRET', secret);
  safe = true;
});

afterAll(async () => {
  if (!safe) return;
  const ids = owned.map((person) => person.id);
  const emails = owned.map((person) => person.email);
  let cleanup = false;
  try {
    await db.auditLog.deleteMany({ where: { actorId: { in: ids } } });
    await db.loginAttempt.deleteMany({ where: { email: { in: emails } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
    expect(await db.user.count({ where: { id: { in: ids } } })).toBe(0);
    expect(await db.loginAttempt.count({ where: { email: { in: emails } } })).toBe(0);
    cleanup = true;
  } finally {
    vi.unstubAllEnvs();
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(`${evidenceDir}/cleanup.json`, JSON.stringify({ ownedPeople: ids.length, cleanup }, null, 2));
  }
});

it('serializes concurrent wrong credentials at the bridge lockout boundary', async () => {
  const who = await account(`${prefix}m`); owned.push(who);
  const sentinel = await account(`${prefix}s`); owned.push(sentinel);
  const sentinelBefore = await db.user.findUniqueOrThrow({ where: { id: sentinel.id } });
  const sessionsBefore = await db.session.count({ where: { userId: who.id } });
  const request = (password: string) => new Request('https://sho.example.invalid/api/suite/password', {
    method: 'POST',
    body: JSON.stringify({ client_id: 'accounts', client_secret: secret, user_id: who.id, email: who.email, password }),
  });
  const wrong = `wrong-${randomUUID()}`;
  const responses = await Promise.all(Array.from({ length: 12 }, () => POST(request(wrong))));
  const statuses = responses.map((response) => response.status);
  expect(statuses.filter((status) => status === 403)).toHaveLength(5);
  expect(statuses.filter((status) => status === 429)).toHaveLength(7);
  expect(await db.loginAttempt.count({ where: { email: who.email, success: false } })).toBe(5);
  expect((await POST(request(PW))).status).toBe(429);
  expect(await db.session.count({ where: { userId: who.id } })).toBe(sessionsBefore);
  expect(await db.user.findUniqueOrThrow({ where: { id: sentinel.id } })).toEqual(sentinelBefore);
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(`${evidenceDir}/verification.json`, JSON.stringify({ concurrentRequests: 12, rejected: 5, locked: 7, recordedFailures: 5, validPasswordStillLocked: true, unrelatedSentinelPreserved: true }, null, 2));
});
