// SHO-US-3.2 AC6 and 3.6 AC6, APL-2684: search over the projects and tasks the person may see.
// Members find only their own projects. Admins and Super Admins find every project, including
// archived ones they are not members of, once Include archived is on. Archived projects stay
// out of the results until then.
import { db } from "@/lib/db";
import { visibleProjects, type Actor } from "@/lib/access";
import { WORKSTREAM_DEAL, crmVisible } from "@/lib/crm";

export async function search(user: Actor, q: string, includeArchived: boolean, ideasOnly = false) {
  const text = q.trim();
  if (text.length < 2) return { projects: [], tasks: [], organisations: [], contacts: [] };
  // visibleProjects is membership (Admins see every project), the CRM lever, and live rows.
  // Include archived drops the archive key entirely, so an Admin is not limited to projects they belong to (APL-2684).
  const live = visibleProjects(user);
  const includingArchived = { ...live };
  delete includingArchived.archivedAt;
  const visible = includeArchived ? includingArchived : live;
  const crm = crmVisible(user);
  const me = await db.user.findUniqueOrThrow({ where: { id: user.id }, select: { workspaceId: true } });
  const [organisations, contacts] = crm && !ideasOnly ? await Promise.all([
    db.organisation.findMany({ where: { workspaceId: me.workspaceId, archivedAt: includeArchived ? undefined : null, name: { contains: text, mode: "insensitive" } }, orderBy: { name: "asc" }, take: 20, select: { id: true, name: true, kind: true } }),
    db.contact.findMany({ where: { workspaceId: me.workspaceId, removedAt: null, name: { contains: text, mode: "insensitive" } }, orderBy: { name: "asc" }, take: 20, select: { id: true, name: true, organisation: { select: { id: true, name: true } } } }),
  ]) : [[], []];
  const [projects, tasks] = await Promise.all([
    db.project.findMany({
      where: { ...(includeArchived ? includingArchived : visibleProjects(user)), name: { contains: text, mode: "insensitive" } },
      orderBy: { name: "asc" }, take: 20, select: { id: true, name: true, archivedAt: true, typeId: true },
    }),
    db.task.findMany({
      where: { deletedAt: null, ...(ideasOnly ? { isIdea: true } : {}), title: { contains: text, mode: "insensitive" }, project: visible },
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
