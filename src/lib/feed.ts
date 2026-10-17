// Read side for the bell, the project Activity page, the Audit log and Profile
// (SHO-US-7.1, 6.3, 6.5, 1.6).
import { z } from "zod";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/http";
import { currentSessionId, deviceLabel, hashPassword, verifyPassword } from "@/lib/auth";
import { projectAccess, requireManage, type Actor } from "@/lib/access";
import { passwordField } from "@/lib/schemas";

const NOTE_DAYS = 90;
const LOG_MONTHS = 12;

type N = { type: string; actor: { name: string } | null; taskId: string | null; projectId: string | null; data: unknown };

/** Text and link for one notice. Wording is plain and says who did what. */
export function noticeText(n: N) {
  const who = n.actor?.name ?? "Someone";
  const d = (n.data ?? {}) as Record<string, unknown>;
  const t = d.title ? `"${d.title}"` : "a task";
  const p = d.project ? `"${d.project}"` : "a project";
  const text: Record<string, string> = {
    TASK_ASSIGNED: `${who} assigned you ${t}.`,
    TASKS_REASSIGNED: `${who} moved tasks over to you.`,
    TASKS_REASSIGNED_SUMMARY: `${d.count ?? "Some"} tasks in ${p} were handed to a new owner by ${who}.`,
    APPROVER_REASSIGNED: `${who} changed who approves tasks in ${p}.`,
    COLLABORATOR_ADDED: `${who} added you as a collaborator on ${t}.`,
    COLLABORATOR_REMOVED: `${who} removed you from ${t}.`,
    APPROVER_NAMED: `${who} named you the approver of ${t}.`,
    SENT_FOR_APPROVAL: `${who} sent ${t} to you for approval.`,
    SENT_BACK: `${who} sent ${t} back to you.`,
    TASK_BLOCKED: `${who} marked ${t} as blocked.`,
    TASK_DELETED: `${who} moved ${t} to Trash.`,
    RESTORED_TO_LEADER: `${t} was restored to you because its owner is no longer on the project.`,
    MADE_LEADER: `${who} made you Leader of ${p}.`,
    PROJECT_ARCHIVED: `${who} archived ${p}. It is now read-only.`,
    ADDED_TO_PROJECT: `${who} added you to ${p} as ${String(d.role ?? "Editor").toLowerCase()}.`,
    PROJECT_ROLE_CHANGED: `${who} changed your role in ${p} to ${String(d.role ?? "").toLowerCase()}.`,
    REMOVED_FROM_PROJECT: `${who} removed you from ${p}.`,
    ORG_ROLE_CHANGED: `${who} changed your role to ${String(d.role ?? "").toLowerCase()}.`,
    TASK_DUE_TOMORROW: `${t} is due tomorrow.`,
    TASK_DUE_TODAY: `${t} is due today.`,
    TASK_OVERDUE: `${t} is overdue${d.daysOverdue ? ` by ${d.daysOverdue} ${d.daysOverdue === 1 ? "day" : "days"}` : ""}.`,
    JOB_FAILED: `Scheduled job "${d.job}" failed${d.error ? `: ${d.error}` : ""}.`,
    JOB_MISSED: `Scheduled job "${d.job}" did not run on its day.`,
  };
  const href = n.taskId ? `/tasks/${n.taskId}` : n.projectId ? `/projects/${n.projectId}` : n.type.startsWith("JOB_") ? "/audit" : "/";
  return { text: text[n.type] ?? `${who} made a change.`, href };
}

export async function listNotifications(user: Actor) {
  const [rows, unread] = await Promise.all([
    db.notification.findMany({
      where: { recipientId: user.id },
      orderBy: { createdAt: "desc" },
      take: 30,
      include: { actor: { select: { name: true } } },
    }),
    db.notification.count({ where: { recipientId: user.id, readAt: null } }),
  ]);
  return {
    unread,
    items: rows.map((n) => ({ id: n.id, ...noticeText(n), read: !!n.readAt, createdAt: n.createdAt.toISOString() })),
  };
}

export async function markRead(user: Actor, id: string) {
  await db.notification.updateMany({ where: { id, recipientId: user.id, readAt: null }, data: { readAt: new Date() } });
}
export async function markAllRead(user: Actor) {
  await db.notification.updateMany({ where: { recipientId: user.id, readAt: null }, data: { readAt: new Date() } });
}

