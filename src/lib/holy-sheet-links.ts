import { holyQaIdentity } from "@/lib/holy-qa-identity";
import { Prisma } from '@/generated/prisma/client';
import { currentSessionId } from '@/lib/auth';
import { db } from '@/lib/db';
import { projectAccess, requireWrite, type Actor } from '@/lib/access';
import { ApiError, notFound } from '@/lib/http';
import { centralSessionActive } from '@/lib/central-status';
import { holySheetOrigin } from '@/lib/holy-sheet-url';
// Raw row locks must use the same configured schema as Prisma, including preview
// slots behind transaction pooling. Identifiers are escaped, never request input.
function table(name: 'Project' | 'ProjectMember' | 'Task') {
    const schema = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).searchParams.get('schema') ?? 'public' : 'public';
    return Prisma.raw('"' + schema.replaceAll('"', '""') + '"."' + name + '"');
}
export type DocumentOrigin = {
    kind: 'projects' | 'tasks';
    id: string;
};
export async function documentContext(actor: Actor, origin: DocumentOrigin, write = false) {
    const hsOrigin = holySheetOrigin();
    if (!hsOrigin)
        throw notFound();
    const task = origin.kind === 'tasks' ? await db.task.findUnique({ where: { id: origin.id }, select: { projectId: true, deletedAt: true } }) : null;
    if (origin.kind === 'tasks' && (!task || task.deletedAt))
        throw notFound('Task');
    const projectId = task?.projectId ?? origin.id;
    const access = await projectAccess(actor, projectId, { write });
    if (write)
        requireWrite(access);
    const id = await currentSessionId();
    const session = id ? await db.session.findUnique({ where: { id }, include: { centralLink: true } }) : null;
    const link = session?.centralLink;
    if (!session || session.userId !== actor.id || session.revokedAt || session.expiresAt <= new Date() || !link || !link.subject || link.subject.length > 200 || /[\u0000-\u0020\u007f]/.test(link.subject) || !await centralSessionActive(link.subject, link.sessionUid, actor.id))
        throw new ApiError(401, 'Sign in with Aplyd to open Holy Sheet.');
    return { hostOrigin: holyQaIdentity()?.origin ?? "https://sheethappensofficer.aplyd.org", origin: hsOrigin, subject: link.subject, projectId, originKey: origin.kind === 'tasks' ? `task:${origin.id}` : 'project', canWrite: access.role !== 'VIEWER' && !access.project.archivedAt };
}
export async function documents(actor: Actor, origin: DocumentOrigin) {
    const c = await documentContext(actor, origin);
    const [links, location] = await Promise.all([db.holySheetLink.findMany({ where: { projectId: c.projectId, originKey: c.originKey }, select: { pageId: true }, orderBy: { createdAt: 'asc' } }), db.holySheetDefault.findUnique({ where: { projectId: c.projectId }, select: { spaceId: true } })]);
    const latest = await documentContext(actor, origin); // Authority may have changed while reading metadata.
    if (latest.subject !== c.subject || latest.projectId !== c.projectId)
        throw new ApiError(409, 'Source or account changed. Retry.');
    return { ...latest, links, defaultSpaceId: location?.spaceId ?? null };
}
export async function changeDocument(actor: Actor, origin: DocumentOrigin, input: {
    pageId: string;
    spaceId?: string;
    created?: boolean;
    remove?: boolean;
    subject: string;
    setDefault?: boolean;
}) {
    const c = await documentContext(actor, origin, true);
    if (input.subject !== c.subject)
        throw new ApiError(409, 'Your Aplyd account changed. Reopen the picker.');
    await db.$transaction(async (tx) => {
        // Lock the native source and its memberships until commit; links never grant HS access.
        await tx.$queryRaw `SELECT id FROM ${table('Project')} WHERE id=${c.projectId} FOR UPDATE`;
        await tx.$queryRaw `SELECT "userId" FROM ${table('ProjectMember')} WHERE "projectId"=${c.projectId} FOR SHARE`;
        const project = await tx.project.findUnique({ where: { id: c.projectId }, include: { members: true } });
        const role = actor.orgRole !== 'MEMBER' ? 'LEADER' : project?.members.find(m => m.userId === actor.id)?.role;
        if (!project || project.deletedAt || !role)
            throw notFound();
        if (project.archivedAt)
            throw new ApiError(409, 'This project is archived and read-only.');
        if (role === 'VIEWER')
            throw new ApiError(403, 'Viewers cannot make changes.');
        if (origin.kind === 'tasks') {
            await tx.$queryRaw `SELECT id FROM ${table('Task')} WHERE id=${origin.id} FOR UPDATE`;
            const task = await tx.task.findUnique({ where: { id: origin.id }, select: { projectId: true, deletedAt: true } });
            if (!task || task.deletedAt || task.projectId !== c.projectId)
                throw notFound('Task');
        }
        const where = { projectId_originKey_pageId: { projectId: c.projectId, originKey: c.originKey, pageId: input.pageId } };
        if (input.remove)
            await tx.holySheetLink.deleteMany({ where: { projectId: c.projectId, originKey: c.originKey, pageId: input.pageId } });
        else {
            await tx.holySheetLink.upsert({ where, create: { projectId: c.projectId, originKey: c.originKey, taskId: origin.kind === 'tasks' ? origin.id : null, pageId: input.pageId }, update: {} });
            if ((input.created || input.setDefault) && input.spaceId)
                await tx.holySheetDefault.upsert({ where: { projectId: c.projectId }, create: { projectId: c.projectId, spaceId: input.spaceId }, update: input.setDefault ? { spaceId: input.spaceId } : {} });
        }
    });
    return { ok: true };
}
