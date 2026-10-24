// SHO-US-14.4: first-run orientation. Who the Leaders are, asking to be added, and dismissing the start guide.
import { db } from "@/lib/db";
import { notFound } from "@/lib/http";
import { isActive, type Actor } from "@/lib/access";
import { notify } from "@/lib/notify";

/**
 * People who lead at least one live project, by name only. No project names: a Member must not learn
 * that a project they are not in exists. With no Leaders at all, Admins are listed instead.
 */
export async function listLeaders(user: Actor) {
  const rows = await db.projectMember.findMany({
    where: { role: "LEADER", userId: { not: user.id }, project: { archivedAt: null, typeId: "wst_project" } },
    select: { user: { select: { id: true, name: true, deactivatedAt: true, emailVerifiedAt: true } } },
  });
  const seen = new Map<string, string>();
  for (const r of rows) if (isActive(r.user)) seen.set(r.user.id, r.user.name);
  if (seen.size) return { kind: "LEADER" as const, people: [...seen].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)) };
  const admins = await db.user.findMany({ where: { orgRole: { not: "MEMBER" }, id: { not: user.id }, deactivatedAt: null, emailVerifiedAt: { not: null } }, select: { id: true, name: true }, orderBy: { name: "asc" } });
  return { kind: "ADMIN" as const, people: admins };
}

/** "Request to be added": tells the Leader. One request per person per Leader per day. */
export async function requestToBeAdded(user: Actor, leaderId: string) {
  const list = await listLeaders(user);
  if (!list.people.some((p) => p.id === leaderId)) throw notFound("Person");
  const day = new Date(Date.now() - 86400_000);
  const already = await db.notification.findFirst({ where: { recipientId: leaderId, actorId: user.id, type: "JOIN_REQUESTED", createdAt: { gt: day } } });
  if (already) return { already: true };
  await db.$transaction((tx) => notify(tx, [leaderId], "JOIN_REQUESTED", { actorId: user.id }));
  return { already: false };
}

export async function dismissStartGuide(user: Actor) {
  await db.user.update({ where: { id: user.id }, data: { startGuideDismissedAt: new Date() } });
  return { dismissed: true };
}