// ---- project activity (Leader and Admins) ----
const ACTION_WORDS: Record<string, string> = {
  "project.created": "created the project",
  "project.updated": "edited the project",
  "project.archived": "archived the project",
  "project.unarchived": "unarchived the project",
  "project.leader_changed": "changed the project Leader",
  "member.added": "added a member",
  "member.removed": "removed a member",
  "member.role_changed": "changed a member's role",
  "section.added": "added a section",
  "section.deleted": "deleted a section",
  "section.renamed": "renamed a section",
  "section.moved": "moved a section",
  "section.done_changed": "changed which section counts as done",
  "task.created": "created a task",
  "task.updated": "edited a task",
  "task.assigned": "reassigned a task",
  "task.collaborator_added": "added a collaborator to a task",
  "task.collaborator_removed": "removed a collaborator from a task",
  "task.approver_changed": "changed a task's approver",
  "task.sent_for_approval": "sent a task for approval",
  "task.sent_back": "sent a task back",
  "task.completed": "completed a task",
  "task.reopened": "reopened a task",
  "task.moved": "moved a task",
  "task.deleted": "moved a task to Trash",
  "task.restored": "restored a task from Trash",
};
const name = (s: unknown) => (typeof s === "string" ? s : undefined);

const KEY_WORDS: Record<string, string> = {
  sectionId: "section", assigneeId: "assignee", approverId: "approver", leaderId: "leader", userId: "person",
  newLeaderId: "leader", movedTo: "moved to", dueDate: "due date", blockedReason: "blocked because",
};
const SKIP = new Set(["title", "name", "id", "updatedAt", "description", "completedAt", "subtasksCompleted"]);

/** Ids in before/after state are shown as names. `names` maps section and user ids to labels. */
function describe(a: { action: string; beforeState: unknown; afterState: unknown; targetId: string }, names: Map<string, string>) {
  const b = (a.beforeState ?? {}) as Record<string, unknown>;
  const f = (a.afterState ?? {}) as Record<string, unknown>;
  const label = name(f.title) ?? name(b.title) ?? name(f.name) ?? name(b.name) ?? names.get(`t:${a.targetId}`);
  const base = ACTION_WORDS[a.action] ?? a.action;
  const show = (v: unknown) => (v === null || v === undefined || v === "" ? "none" : typeof v === "string" ? names.get(v) ?? v : String(v));
  const detail: string[] = [];
  for (const k of Object.keys(f)) {
    if (SKIP.has(k) && !(k === "name" && a.action === "section.renamed")) continue;
    const from = b[k], to = f[k];
    if ((typeof to === "object" && to !== null) || (typeof from === "object" && from !== null)) continue;
    if (from === to) continue;
    if (/^(subtasks|tasks)/.test(k)) continue;
    detail.push(`${KEY_WORDS[k] ?? k}: ${show(from)} → ${show(to)}`);
  }
  return { what: label ? `${base} "${label}"` : base, change: detail.slice(0, 4).join(" · ") || null };
}

