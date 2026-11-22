import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  kind: 'task.deleted', deleted: true, claimed: false, fail: false,
  db: { actionLog: { findUnique: vi.fn() }, task: { findFirst: vi.fn() }, $transaction: vi.fn() },
  tx: { actionLog: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() }, task: { findFirst: vi.fn(), findUnique: vi.fn() }, $queryRaw: vi.fn() },
  restore: vi.fn(), remove: vi.fn(), log: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ db: m.db }));
vi.mock('@/lib/tasks', () => ({ recordAccess: vi.fn(async () => ({ role: 'LEADER', project: { archivedAt: null } })), restoreTask: m.restore, deleteTask: m.remove }));
vi.mock('@/lib/records', () => ({ undoRecord: vi.fn() }));
vi.mock('@/lib/notify', () => ({ logAction: m.log, notify: vi.fn(), auditTx: vi.fn() }));
import { undoAction } from '@/lib/undo';
const actor = { id: 'leader', orgRole: 'MEMBER' as const };
beforeEach(() => {
  vi.clearAllMocks(); m.fail = false; m.claimed = false;
  const row = () => ({ id: 'action', projectId: 'project', targetId: 'task', targetType: 'task', action: m.kind, actorId: actor.id, createdAt: new Date(), undoneAt: m.claimed ? new Date() : null });
  const task = () => ({ id: 'task', projectId: 'project', parentId: null, title: 'Task', deletedAt: m.deleted ? new Date() : null });
  for (const client of [m.db, m.tx]) { client.actionLog.findUnique.mockImplementation(async () => row()); client.task.findFirst.mockImplementation(async () => task()); }
  m.tx.task.findUnique.mockImplementation(async () => task());
  m.tx.$queryRaw.mockResolvedValue([{ id: 'task', projectId: 'project' }]);
  m.tx.actionLog.update.mockImplementation(async () => { m.claimed = true; return row(); });
  m.tx.actionLog.updateMany.mockImplementation(async () => { if (m.claimed) return { count: 0 }; m.claimed = true; return { count: 1 }; });
  m.restore.mockImplementation(async () => { m.deleted = false; }); m.remove.mockImplementation(async () => { m.deleted = true; });
  m.log.mockImplementation(async () => { if (m.fail) throw Error('ACTIVITY_WRITE_FAILED'); });
  m.db.$transaction.mockImplementation(async (fn) => {
    const before = { deleted: m.deleted, claimed: m.claimed };
    try { return await fn(m.tx); } catch (e) { Object.assign(m, before); throw e; }
  });
});
for (const kind of ['task.deleted', 'task.created', 'task.restored']) {
  it(`${kind}: failed Undo activity rolls back the inverse and leaves retry possible`, async () => {
    m.kind = kind; m.deleted = kind === 'task.deleted'; const before = m.deleted; m.fail = true;
    await expect(undoAction(actor, 'action')).rejects.toThrow('ACTIVITY_WRITE_FAILED');
    expect(m.deleted).toBe(before); expect(m.claimed).toBe(false);
    m.fail = false; await undoAction(actor, 'action'); expect(m.deleted).toBe(!before); expect(m.claimed).toBe(true);
  });
}
