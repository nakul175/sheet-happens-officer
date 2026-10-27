import { beforeAll, afterAll, beforeEach, it, expect, vi, describe } from 'vitest';
const m = vi.hoisted(() => ({ sessionId: vi.fn(), active: vi.fn() }));
vi.mock('@/lib/auth', () => ({ currentSessionId: m.sessionId }));
vi.mock('@/lib/central-status', () => ({ centralSessionActive: m.active }));
import { db } from '../src/lib/db';
import { changeDocument, documents } from '../src/lib/holy-sheet-links';
const enabled = !!process.env.DATABASE_URL;
describe.skipIf(!enabled)('SHO-3062 real PostgreSQL persistence', () => {
    const tag = crypto.randomUUID();
    let workspace: string, leader: string, editor: string, first: string, second: string, task: string, session: string, section2: string;
    const actor = () => ({ id: editor, orgRole: 'MEMBER' as const }), source = () => ({ kind: 'tasks' as const, id: task });
    const input = (pageId = crypto.randomUUID(), spaceId = 'first-space') => ({ pageId, spaceId, created: true, subject: 'qa-central' });
    beforeAll(async () => {
        const target = new URL(process.env.DATABASE_URL!);
        if (!['localhost', '127.0.0.1'].includes(target.hostname) || !['/sho3062', '/sho_test'].includes(target.pathname)) throw Error('SHO-3062 DB tests require a disposable loopback test database');
        vi.stubEnv('FF_HOLY_SHEET', '1');
        vi.stubEnv('HOLY_SHEET_ORIGIN', 'https://staging.holysheet.aplyd.org');
        workspace = (await db.workspace.create({ data: { name: `SHO3062 ${tag}` } })).id;
        const people = await Promise.all(['leader', 'editor'].map(name => db.user.create({ data: { workspaceId: workspace, name, email: `${name}-${tag}@example.invalid`, passwordHash: 'synthetic-test-only', emailVerifiedAt: new Date() } })));
        [leader, editor] = people.map(p => p.id);
        const projects = await Promise.all(['first', 'second'].map(name => db.project.create({ data: { workspaceId: workspace, name, members: { create: [{ userId: leader, role: 'LEADER' }, { userId: editor, role: 'EDITOR' }] }, sections: { create: { name: 'Open', position: 0 } } }, include: { sections: true } })));
        [first, second] = projects.map(p => p.id);
        section2 = projects[1].sections[0].id;
        task = (await db.task.create({ data: { workspaceId: workspace, projectId: first, sectionId: projects[0].sections[0].id, title: 'Synthetic document task', assigneeId: editor, createdById: editor } })).id;
        session = (await db.session.create({ data: { userId: editor, tokenHash: `test-only-${tag}`, expiresAt: new Date(Date.now() + 600000), centralLink: { create: { subject: 'qa-central', sessionUid: 'test-only' } } } })).id;
    });
    beforeEach(() => { m.sessionId.mockResolvedValue(session); m.active.mockReset().mockResolvedValue(true); });
    afterAll(async () => { if (workspace) {
        await db.project.deleteMany({ where: { workspaceId: workspace } });
        await db.user.deleteMany({ where: { workspaceId: workspace } });
        await db.workspace.delete({ where: { id: workspace } });
    } await db.$disconnect(); vi.unstubAllEnvs(); });
    it('deduplicates concurrent retries and keeps one project default', async () => {
        const value = input();
        await Promise.all([changeDocument(actor(), source(), value), changeDocument(actor(), source(), value)]);
        expect(await db.holySheetLink.count({ where: { taskId: task, pageId: value.pageId } })).toBe(1);
        await changeDocument(actor(), source(), input(crypto.randomUUID(), 'other-space'));
        expect((await documents(actor(), source())).defaultSpaceId).toBe('first-space');
    });
    it('rejects native privilege loss between initial check and transaction', async () => {
        m.active.mockImplementationOnce(async () => { await db.projectMember.update({ where: { projectId_userId: { projectId: first, userId: editor } }, data: { role: 'VIEWER' } }); return true; });
        const value = input();
        await expect(changeDocument(actor(), source(), value)).rejects.toMatchObject({ status: 403 });
        expect(await db.holySheetLink.count({ where: { pageId: value.pageId } })).toBe(0);
        await db.projectMember.update({ where: { projectId_userId: { projectId: first, userId: editor } }, data: { role: 'EDITOR' } });
    });
    it('updates explicit defaults and removes only native references', async () => {
        const value = input();
        await changeDocument(actor(), source(), { ...value, setDefault: true, spaceId: 'chosen-space' });
        expect((await documents(actor(), source())).defaultSpaceId).toBe('chosen-space');
        await changeDocument(actor(), source(), { ...value, remove: true });
        expect(await db.holySheetLink.count({ where: { pageId: value.pageId } })).toBe(0);
        expect((await documents(actor(), source())).defaultSpaceId).toBe('chosen-space');
    });
    it('carries task links across native project moves and does not move project defaults', async () => {
        const value = input();
        await changeDocument(actor(), source(), value);
        await db.task.update({ where: { id: task }, data: { projectId: second, sectionId: section2 } });
        const row = await db.holySheetLink.findFirstOrThrow({ where: { taskId: task, pageId: value.pageId } });
        expect(row.projectId).toBe(second);
        const result = await documents(actor(), source());
        expect(result.links.some(l => l.pageId === value.pageId)).toBe(true);
        expect(result.defaultSpaceId).toBeNull();
    });
    it('enforces origin consistency and foreign keys in SQL', async () => {
        await expect(db.holySheetLink.create({ data: { projectId: second, originKey: 'wrong-origin', pageId: crypto.randomUUID() } })).rejects.toBeTruthy();
        await expect(db.holySheetLink.create({ data: { projectId: second, taskId: 'absent', originKey: 'task:absent', pageId: crypto.randomUUID() } })).rejects.toBeTruthy();
    });
});