export async function projectActivity(user: Actor, projectId: string, cursor?: string, limit = 50) {
  requireManage(await projectAccess(user, projectId));
  const rows = await db.actionLog.findMany({
    where: { projectId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: { actor: { select: { name: true } } },
  });
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  const ids = new Set<string>();
  for (const r of page) for (const st of [r.beforeState, r.afterState]) for (const v of Object.values((st ?? {}) as Record<string, unknown>)) if (typeof v === "string" && v.length > 20) ids.add(v);
  const [users, sections] = await Promise.all([
    db.user.findMany({ where: { id: { in: [...ids] } }, select: { id: true, name: true } }),
    db.section.findMany({ where: { id: { in: [...ids] } }, select: { id: true, name: true } }),
  ]);
  const tasks = await db.task.findMany({ where: { id: { in: page.filter((r) => r.targetType === "task").map((r) => r.targetId) } }, select: { id: true, title: true } });
  const names = new Map<string, string>([...users, ...sections].map((x) => [x.id, x.name] as [string, string]));
  for (const t of tasks) names.set(`t:${t.id}`, t.title);
  return {
    items: page.map((r) => ({
      id: r.id,
      at: r.createdAt.toISOString(),
      who: r.actor.name,
      via: r.channel === "CONCIERGE" ? "concierge" : "screen",
      ...describe(r, names),
    })),
    nextCursor: more ? page[page.length - 1].id : null,
  };
}

// ---- audit log (Super Admin) ----
export const auditQuery = z.object({
  person: z.string().optional(),
  event: z.string().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  cursor: z.string().optional(),
});

export async function auditLog(user: Actor, q: z.infer<typeof auditQuery>) {
  if (user.orgRole !== "SUPER_ADMIN") throw new ApiError(404, "Resource not found");
  const IST = "+05:30";
  const rows = await db.auditLog.findMany({
    where: {
      ...(q.person ? { actorId: q.person } : {}),
      ...(q.event ? { event: q.event } : {}),
      createdAt: {
        ...(q.from ? { gte: new Date(`${q.from}T00:00:00${IST}`) } : {}),
        ...(q.to ? { lt: new Date(new Date(`${q.to}T00:00:00${IST}`).getTime() + 86400_000) } : {}),
      },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 101,
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    include: { actor: { select: { name: true, email: true } } },
  });
  const events = await db.auditLog.findMany({ distinct: ["event"], select: { event: true }, orderBy: { event: "asc" } });
  const page = rows.slice(0, 100);
  return {
    events: events.map((e) => e.event),
    items: page.map((r) => ({
      id: r.id,
      at: r.createdAt.toISOString(),
      who: r.actor?.name ?? null,
      email: r.actor?.email ?? null,
      event: r.event,
      ip: r.ip,
      target: r.targetType ? `${r.targetType} ${r.targetId}` : null,
    })),
    nextCursor: rows.length > 100 ? page[page.length - 1].id : null,
  };
}

// ---- profile ----
export const profileInput = z.object({ name: z.string().trim().min(1).max(80) });
export const passwordChange = z
  .object({ current: z.string().min(1), password: passwordField, confirm: z.string() })
  .refine((v) => v.password === v.confirm, { message: "Passwords do not match.", path: ["confirm"] });

export async function updateName(user: Actor, name: string) {
  const u = await db.user.update({ where: { id: user.id }, data: { name } });
  return { id: u.id, name: u.name };
}

export async function changePassword(user: Actor, current: string, password: string) {
  const u = await db.user.findUniqueOrThrow({ where: { id: user.id } });
  if (!(await verifyPassword(current, u.passwordHash))) throw new ApiError(400, "Your current password is not correct.");
  const keep = await currentSessionId();
  await db.$transaction([
    db.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(password) } }),
    db.session.updateMany({ where: { userId: user.id, revokedAt: null, ...(keep ? { id: { not: keep } } : {}) }, data: { revokedAt: new Date() } }),
    db.auditLog.create({ data: { event: "PASSWORD_CHANGED", actorId: user.id, channel: "SCREEN" } }),
  ]);
}

export async function listSessions(user: Actor) {
  const here = await currentSessionId();
  const rows = await db.session.findMany({
    where: { userId: user.id, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastSeenAt: "desc" },
  });
  return rows.map((s) => ({
    id: s.id,
    device: deviceLabel(s.userAgent),
    lastActive: s.lastSeenAt.toISOString(),
    current: s.id === here,
  }));
}

export async function signOutOthers(user: Actor) {
  const keep = await currentSessionId();
  const r = await db.session.updateMany({
    where: { userId: user.id, revokedAt: null, ...(keep ? { id: { not: keep } } : {}) },
    data: { revokedAt: new Date() },
  });
  return r.count;
}

// ---- retention ----
export async function purgeOld() {
  const now = Date.now();
  const notes = await db.notification.deleteMany({ where: { createdAt: { lt: new Date(now - NOTE_DAYS * 86400_000) } } });
  const cut = new Date();
  cut.setMonth(cut.getMonth() - LOG_MONTHS);
  const actions = await db.actionLog.deleteMany({ where: { createdAt: { lt: cut } } });
  const audits = await db.auditLog.deleteMany({ where: { createdAt: { lt: cut } } });
  const sessions = await db.session.deleteMany({ where: { expiresAt: { lt: new Date(now - 7 * 86400_000) } } });
  return { notifications: notes.count, actionLogs: actions.count, auditLogs: audits.count, sessions: sessions.count };
}
