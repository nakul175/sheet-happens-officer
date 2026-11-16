import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  kind: 'task.assigned', role: 'EDITOR' as string | null, archived: false, assigneeId: 'after', approverId: null as string | null,
  undoneAt: null as Date | null, updatedAt: new Date(), previousEligible: true, beforeTransaction: () => {},
  access: vi.fn(), log: vi.fn(), notify: vi.fn(), audit: vi.fn(),
  db: { actionLog: { findUnique: vi.fn(), findMany: vi.fn() }, task: { findFirst: vi.fn() }, user: { findMany: vi.fn() }, section: { findMany: vi.fn() }, $transaction: vi.fn() },
  tx: { actionLog: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() }, task: { findFirst: vi.fn(), update: vi.fn() }, projectMember: { findUnique: vi.fn() }, user: { findMany: vi.fn() }, section: { findMany: vi.fn() }, $queryRaw: vi.fn() },
}));
vi.mock('@/lib/db', () => ({ db: m.db }));
vi.mock('@/lib/tasks', () => ({ recordAccess: m.access, deleteTask: vi.fn(), restoreTask: vi.fn() }));
vi.mock('@/lib/records', () => ({ undoRecord: vi.fn() }));
vi.mock('@/lib/notify', () => ({ logAction: m.log, notify: m.notify, auditTx: m.audit }));
import { ApiError } from '@/lib/http';
import { undoAction } from '@/lib/undo';
const actor = { id: 'editor', orgRole: 'MEMBER' as const };
const kinds = ['task.assigned', 'task.sent_for_approval', 'task.sent_back', 'task.approver_changed'];
beforeEach(() => {
  vi.clearAllMocks(); m.kind = 'task.assigned'; m.role = 'EDITOR'; m.archived = false; m.assigneeId = 'after'; m.approverId = null;
  m.undoneAt = null; m.previousEligible = true; m.updatedAt = new Date(Date.now() - 1000); m.beforeTransaction = () => {};
  const row = () => ({ id: 'action', projectId: 'project', targetId: 'task', targetType: 'task', action: m.kind, actorId: actor.id,
    beforeState: m.kind === 'task.approver_changed' ? { approverId: 'before' } : { assigneeId: 'before', ...(m.kind === 'task.sent_back' ? { approverId: 'old-approver' } : {}) },
    afterState: m.kind === 'task.approver_changed' ? { approverId: null } : { assigneeId: 'after', ...(m.kind === 'task.sent_back' ? { approverId: null } : {}) },
    createdAt: new Date(), undoneAt: m.undoneAt });
  const task = () => ({ id: 'task', projectId: 'project', title: 'Task', deletedAt: null, assigneeId: m.assigneeId, approverId: m.approverId, updatedAt: m.updatedAt });
  for (const client of [m.db, m.tx]) {
    client.actionLog.findUnique.mockImplementation(async () => row()); client.actionLog.findMany.mockResolvedValue([]);
    client.task.findFirst.mockImplementation(async () => task()); client.user.findMany.mockResolvedValue([]); client.section.findMany.mockResolvedValue([]);
  }
  m.access.mockImplementation(async () => { if (!m.role) throw new ApiError(404, 'Action not found'); return { role: m.role, project: { id: 'project', archivedAt: m.archived ? new Date() : null } }; });
  m.tx.$queryRaw.mockResolvedValue([{ id: 'task' }]);
  m.tx.projectMember.findUnique.mockImplementation(async () => m.previousEligible ? { role: 'EDITOR', user: { deactivatedAt: null, emailVerifiedAt: new Date() } } : null);
  m.tx.task.update.mockImplementation(async ({ data }) => { for (const key of ['assigneeId', 'approverId', 'updatedAt'] as const) if (key in data) Object.assign(m, { [key]: data[key] }); return task(); });
  m.tx.actionLog.update.mockImplementation(async ({ data }) => { m.undoneAt = data.undoneAt; return row(); });
  m.tx.actionLog.updateMany.mockImplementation(async ({ data }) => { if (m.undoneAt) return { count: 0 }; m.undoneAt = data.undoneAt; return { count: 1 }; });
  m.db.$transaction.mockImplementation(async (fn) => {
    m.beforeTransaction(); const state = { assigneeId: m.assigneeId, approverId: m.approverId, updatedAt: m.updatedAt, undoneAt: m.undoneAt };
    try { return await fn(m.tx); } catch (e) { Object.assign(m, state); throw e; }
  });
});
for (const kind of kinds) {
  it(`${kind}: valid Undo restores the touched person and records one activity`, async () => {
    m.kind = kind; await undoAction(actor, 'action');
    expect(kind === 'task.approver_changed' ? m.approverId : m.assigneeId).toBe('before'); expect(m.undoneAt).not.toBeNull(); expect(m.log).toHaveBeenCalledOnce();
  });
  it(`${kind}: actor removed after preflight cannot write`, async () => {
    m.kind = kind; m.beforeTransaction = () => { m.role = null; };
    await expect(undoAction(actor, 'action')).rejects.toMatchObject({ status: 404 }); expect(m.undoneAt).toBeNull(); expect(m.log).not.toHaveBeenCalled();
  });
  it(`${kind}: newer person change after preflight requires confirmation`, async () => {
    m.kind = kind; m.beforeTransaction = () => { if (kind === 'task.approver_changed') m.approverId = 'newer'; else m.assigneeId = 'newer'; };
    await expect(undoAction(actor, 'action')).rejects.toMatchObject({ status: 409, extra: { needsConfirm: 'conflict' } });
    expect(kind === 'task.approver_changed' ? m.approverId : m.assigneeId).toBe('newer'); expect(m.undoneAt).toBeNull(); expect(m.log).not.toHaveBeenCalled();
  });
  it(`${kind}: a completed Undo observed after preflight cannot replay`, async () => {
    m.kind = kind; m.beforeTransaction = () => { m.undoneAt = new Date(); };
    await expect(undoAction(actor, 'action')).rejects.toMatchObject({ status: 409 }); expect(m.log).not.toHaveBeenCalled();
  });
}
for (const [scenario, status] of [['downgrade', 403], ['archive', 409]] as const) {
  it(`${scenario} after preflight prevents assignment Undo`, async () => {
    m.beforeTransaction = () => { if (scenario === 'archive') m.archived = true; else m.role = 'VIEWER'; };
    await expect(undoAction(actor, 'action')).rejects.toMatchObject({ status }); expect(m.undoneAt).toBeNull(); expect(m.log).not.toHaveBeenCalled();
  });
}
it('send-back Undo restores the assignee and cleared approver together', async () => {
  m.kind = 'task.sent_back'; await undoAction(actor, 'action'); expect(m.assigneeId).toBe('before'); expect(m.approverId).toBe('old-approver');
});
it('an ineligible previous person prevents the inverse and rolls back the claim', async () => {
  m.previousEligible = false; await expect(undoAction(actor, 'action')).rejects.toMatchObject({ status: 409 });
  expect(m.assigneeId).toBe('after'); expect(m.undoneAt).toBeNull(); expect(m.log).not.toHaveBeenCalled();
});
it('assignment Undo advances an existing future version monotonically', async () => {
  const stamp = new Date(Date.now() + 60_000); m.updatedAt = stamp; await undoAction(actor, 'action'); expect(m.updatedAt.getTime()).toBeGreaterThan(stamp.getTime());
});
