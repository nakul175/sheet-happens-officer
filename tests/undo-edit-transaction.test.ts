import { beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  beforeTransaction: () => {}, role: 'EDITOR' as string | null, archived: false, title: 'After', undoneAt: null as Date | null,
  access: vi.fn(), log: vi.fn(), notify: vi.fn(), audit: vi.fn(),
  db: { actionLog: { findUnique: vi.fn(), findMany: vi.fn() }, task: { findFirst: vi.fn() }, user: { findMany: vi.fn() }, section: { findMany: vi.fn() }, $transaction: vi.fn() },
  tx: { actionLog: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() }, task: { findFirst: vi.fn(), update: vi.fn() }, user: { findMany: vi.fn() }, section: { findMany: vi.fn() }, $queryRaw: vi.fn() },
}));
vi.mock('@/lib/db', () => ({ db: m.db }));
vi.mock('@/lib/tasks', () => ({ recordAccess: m.access, deleteTask: vi.fn(), restoreTask: vi.fn() }));
vi.mock('@/lib/records', () => ({ undoRecord: vi.fn() }));
vi.mock('@/lib/notify', () => ({ logAction: m.log, notify: m.notify, auditTx: m.audit }));
import { ApiError } from '@/lib/http';
import { undoAction } from '@/lib/undo';

const actor = { id: 'editor', orgRole: 'MEMBER' as const };
beforeEach(() => {
  vi.clearAllMocks(); m.role = 'EDITOR'; m.archived = false; m.title = 'After'; m.undoneAt = null; m.beforeTransaction = () => {};
  const row = () => ({ id: 'action', projectId: 'project', targetId: 'task', targetType: 'task', action: 'task.updated', actorId: actor.id, beforeState: { title: 'Before' }, afterState: { title: 'After' }, createdAt: new Date(), undoneAt: m.undoneAt });
  const task = () => ({ id: 'task', projectId: 'project', title: m.title, deletedAt: null, updatedAt: new Date(Date.now() - 1000) });
  for (const client of [m.db, m.tx]) {
    client.actionLog.findUnique.mockImplementation(async () => row()); client.actionLog.findMany.mockResolvedValue([]);
    client.task.findFirst.mockImplementation(async () => task());
  }
  m.db.user.findMany.mockResolvedValue([]); m.db.section.findMany.mockResolvedValue([]);
  m.tx.user.findMany.mockResolvedValue([]); m.tx.section.findMany.mockResolvedValue([]);
  m.access.mockImplementation(async () => {
    if (!m.role) throw new ApiError(404, 'Action not found');
    return { role: m.role, project: { id: 'project', archivedAt: m.archived ? new Date() : null } };
  });
  m.tx.$queryRaw.mockResolvedValue([{ id: 'task', projectId: 'project' }]);
  m.tx.task.update.mockImplementation(async ({ data }) => { m.title = data.title ?? m.title; return task(); });
  m.tx.actionLog.update.mockImplementation(async ({ data }) => { m.undoneAt = data.undoneAt; return row(); });
  m.tx.actionLog.updateMany.mockImplementation(async ({ data }) => {
    if (m.undoneAt) return { count: 0 };
    m.undoneAt = data.undoneAt; return { count: 1 };
  });
  m.db.$transaction.mockImplementation(async (fn) => { m.beforeTransaction(); return fn(m.tx); });
});

it('ordinary edit Undo restores the before value and records one reversal', async () => {
  expect(await undoAction(actor, 'action')).toMatchObject({ label: 'Task edited', overrode: false });
  expect(m.title).toBe('Before'); expect(m.undoneAt).not.toBeNull();
  expect(m.log).toHaveBeenCalledOnce(); expect(m.log).toHaveBeenCalledWith(m.tx, expect.objectContaining({ action: 'undo', before: { undoes: 'action', action: 'task.updated' } }));
});

for (const [name, role, status] of [['removed', null, 404], ['downgraded', 'VIEWER', 403]] as const) {
  it(`Undo refuses an actor ${name} after preflight without changing data or activity`, async () => {
    m.beforeTransaction = () => { m.role = role; };
    await expect(undoAction(actor, 'action')).rejects.toMatchObject({ status });
    expect(m.title).toBe('After'); expect(m.undoneAt).toBeNull(); expect(m.log).not.toHaveBeenCalled();
  });
}
it('a newer edit after Undo preflight still requires conflict confirmation', async () => {
  m.beforeTransaction = () => { m.title = 'Newer'; };
  await expect(undoAction(actor, 'action')).rejects.toMatchObject({ status: 409, extra: { needsConfirm: 'conflict' } });
  expect(m.title).toBe('Newer'); expect(m.undoneAt).toBeNull(); expect(m.log).not.toHaveBeenCalled();
});
it('an already-undone action observed after preflight cannot be applied twice', async () => {
  m.beforeTransaction = () => { m.undoneAt = new Date(); };
  await expect(undoAction(actor, 'action')).rejects.toMatchObject({ status: 409 });
  expect(m.title).toBe('After'); expect(m.log).not.toHaveBeenCalled();
});
it('archive after Undo preflight prevents the inverse write', async () => {
  m.beforeTransaction = () => { m.archived = true; };
  await expect(undoAction(actor, 'action')).rejects.toMatchObject({ status: 409 });
  expect(m.title).toBe('After'); expect(m.undoneAt).toBeNull(); expect(m.log).not.toHaveBeenCalled();
});

for (const table of ['Project', 'ProjectMember', 'ActionLog']) {
  it(`a competing ${table} lock returns a conflict without applying Undo`, async () => {
    m.tx.$queryRaw.mockImplementation(async (sql) => {
      if (sql.join('').includes(`FROM "${table}"`)) throw { code: 'P2010', meta: { code: '55P03' } };
      return [{ id: 'task', projectId: 'project' }];
    });
    await expect(undoAction(actor, 'action')).rejects.toMatchObject({ status: 409 });
    expect(m.title).toBe('After'); expect(m.undoneAt).toBeNull(); expect(m.log).not.toHaveBeenCalled();
  });
}
