// Read side for the bell, the project Activity page, the Audit log and Profile
// (SHO-US-7.1, 6.3, 6.5, 1.6).
import { z } from "zod";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/http";
import { currentSessionId, deviceLabel, hashPassword, verifyPassword } from "@/lib/auth";
import { WORKSTREAM_DEAL, crmVisible, isAdmin, projectAccess, type Actor } from "@/lib/access";
import { idsIn, sentence, whenText } from "@/lib/activity-text";
import { UNDO_DAYS, isUndoable } from "@/lib/undoable";
import { passwordField } from "@/lib/schemas";

const NOTE_DAYS = 90;
const LOG_MONTHS = 12;

type N = { type: string; actor: { name: string } | null; taskId: string | null; projectId: string | null; data: unknown };

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** Tail for a person who lost access: tasks named when few, counted when 5 or more (SHO-US-7.2 AC3). */
function leftNote(d: Record<string, unknown>) {
  const count = Number(d.handedOverCount ?? 0);
  const titles = Array.isArray(d.handedOver) ? (d.handedOver as string[]) : [];
  const dropped = Number(d.droppedCount ?? 0);
  const parts: string[] = [];
  if (count) parts.push(titles.length ? `Your open ${count === 1 ? "task" : "tasks"} ${titles.map((x) => `"${x}"`).join(", ")} ${count === 1 ? "was" : "were"} handed to someone else.` : `${plural(count, "open task")} of yours were handed to someone else.`);
  if (dropped) parts.push(`You were taken off ${plural(dropped, "task")} as a collaborator.`);
  return parts.length ? " " + parts.join(" ") : "";
}

function handoverText(who: string, d: Record<string, unknown>, p: string) {
  const from = String(d.fromName ?? "A person");
  const bits: string[] = [];
  const moved = Number(d.moved ?? 0), toMe = Number(d.movedToYou ?? 0), approver = Number(d.approver ?? 0), cleared = Number(d.cleared ?? 0);
  if (toMe) bits.push(`${plural(toMe, "open task")} ${toMe === 1 ? "is" : "are"} now yours`); // a per-task hand-over split between the Leader and others (SHO-BUG-7)
  if (moved) bits.push(d.toYou ? `${plural(moved, "open task")} ${moved === 1 ? "is" : "are"} now yours` : `${plural(moved, "open task")} went to ${String(d.to ?? "someone else")}`);
  if (approver) bits.push(`you now approve ${plural(approver, "task")} that ${from} used to approve`);
  if (cleared) bits.push(`${plural(cleared, "task")} no longer ${cleared === 1 ? "has" : "have"} an approver`);
  return `${who} handed over ${from}'s work in ${p}: ${bits.join("; ")}.`;
}

