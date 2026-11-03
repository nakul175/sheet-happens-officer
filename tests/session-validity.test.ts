import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ session: vi.fn(), workspace: vi.fn(), link: vi.fn(), active: vi.fn(), touch: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: { session: { findUnique: m.session, update: m.touch }, workspace: { findMany: m.workspace }, centralSessionLink: { findUnique: m.link } } }));
vi.mock('@/lib/central-status', () => ({ centralSessionActive: m.active }));
import { sessionUser } from '@/lib/auth';

const now = new Date('2026-11-03T00:00:00.000Z');
const user = () => ({ id: 'synthetic-user', workspaceId: 'one', emailVerifiedAt: new Date(0), deactivatedAt: null, tempPasswordAt: null });
const session = () => ({ id: 'synthetic-session', expiresAt: new Date(now.getTime() + 1), revokedAt: null, lastSeenAt: now, user: user() });
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
  m.session.mockResolvedValue(session()); m.workspace.mockResolvedValue([{ id: 'one' }]); m.link.mockResolvedValue(null); m.active.mockResolvedValue(true);
});
afterEach(() => vi.useRealTimers());

it('a native session remains valid one millisecond before fixed expiry', async () => {
  expect(await sessionUser('synthetic-token')).toMatchObject({ id: 'synthetic-user' });
  expect(m.touch).not.toHaveBeenCalled();
});
for (const delta of [0, -1]) it(`fixed expiry at now${delta}ms is denied without extending the session`, async () => {
  m.session.mockResolvedValue({ ...session(), expiresAt: new Date(now.getTime() + delta) });
  await expect(sessionUser('synthetic-token')).rejects.toMatchObject({ status: 401 });
  expect(m.touch).not.toHaveBeenCalled(); expect(m.active).not.toHaveBeenCalled();
});
for (const reason of ['revoked', 'deactivated', 'unverified'] as const) it(`${reason} identity fails before central authority or activity updates`, async () => {
  const row = session();
  m.session.mockResolvedValue({ ...row, ...(reason === 'revoked' ? { revokedAt: now } : {}), user: { ...row.user, ...(reason === 'deactivated' ? { deactivatedAt: now } : {}), ...(reason === 'unverified' ? { emailVerifiedAt: null } : {}) } });
  await expect(sessionUser('synthetic-token')).rejects.toMatchObject({ status: 401 });
  expect(m.touch).not.toHaveBeenCalled(); expect(m.active).not.toHaveBeenCalled();
});
it('a central-linked session requires its exact live subject/session/native binding on every request', async () => {
  m.link.mockResolvedValue({ subject: 'synthetic-subject', sessionUid: 'synthetic-uid' });
  expect(await sessionUser('synthetic-token')).toMatchObject({ id: 'synthetic-user' });
  expect(m.active).toHaveBeenLastCalledWith('synthetic-subject', 'synthetic-uid', 'synthetic-user');
  m.active.mockResolvedValue(false);
  await expect(sessionUser('synthetic-token')).rejects.toMatchObject({ status: 401 });
  expect(m.active).toHaveBeenCalledTimes(2); expect(m.touch).not.toHaveBeenCalled();
});
it('activity refresh never changes the fixed expiry', async () => {
  m.session.mockResolvedValue({ ...session(), lastSeenAt: new Date(now.getTime() - 301_000) });
  await sessionUser('synthetic-token');
  expect(m.touch).toHaveBeenCalledWith({ where: { id: 'synthetic-session' }, data: { lastSeenAt: now } });
});
