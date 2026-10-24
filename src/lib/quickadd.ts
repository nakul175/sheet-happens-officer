// SHO-US-14.5: where a person can add a task from anywhere.
// The server decides: only projects where the person is Leader or Editor, not archived, type Project.
// Viewers get an empty list, so the button and the shortcut do not exist for them.
import { db } from "@/lib/db";
import type { Actor } from "@/lib/access";

export async function quickAddTargets(user: Actor) {
  const seats = await db.projectMember.findMany({
    where: { userId: user.id, role: { in: ["LEADER", "EDITOR"] }, project: { archivedAt: null, typeId: "wst_project" } },
    select: { project: { select: { id: true, name: true } } },
    orderBy: { project: { name: "asc" } },
  });
  const projects = seats.map((s) => s.project);
  if (!projects.length) return { projects: [], lastProjectId: null };
  // Last used: the project of the most recent task this person created in one of these projects.
  const last = await db.task.findFirst({
    where: { createdById: user.id, projectId: { in: projects.map((p) => p.id) } },
    orderBy: { createdAt: "desc" },
    select: { projectId: true },
  });
  return { projects, lastProjectId: last?.projectId ?? projects[0].id };
}