/** Text and link for one notice. Wording is plain and says who did what. */
export function noticeText(n: N) {
  const who = n.actor?.name ?? "Someone";
  const d = (n.data ?? {}) as Record<string, unknown>;
  const t = d.title ? `"${d.title}"` : "a task";
  const p = d.project ? `"${d.project}"` : "a project";
  const text: Record<string, string> = {
    TASK_ASSIGNED: `${who} assigned you ${t}.`,
    TASKS_REASSIGNED: d.count ? `${who} assigned you ${d.count} tasks${d.project ? ` in ${p}` : ""}.` : `${who} moved tasks over to you.`,
    TASKS_REASSIGNED_SUMMARY: `${d.count ?? "Some"} tasks in ${p} were handed to a new owner by ${who}.`,
    APPROVER_REASSIGNED: `${who} changed who approves tasks in ${p}.`,
    COLLABORATOR_ADDED: `${who} added you as a collaborator on ${t}.`,
    COLLABORATOR_REMOVED: `${who} removed you from ${t}.`,
    APPROVER_NAMED: `${who} named you the approver of ${t}.`,
    SENT_FOR_APPROVAL: `${who} sent ${t} to you for approval.`,
    SENT_BACK: `${who} sent ${t} back to you.${d.approverCleared ? " It no longer has an approver." : ""}`,
    TASK_BLOCKED: `${who} marked ${t} as blocked${d.reason ? `: ${d.reason}` : ""}.`,
    TASK_DELETED: `${who} moved ${t} to Trash.`,
    REMOVED_AS_ASSIGNEE: `${who} took ${t} off you; someone else now holds it.`,
    APPROVER_CLEARED: `${t} no longer has an approver, because the approver is not on the project any more.`,
    CHANGE_OVERRIDDEN: `${who} undid their own change and replaced your change to ${t}${d.fields ? ` (${d.fields})` : ""}.`,
    TASKS_HANDED_OVER: handoverText(who, d, p),
    RESTORED_TO_LEADER: `${t} was restored to you because its owner is no longer on the project.`,
    MADE_LEADER: `${who} made you Leader of ${p}.`,
    PROJECT_ARCHIVED: `${who} archived ${p}. It is now read-only.`,
    JOIN_REQUESTED: `${who} asked to be added to one of your projects.`,
    ADDED_TO_PROJECT: `${who} added you to ${p} as ${String(d.role ?? "Editor").toLowerCase()}.`,
    PROJECT_ROLE_CHANGED: `${who} changed your role in ${p} to ${String(d.role ?? "").toLowerCase()}.${leftNote(d)}`,
    REMOVED_FROM_PROJECT: `${who} removed you from ${p}.${leftNote(d)}`,
    ORG_ROLE_CHANGED: `${who} changed your role to ${String(d.role ?? "").toLowerCase()}.`,
    TASK_DUE_TOMORROW: `${t} is due tomorrow.`,
    TASK_DUE_TODAY: `${t} is due today.`,
    TASK_OVERDUE: `${t} is overdue${d.daysOverdue ? ` by ${d.daysOverdue} ${d.daysOverdue === 1 ? "day" : "days"}` : ""}.`,
    DEAL_STAGE_CHANGED: `${who} moved ${p} to ${d.stage ?? "another stage"}.`,
    DEAL_NEEDS_NEXT_STEP: `${p} needs a next step.`,
    DEAL_STALLED: `${p} has had no activity for 30 days.`,
    JOB_FAILED: `Scheduled job "${d.job}" failed${d.error ? `: ${d.error}` : ""}.`,
    JOB_MISSED: `Scheduled job "${d.job}" did not run on its day.`,
    CONCIERGE_BUDGET_80: `The concierge has used $${d.spend} of its $${d.ceiling} monthly budget (${d.percent} percent). At the ceiling it pauses until ${d.resumes}.`,
  };
  // A deleted task cannot be opened, so its notice links to the project Trash (SHO-US-7.3 AC1).
  const href = n.type === "TASK_DELETED" && n.projectId ? `/projects/${n.projectId}/trash`
    : n.taskId ? `/tasks/${n.taskId}` : n.projectId ? `/projects/${n.projectId}` : n.type === "JOIN_REQUESTED" ? "/projects" : n.type.startsWith("JOB_") ? "/audit" : n.type.startsWith("CONCIERGE_") ? "/usage" : "/";
  return { text: text[n.type] ?? `${who} made a change.`, href };
}

/** Deal names this person must not read in the bell: the CRM is hidden, or they are not on the deal and not an Admin. */
async function hiddenDealNames(user: Actor, projectIds: (string | null)[]): Promise<Map<string, string>> {
  const ids = [...new Set(projectIds.filter((id): id is string => !!id))];
  const hidden = new Map<string, string>();
  if (!ids.length) return hidden;
  const deals = await db.project.findMany({
    where: { id: { in: ids }, typeId: WORKSTREAM_DEAL },
    select: { id: true, name: true, members: { where: { userId: user.id }, select: { userId: true }, take: 1 } },
  });
  for (const deal of deals) {
    const sees = crmVisible(user) && (isAdmin(user) || deal.members.length > 0);
    if (!sees && deal.name) hidden.set(deal.id, deal.name);
  }
  return hidden;
}

