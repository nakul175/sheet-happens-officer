import { beforeEach, it, expect, vi } from 'vitest';
const m = vi.hoisted(() => ({ sessionId: vi.fn(), session: vi.fn(), active: vi.fn(), access: vi.fn(), task: vi.fn(), links: vi.fn(), location: vi.fn(), project: vi.fn(), txTask: vi.fn(), upsert: vi.fn(), remove: vi.fn(), setDefault: vi.fn(), transaction: vi.fn(), query: vi.fn() }));
vi.mock('@/lib/auth', () => ({ currentSessionId: m.sessionId }));
vi.mock('@/lib/central-status', () => ({ centralSessionActive: m.active }));
vi.mock('@/lib/access', async () => ({ ...await vi.importActual('../src/lib/access'), projectAccess: m.access }));
vi.mock('@/lib/db', () => ({ db: { session: { findUnique: m.session }, task: { findUnique: m.task }, holySheetLink: { findMany: m.links }, holySheetDefault: { findUnique: m.location }, $transaction: m.transaction } }));
import { documents, changeDocument } from '../src/lib/holy-sheet-links';
const actor = { id: 'native', orgRole: 'MEMBER' as const }, origin = { kind: 'tasks' as const, id: 'task' }, input = { subject: 'central', pageId: '12345678-1234-4234-8234-123456789abc', spaceId: 'space', created: true };
beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('FF_HOLY_SHEET', '1');
    vi.stubEnv('HOLY_SHEET_ORIGIN', 'https://staging.holysheet.aplyd.org');
    m.task.mockResolvedValue({ projectId: 'project', deletedAt: null });
    m.access.mockResolvedValue({ role: 'EDITOR', project: { archivedAt: null } });
    m.sessionId.mockResolvedValue('session');
    m.session.mockResolvedValue({ userId: 'native', revokedAt: null, expiresAt: new Date(Date.now() + 60000), centralLink: { subject: 'central', sessionUid: 'suite' } });
    m.active.mockResolvedValue(true);
    m.links.mockResolvedValue([{ pageId: input.pageId }]);
    m.location.mockResolvedValue({ spaceId: 'space' });
    m.project.mockResolvedValue({ archivedAt: null, members: [{ userId: 'native', role: 'EDITOR' }] });
    m.txTask.mockResolvedValue({ projectId: 'project', deletedAt: null });
    m.transaction.mockImplementation(fn => fn({ $queryRaw: m.query, project: { findUnique: m.project }, task: { findUnique: m.txTask }, holySheetLink: { upsert: m.upsert, deleteMany: m.remove }, holySheetDefault: { upsert: m.setDefault } }));
});
it('returns opaque references and project default after rechecking native and suite access', async () => {
    const result = await documents(actor, origin);
    expect(result.subject).toBe('central');
    expect(result.links).toEqual([{ pageId: input.pageId }]);
    expect(result.defaultSpaceId).toBe('space');
    expect(m.active).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain('title');
});
it('stores one native origin reference without any HS grant mutation', async () => {
    await changeDocument(actor, origin, input);
    expect(m.upsert.mock.calls[0][0].create).toMatchObject({ projectId: 'project', taskId: 'task', originKey: 'task:task', pageId: input.pageId });
    expect(m.setDefault.mock.calls[0][0].update).toEqual({});
});
it('changes the project default only on an explicit selection', async () => {
    await changeDocument(actor, origin, { ...input, setDefault: true });
    expect(m.setDefault.mock.calls[0][0].update).toEqual({ spaceId: 'space' });
});
it('removes only the native link and never changes the project default', async () => {
    await changeDocument(actor, origin, { ...input, remove: true });
    expect(m.remove).toHaveBeenCalledOnce();
    expect(m.upsert).not.toHaveBeenCalled();
    expect(m.setDefault).not.toHaveBeenCalled();
});
it('rejects a switched Aplyd identity before a write', async () => {
    await expect(changeDocument(actor, origin, { ...input, subject: 'old-account' })).rejects.toMatchObject({ status: 409 });
    expect(m.transaction).not.toHaveBeenCalled();
});
it.each([{ archivedAt: new Date(), members: [{ userId: 'native', role: 'EDITOR' }] }, { archivedAt: null, members: [{ userId: 'native', role: 'VIEWER' }] }, { archivedAt: null, members: [] }])('refuses membership loss, downgrade or archive during the operation', async (project) => {
    m.project.mockResolvedValue(project);
    await expect(changeDocument(actor, origin, input)).rejects.toHaveProperty('status');
    expect(m.upsert).not.toHaveBeenCalled();
});
it.each([{ projectId: 'other', deletedAt: null }, { projectId: 'project', deletedAt: new Date() }, null])('refuses a task moved or deleted after initial validation', async (task) => {
    m.txTask.mockResolvedValue(task);
    await expect(changeDocument(actor, origin, input)).rejects.toMatchObject({ status: 404 });
    expect(m.upsert).not.toHaveBeenCalled();
});
it('refuses a revoked suite session and never reads document references', async () => {
    m.active.mockResolvedValue(false);
    await expect(documents(actor, origin)).rejects.toMatchObject({ status: 401 });
    expect(m.links).not.toHaveBeenCalled();
});
it('keeps the integration unavailable when its flag is disabled', async () => {
    vi.stubEnv('FF_HOLY_SHEET', '0');
    await expect(documents(actor, origin)).rejects.toMatchObject({ status: 404 });
    expect(m.session).not.toHaveBeenCalled();
});
