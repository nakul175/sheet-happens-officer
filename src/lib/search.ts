// SHO-US-3.2 AC6 and 3.6 AC6, APL-2684: search over the projects and tasks the person may see.
// Members find only their own projects. Admins and Super Admins find every project, including
// archived ones they are not members of, once Include archived is on. Archived projects stay
// out of the results until then.
import { db } from "@/lib/db";
import { isAdmin, type Actor } from "@/lib/access";
import { WORKSTREAM_DEAL, crmProjectWhere, crmVisible } from "@/lib/crm";
import { commentsEnabled } from "@/lib/flags";
import { rankedSearch } from "@/lib/search-query";

export async function search(user: Actor, q: string, includeArchived: boolean, ideasOnly = false) {
  const text = q.trim();
  if (text.length < 2) return { projects: [], tasks: [], organisations: [], contacts: [] };
  // Activation is part of the separately reviewed database cut. Ordinary deployments
  // retain the existing search until pg_trgm, indexes and acceptance are approved.
  if (process.env.SEARCH_STAGE_A_ENABLED === "true") {
    const hits = await rankedSearch(user, text, { archived: includeArchived, ideasOnly });
    return { hits, projects: [], tasks: [], organisations: [], contacts: [] };
  }
  // Membership and archive are separate filters. Include archived must not put the membership
  // limit back onto an Admin or Super Admin (APL-2684).
  const visible = {
    deletedAt: null,
    ...(isAdmin(user) ? {} : { members: { some: { userId: user.id } } }),
    ...(includeArchived ? {} : { archivedAt: null }),
    ...crmProjectWhere(user), // neither a deal nor its tasks while the CRM is hidden (SHO-BUG-2)
  };
  const crm = crmVisible(user);
  const me = await db.user.findUniqueOrThrow({ where: { id: user.id }, select: { workspaceId: true } });
  const [organisations, contacts] = crm && !ideasOnly ? await Promise.all([
    db.organisation.findMany({ where: { workspaceId: me.workspaceId, archivedAt: includeArchived ? undefined : null, name: { contains: text, mode: "insensitive" } }, orderBy: { name: "asc" }, take: 20, select: { id: true, name: true, kind: true } }),
    db.contact.findMany({ where: { workspaceId: me.workspaceId, removedAt: null, name: { contains: text, mode: "insensitive" } }, orderBy: { name: "asc" }, take: 20, select: { id: true, name: true, organisation: { select: { id: true, name: true } } } }),
  ]) : [[], []];
  // Comment text is searchable only while ff_task_comments is on, and only inside projects the person can see.
  // The hit is the task. The comment body is not copied into the result.
  const commentTaskIds = commentsEnabled() ? [...new Set((await db.comment.findMany({
    where: {
      removedAt: null,
      text: { contains: text, mode: "insensitive" },
      task: { deletedAt: null, ...(ideasOnly ? { isIdea: true } : {}), project: visible },
    },
    select: { taskId: true },
    take: 30,
  })).map((c) => c.taskId))] : [];
  const titleMatch = { contains: text, mode: "insensitive" as const };
  const taskWhere = commentTaskIds.length
    ? { deletedAt: null, ...(ideasOnly ? { isIdea: true } : {}), project: visible, OR: [{ title: titleMatch }, { id: { in: commentTaskIds } }] }
    : { deletedAt: null, ...(ideasOnly ? { isIdea: true } : {}), title: titleMatch, project: visible };
  const [projects, tasks] = await Promise.all([
    // project-lookup-ok: visible applies membership, CRM, archive and project-Trash exclusion above.
    db.project.findMany({
      where: { ...visible, name: { contains: text, mode: "insensitive" } },
      orderBy: { name: "asc" }, take: 20, select: { id: true, name: true, archivedAt: true, typeId: true },
    }),
    db.task.findMany({
      where: taskWhere,
      orderBy: [{ completedAt: { sort: "asc", nulls: "first" } }, { updatedAt: "desc" }], take: 30,
      select: { id: true, title: true, completedAt: true, isIdea: true, assignee: { select: { name: true } }, project: { select: { id: true, name: true, archivedAt: true } } },
    }),
  ]);
  return {
    organisations: organisations as { id: string; name: string; kind: string | null }[],
    contacts: (contacts as { id: string; name: string; organisation: { id: string; name: string } }[]).map((c) => ({ id: c.id, name: c.name, organisation: c.organisation })),
    projects: projects.map((p) => ({ id: p.id, name: p.name, archived: !!p.archivedAt, type: p.typeId === WORKSTREAM_DEAL ? "DEAL" : "PROJECT" })),
    tasks: tasks.map((t) => ({ id: t.id, title: t.title, done: !!t.completedAt, isIdea: t.isIdea, assignee: t.assignee.name, project: { id: t.project.id, name: t.project.name }, archived: !!t.project.archivedAt })),
  };
}