/**
 * Drops a deal name only when a stored value is exactly that name.
 * A short name such as "A" must stay inside "Asha" or "A stage".
 */
export function withoutExactDealName(data: unknown, dealName: string): unknown {
  if (!dealName || !data || typeof data !== "object" || Array.isArray(data)) return data;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (typeof value === "string" && value === dealName) {
      if (key === "project") continue;
      out[key] = "a project";
    } else out[key] = value;
  }
  return out;
}

/** Replaces the deal name only where the sentence quotes that whole name, as in `"A"`. */
export function withoutQuotedDealName(text: string, dealName: string): string {
  if (!dealName) return text;
  return text.split(`"${dealName}"`).join("a project");
}

/** SHO-US-14.13: newest first, 50 at a time; `before` is the `next` value of the previous page. `filter=unread` hides read items. */
export async function listNotifications(user: Actor, o: { filter?: string; before?: string; limit?: number } = {}) {
  const limit = Math.min(Math.max(o.limit ?? 50, 1), 200);
  const [at, cursorId] = (o.before ?? "").split("|");
  const when = at && !Number.isNaN(Date.parse(at)) ? new Date(at) : null;
  const rows = await db.notification.findMany({
    where: {
      recipientId: user.id,
      ...(o.filter === "unread" ? { readAt: null } : {}),
      ...(when ? { OR: [{ createdAt: { lt: when } }, { createdAt: when, id: { lt: cursorId ?? "" } }] } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    include: { actor: { select: { name: true } } },
  });
  const unread = await db.notification.count({ where: { recipientId: user.id, readAt: null } });
  const page = rows.slice(0, limit);
  const hiddenDeals = await hiddenDealNames(user, page.map((n) => n.projectId));
  const last = page.at(-1);
  return {
    unread,
    items: page.map((n) => {
      const dealName = n.projectId ? hiddenDeals.get(n.projectId) : undefined;
      const notice = noticeText(dealName ? { ...n, data: withoutExactDealName(n.data, dealName) } : n);
      const text = dealName ? withoutQuotedDealName(notice.text, dealName) : notice.text;
      return { id: n.id, text, href: notice.href, read: !!n.readAt, createdAt: n.createdAt.toISOString() };
    }),
    next: rows.length > limit && last ? `${last.createdAt.toISOString()}|${last.id}` : null,
  };
}

export async function markRead(user: Actor, id: string) {
  await db.notification.updateMany({ where: { id, recipientId: user.id, readAt: null }, data: { readAt: new Date() } });
}
/** SHO-US-14.13 AC4: keep a notice unread until I have acted on it. */
export async function markUnread(user: Actor, id: string) {
  await db.notification.updateMany({ where: { id, recipientId: user.id, readAt: { not: null } }, data: { readAt: null } });
}
export async function markAllRead(user: Actor) {
  await db.notification.updateMany({ where: { recipientId: user.id, readAt: null }, data: { readAt: new Date() } });
}

// ---- project activity (SHO-US-6.3, 14.14) ----
/**
 * Leader and Admins see the whole project. An Editor sees what happened on tasks they are on
 * (assignee, collaborator or approver), not the whole project. Viewers see nothing here.
 * Every row is a sentence: names, never ids; India-time dates; no field names.
 */
export async function projectActivity(user: Actor, projectId: string, cursor?: string, limit = 50) {
  const a = await projectAccess(user, projectId);
  if (a.role === "VIEWER") throw new ApiError(403, "Only people who work on this project can see Activity.");
  const leader = a.role === "LEADER";
  const mine = leader ? null : (await db.task.findMany({
    where: { projectId, OR: [{ assigneeId: user.id }, { approverId: user.id }, { collaborators: { some: { userId: user.id } } }] },
    select: { id: true },
  })).map((t) => t.id);
  const rows = await db.actionLog.findMany({
    where: { projectId, ...(mine ? { targetType: "task", targetId: { in: mine } } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: { actor: { select: { name: true } } },
  });
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  const ids = [...new Set(page.flatMap((r) => idsIn(r)))];
  const [users, sections, tasks] = await Promise.all([
    db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
    db.section.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
    db.task.findMany({ where: { id: { in: ids } }, select: { id: true, title: true } }),
  ]);
  const names = new Map<string, string>([...users, ...sections].map((x) => [x.id, x.name] as [string, string]));
  for (const t of tasks) names.set(`t:${t.id}`, t.title);
  return {
    items: page.map((r) => ({
      id: r.id,
      ts: r.createdAt.getTime(),
      when: whenText(r.createdAt),
      who: r.actor.name,
      what: sentence(r, names),
      // "How" is only worth a word when it was not the screen (SHO-US-14.14 AC4).
      via: r.channel === "CONCIERGE" ? "concierge" : "screen",
      // Undo stays on the row (AC5); an Editor can only undo their own actions, as the server enforces.
      undo: r.undoneAt ? "undone" : !isUndoable(r.action) || (!leader && r.actorId !== user.id) ? "none"
        : Date.now() - r.createdAt.getTime() > UNDO_DAYS * 86400_000 ? "too_old" : "available",
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
  const byType = (t: string[]) => [...new Set(page.filter((r) => r.targetType && t.includes(r.targetType) && r.targetId).map((r) => r.targetId!))];
  // A "deal" target is the deal's project row (DEAL_CREATED, DEAL_CLOSED), or the task that became one (DEAL_CONVERTED) (SHO-BUG-4).
  const [us, ps, ts, ss] = await Promise.all([
    db.user.findMany({ where: { id: { in: byType(["user", "member"]) } }, select: { id: true, name: true } }),
    db.project.findMany({ where: { id: { in: byType(["project", "deal"]) } }, select: { id: true, name: true } }),
    db.task.findMany({ where: { id: { in: byType(["task", "deal"]) } }, select: { id: true, title: true } }),
    db.section.findMany({ where: { id: { in: byType(["section"]) } }, select: { id: true, name: true } }),
  ]);
  const label = new Map<string, string>([
    ...us.map((x) => [`user:${x.id}`, `Person "${x.name}"`] as [string, string]),
    ...us.map((x) => [`member:${x.id}`, `Member "${x.name}"`] as [string, string]),
    ...ps.map((x) => [`project:${x.id}`, `Project "${x.name}"`] as [string, string]),
    ...ps.map((x) => [`deal:${x.id}`, `Deal "${x.name}"`] as [string, string]),
    ...ts.map((x) => [`task:${x.id}`, `Task "${x.title}"`] as [string, string]),
    ...ts.map((x) => [`deal:${x.id}`, `Task "${x.title}"`] as [string, string]),
    ...ss.map((x) => [`section:${x.id}`, `Section "${x.name}"`] as [string, string]),
  ]);
  return {
    events: events.map((e) => e.event),
    items: page.map((r) => ({
      id: r.id,
      at: r.createdAt.toISOString(),
      who: r.actor?.name ?? null,
      email: r.actor?.email ?? null,
      event: r.event,
      ip: r.ip,
      channel: r.channel === "CONCIERGE" ? "Concierge" : "Screen",
      target: r.targetType ? label.get(`${r.targetType}:${r.targetId}`) ?? `${r.targetType} (removed)` : null,
    })),
    nextCursor: rows.length > 100 ? page[page.length - 1].id : null,
  };
}

// ---- profile ----
export const profileInput = z.object({ name: z.string().trim().min(1).max(100) });
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
    db.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(password), tempPasswordAt: null } }),
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
  await db.auditLog.create({ data: { event: "SIGN_OUT_EVERYWHERE", actorId: user.id, channel: "SCREEN", data: { sessionsEnded: String(r.count) } } });
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
