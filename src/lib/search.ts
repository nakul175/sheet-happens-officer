// SHO-US-3.2 AC6 and 3.6 AC6: search over the projects and tasks the person may see.
// Members find only their own projects; Admins find all. Archived projects are left out
// unless the person asks for them.
import { db } from "@/lib/db";
import { isAdmin, type Actor } from "@/lib/access";

export async function search(user: Actor, q: string, includeArchived: boolean) {
  const text = q.trim();
  if (text.length < 2) return { projects: [], tasks: [] };
  const visible = {
    ...(isAdmin(user) ? {} : { members: { some: { userId: user.id } } }),
    ...(includeArchived ? {} : { archivedAt: null }),
  };
  const [projects, tasks] = await Promise.all([
    db.project.findMany({
      where: { ...visible, name: { contains: text, mode: "insensitive" } },
      orderBy: { name: "asc" }, take: 20, select: { id: true, name: true, archivedAt: true },
    }),
    db.task.findMany({
      where: { deletedAt: null, title: { contains: text, mode: "insensitive" }, project: visible },
      orderBy: [{ completedAt: { sort: "asc", nulls: "first" } }, { updatedAt: "desc" }], take: 30,
      select: { id: true, title: true, completedAt: true, assignee: { select: { name: true } }, project: { select: { id: true, name: true, archivedAt: true } } },
    }),
  ]);
  return {
    projects: projects.map((p) => ({ id: p.id, name: p.name, archived: !!p.archivedAt })),
    tasks: tasks.map((t) => ({ id: t.id, title: t.title, done: !!t.completedAt, assignee: t.assignee.name, project: { id: t.project.id, name: t.project.name }, archived: !!t.project.archivedAt })),
  };
}
