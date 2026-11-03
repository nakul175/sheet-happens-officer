import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  role: 'EDITOR', vertical: false, claimed: false, archived: true, beforeTransaction: () => {},
  access: vi.fn(), log: vi.fn(),
  db: { actionLog: { findUnique: vi.fn(), findMany: vi.fn() }, project: { findUniqueOrThrow: vi.fn() }, $transaction: vi.fn() },
  tx: { actionLog: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() }, project: { findUniqueOrThrow: vi.fn(), update: vi.fn() }, $queryRaw: vi.fn() },
}));
vi.mock('@/lib/db', () => ({ db: m.db }));
vi.mock('@/lib/tasks', () => ({ recordAccess: m.access, deleteTask: vi.fn(), restoreTask: vi.fn() }));
vi.mock('@/lib/records', () => ({ undoRecord: vi.fn() }));
vi.mock('@/lib/notify', () => ({ logAction: m.log, notify: vi.fn(), auditTx: vi.fn() }));
import { checkUndo, undoAction } from '@/lib/undo';
const actor = { id: 'former-leader', orgRole: 'MEMBER' as const };
const managementKinds = [
  'project.updated', 'project.archived', 'project.unarchived', 'project.leader_changed',
  'member.added', 'member.removed', 'member.role_changed',
  'section.added', 'section.renamed', 'section.moved', 'section.done_changed',
];
let kind = 'project.archived';
beforeEach(() => {
  vi.clearAllMocks(); kind = 'project.archived'; m.role = 'EDITOR'; m.vertical = false; m.claimed = false; m.archived = true; m.beforeTransaction = () => {};
  const row = () => ({ id: 'action', projectId: 'project', targetId: 'project', targetType: 'project', action: kind, actorId: actor.id,
    createdAt: new Date(), undoneAt: m.claimed ? new Date() : null, beforeState: {}, afterState: {} });
  m.db.actionLog.findUnique.mockImplementation(async () => row()); m.tx.actionLog.findUnique.mockImplementation(async () => row());
  m.db.actionLog.findMany.mockResolvedValue([]); m.tx.actionLog.update.mockImplementation(async () => { m.claimed = true; return row(); });
  m.tx.actionLog.updateMany.mockImplementation(async () => { if (m.claimed) return { count: 0 }; m.claimed = true; return { count: 1 }; });
  m.access.mockImplementation(async () => ({ role: m.role, project: { id: 'project', isVertical: m.vertical, archivedAt: m.archived ? new Date() : null } }));
  m.db.project.findUniqueOrThrow.mockImplementation(async () => ({ id: 'project', archivedAt: m.archived, name: 'Project' }));
  m.tx.project.findUniqueOrThrow.mockImplementation(async () => ({ id: 'project', archivedAt: m.archived, name: 'Project' }));
  m.tx.project.update.mockImplementation(async ({ data }) => { m.archived = !!data.archivedAt; });
  m.tx.$queryRaw.mockResolvedValue([{ id: 'project' }]);
  m.db.$transaction.mockImplementation(async (fn) => { m.beforeTransaction(); const before = { claimed: m.claimed, archived: m.archived }; try { return await fn(m.tx); } catch (e) { Object.assign(m, before); throw e; } });
});
it('an Editor who previously archived a project cannot unarchive it through Undo', async () => {
  await expect(undoAction(actor, 'action')).rejects.toMatchObject({ status: 403 });
  expect(m.archived).toBe(true); expect(m.claimed).toBe(false); expect(m.log).not.toHaveBeenCalled();
});
for (const action of managementKinds) {
  it(`${action}: current Editor rights cannot pass the Undo eligibility check`, async () => {
    kind = action; m.archived = action === 'project.archived';
    await expect(checkUndo(actor, 'action')).rejects.toMatchObject({ status: 403 });
  });
}
it('Leader rights that were removed between preflight and write cannot apply the inverse', async () => {
  m.role = 'LEADER'; m.beforeTransaction = () => { m.role = 'EDITOR'; };
  await expect(undoAction(actor, 'action')).rejects.toMatchObject({ status: 403 });
  expect(m.archived).toBe(true); expect(m.claimed).toBe(false); expect(m.log).not.toHaveBeenCalled();
});
it('a current Leader may undo their project archive and claim it once', async () => {
  m.role = 'LEADER'; await undoAction(actor, 'action');
  expect(m.archived).toBe(false); expect(m.claimed).toBe(true); expect(m.log).toHaveBeenCalledOnce();
  await expect(undoAction(actor, 'action')).rejects.toMatchObject({ status: 409 });
});

it('a non-admin Leader cannot reactivate a retired vertical board through Undo', async () => {
  m.role = 'LEADER'; m.vertical = true;
  await expect(undoAction(actor, 'action')).rejects.toMatchObject({ status: 403 });
  expect(m.archived).toBe(true); expect(m.claimed).toBe(false); expect(m.log).not.toHaveBeenCalled();
});
