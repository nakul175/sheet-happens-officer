import { beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  beforeTransaction: () => {},
  role: 'EDITOR' as string | null,
  archived: false,
  version: new Date('2026-10-25T00:00:00.000Z'),
  db: { task: { findUnique: vi.fn() }, project: { findUnique: vi.fn() }, actionLog: { findFirst: vi.fn() }, $transaction: vi.fn() },
  tx: { task: { findUnique: vi.fn(), update: vi.fn() }, project: { findUnique: vi.fn() }, actionLog: { findFirst: vi.fn() }, $queryRaw: vi.fn() },
  log: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ db: m.db }));
vi.mock('@/lib/notify', () => ({ notify: vi.fn(), logAction: m.log, auditTx: vi.fn() }));
vi.mock('@/lib/deals', () => ({ ensureNextStep: vi.fn() }));
vi.mock('@/lib/records', () => ({ linksOfTask: vi.fn() }));
import { updateTask } from '@/lib/tasks';

const actor = { id: 'editor', orgRole: 'MEMBER' as const };
const version = '2026-10-25T00:00:00.000Z';
beforeEach(() => {
  vi.clearAllMocks(); m.role = 'EDITOR'; m.archived = false; m.version = new Date(version); m.beforeTransaction = () => {};
  const row = () => ({ id: 'task', projectId: 'project', title: 'Original', updatedAt: m.version, deletedAt: null, approverId: null, assigneeId: 'leader', collaborators: [], subtasks: [] });
  const project = () => ({ id: 'project', typeId: 'wst_project', deletedAt: null, archivedAt: m.archived ? new Date() : null, members: m.role ? [{ userId: 'editor', role: m.role }] : [], actionLogs: [] });
  m.db.task.findUnique.mockImplementation(async () => row()); m.tx.task.findUnique.mockImplementation(async () => row());
  m.db.project.findUnique.mockImplementation(async () => project()); m.tx.project.findUnique.mockImplementation(async () => project());
  m.db.actionLog.findFirst.mockResolvedValue(null); m.tx.actionLog.findFirst.mockResolvedValue(null);
  m.tx.$queryRaw.mockResolvedValue([{ id: 'task', projectId: 'project' }]);
  m.tx.task.update.mockResolvedValue({ updatedAt: new Date('2026-10-25T00:00:01.000Z') });
  m.db.$transaction.mockImplementation(async (fn) => { m.beforeTransaction(); return fn(m.tx); });
});

it('valid ordinary edit still writes and records its before/after values', async () => {
  await updateTask(actor, 'task', { title: 'Changed', expectedUpdatedAt: version });
  expect(m.tx.task.update).toHaveBeenCalledOnce();
  expect(m.log).toHaveBeenCalledWith(m.tx, expect.objectContaining({ before: { title: 'Original' }, after: { title: 'Changed' } }));
});

for (const [name, role, status] of [['removed', null, 404], ['downgraded', 'VIEWER', 403]] as const) {
  it(`membership ${name} after preflight denies the write and its audit`, async () => {
    m.beforeTransaction = () => { m.role = role; };
    await expect(updateTask(actor, 'task', { title: 'Unauthorized', expectedUpdatedAt: version })).rejects.toMatchObject({ status });
    expect(m.tx.task.update).not.toHaveBeenCalled(); expect(m.log).not.toHaveBeenCalled();
  });
}
it('another committed task version after preflight cannot be overwritten', async () => {
  m.beforeTransaction = () => { m.version = new Date('2026-10-25T00:00:01.000Z'); };
  await expect(updateTask(actor, 'task', { title: 'Lost update', expectedUpdatedAt: version })).rejects.toMatchObject({ status: 409, code: 'version_conflict' });
  expect(m.tx.task.update).not.toHaveBeenCalled(); expect(m.log).not.toHaveBeenCalled();
});
it('archive committed after preflight denies the write', async () => {
  m.beforeTransaction = () => { m.archived = true; };
  await expect(updateTask(actor, 'task', { title: 'Archived write', expectedUpdatedAt: version })).rejects.toMatchObject({ status: 409 });
  expect(m.tx.task.update).not.toHaveBeenCalled(); expect(m.log).not.toHaveBeenCalled();
});
it('a competing membership lock becomes a retryable conflict without writes', async () => {
  m.tx.$queryRaw.mockResolvedValueOnce([{ id: 'task', projectId: 'project' }]).mockRejectedValueOnce({ code: 'P2010', meta: { code: '55P03' } });
  await expect(updateTask(actor, 'task', { title: 'Blocked lock', expectedUpdatedAt: version })).rejects.toMatchObject({ status: 409 });
  expect(m.tx.task.update).not.toHaveBeenCalled(); expect(m.log).not.toHaveBeenCalled();
});
