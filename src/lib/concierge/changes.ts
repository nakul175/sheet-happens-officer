// SHO-US-8.3: proposed changes. The model can only PROPOSE; this file turns a proposal into typed
// operations, shows them as a card (with before and after), re-checks permission, fingerprints the
// records the card was based on, and on Confirm calls the existing lib functions so every existing
// rule, notice, audit row and Undo record applies.
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/http";
import { WORKERS, activeMember, projectAccess, type Actor } from "@/lib/access";
import { formatDueDate } from "@/lib/dates";
import type { Handover } from "@/lib/people";
import { addMember, changeMemberRole, createProject, removeMember } from "@/lib/projects";
import {
  addCollaborator, assignTask, awaiting, canClose, completeTask, createTask, deleteTask, moveTask, removeCollaborator, reopenTask,
  sendBack, sendForApproval, setApprover, updateTask, visibleTask,
} from "@/lib/tasks";
import { addComment, commentExcerpt } from "@/lib/comments";
import { fullDate } from "@/lib/concierge/dates";
import type { Card } from "@/lib/concierge/types";

export const MAX_CHANGES = 10;
type Priority = "LOW" | "MEDIUM" | "HIGH" | "URGENT";

export type Op =
  | { k: "task.create"; projectId: string; title: string; description?: string; due?: string | null; priority?: Priority; assigneeId?: string }
  | { k: "task.edit"; taskId: string; title?: string; description?: string | null; due?: string | null; priority?: Priority }
  | { k: "task.section"; taskId: string; sectionId: string }
  | { k: "task.assign"; taskId: string; assigneeId: string }
  | { k: "task.complete" | "task.reopen" | "task.delete" | "task.send_for_approval" | "task.send_back"; taskId: string }
  | { k: "task.collab"; taskId: string; userId: string; add: boolean }
  | { k: "task.approver"; taskId: string; approverId: string | null }
  | { k: "task.blocked"; taskId: string; blocked: boolean; reason?: string | null }
  | { k: "task.comment"; taskId: string; text: string }
  | { k: "project.create"; name: string; description?: string; leaderId: string }
  | { k: "member.add"; projectId: string; userId: string; role: "EDITOR" | "VIEWER" }
  | { k: "member.role"; projectId: string; userId: string; role: "EDITOR" | "VIEWER" }
  | { k: "member.remove"; projectId: string; userId: string };

// ------------------------------------------------------------------ loading
const taskInclude = {
  project: { select: { id: true, name: true, archivedAt: true } },
  assignee: { select: { id: true, name: true } },
  approver: { select: { id: true, name: true } },
  section: { select: { id: true, name: true, isDone: true } },
  collaborators: { select: { userId: true } },
  subtasks: { where: { deletedAt: null }, select: { id: true, completedAt: true } },
} as const;
type TaskFull = NonNullable<Awaited<ReturnType<typeof loadTasks>>[number]>;
const loadTasks = (ids: string[]) => db.task.findMany({ where: { id: { in: ids } }, include: taskInclude });

type Loaded = {
  tasks: Map<string, TaskFull>;
  users: Map<string, { id: string; name: string; email: string; deactivatedAt: Date | null; emailVerifiedAt: Date | null }>;
  projects: Map<string, { id: string; name: string; archivedAt: Date | null; members: { userId: string; role: string }[] }>;
  sections: Map<string, { id: string; name: string; isDone: boolean; projectId: string }>;
  held: Map<string, { id: string; title: string }[]>; // "projectId|userId" -> open tasks the person holds
};

const refs = (op: Op) => ({
  taskId: "taskId" in op ? op.taskId : undefined,
  projectId: "projectId" in op ? op.projectId : undefined,
  userIds: [
    "userId" in op ? op.userId : undefined, "assigneeId" in op ? op.assigneeId : undefined,
    "approverId" in op ? op.approverId ?? undefined : undefined, "leaderId" in op ? op.leaderId : undefined,
  ].filter((x): x is string => !!x),
  sectionId: "sectionId" in op ? op.sectionId : undefined,
});

async function load(ops: Op[]): Promise<Loaded> {
  const r = ops.map(refs);
  const taskIds = [...new Set(r.map((x) => x.taskId).filter((x): x is string => !!x))];
  const tasks = new Map((await loadTasks(taskIds)).map((t) => [t.id, t]));
  const projectIds = new Set([...r.map((x) => x.projectId), ...[...tasks.values()].map((t) => t.projectId)].filter((x): x is string => !!x));
  const userIds = new Set(r.flatMap((x) => x.userIds));
  for (const t of tasks.values()) { userIds.add(t.assigneeId); if (t.approverId) userIds.add(t.approverId); }
  const sectionIds = r.map((x) => x.sectionId).filter((x): x is string => !!x);
  const [users, projects, sections] = await Promise.all([
    db.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, name: true, email: true, deactivatedAt: true, emailVerifiedAt: true } }),
    // project-lookup-ok: Internal snapshot for fingerprints; buildCard checks read access before loading, and blockedReason checks writes before execution.
    db.project.findMany({ where: { id: { in: [...projectIds] } }, select: { id: true, name: true, archivedAt: true, members: { select: { userId: true, role: true } } } }),
    db.section.findMany({ where: { id: { in: sectionIds } }, select: { id: true, name: true, isDone: true, projectId: true } }),
  ]);
  const held = new Map<string, { id: string; title: string }[]>();
  for (const op of ops) {
    if (op.k === "member.remove" || (op.k === "member.role" && op.role === "VIEWER")) {
      held.set(`${op.projectId}|${op.userId}`, await db.task.findMany({
        where: { projectId: op.projectId, assigneeId: op.userId, completedAt: null, deletedAt: null },
        select: { id: true, title: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }));
    }
  }
  return {
    tasks, held,
    users: new Map(users.map((u) => [u.id, u])),
    projects: new Map(projects.map((p) => [p.id, p])),
    sections: new Map(sections.map((s) => [s.id, s])),
  };
}

// ------------------------------------------------------------------ fingerprint (stale-card check, AC7)
function hashOf(L: Loaded): string {
  const snap = {
    tasks: [...L.tasks.values()].map((t) => [
      t.id, t.updatedAt.toISOString(), t.deletedAt?.toISOString() ?? null, t.title, t.dueDate?.toISOString() ?? null, t.priority, t.assigneeId, t.approverId,
      t.completedAt?.toISOString() ?? null, t.blocked, t.sectionId, t.collaborators.map((c) => c.userId).sort(), t.subtasks.filter((s) => !s.completedAt).length,
    ]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    projects: [...L.projects.values()].map((p) => [p.id, p.name, p.archivedAt?.toISOString() ?? null, p.members.map((m) => `${m.userId}:${m.role}`).sort()]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    users: [...L.users.values()].map((u) => [u.id, !!u.deactivatedAt, !!u.emailVerifiedAt]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    held: [...L.held.entries()].map(([k, v]) => [k, v.map((t) => t.id)]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  };
  return createHash("sha256").update(JSON.stringify(snap)).digest("hex");
}

/** One load: the fingerprint and each task's updatedAt at that moment, so the two cannot disagree. */
async function stamp(ops: Op[]) {
  const L = await load(ops);
  return {
    fingerprint: hashOf(L),
    versions: Object.fromEntries([...L.tasks.values()].map((t) => [t.id, t.updatedAt.toISOString()])),
  };
}

export async function fingerprint(ops: Op[]): Promise<string> {
  return (await stamp(ops)).fingerprint;
}

// ------------------------------------------------------------------ text
/** Long text is shown as an excerpt that says how much is not shown, so nothing is approved unseen. */
export const EXCERPT = 300;
export const excerpt = (s: string, n = EXCERPT) => (s.length > n ? `${s.slice(0, n)}… (+${s.length - n} more characters)` : s);
const q = (s: string) => `'${s}'`;
const PRIORITY: Record<string, string> = { LOW: "Low", MEDIUM: "Medium", HIGH: "High", URGENT: "Urgent" };
const ROLE: Record<string, string> = { EDITOR: "Editor", VIEWER: "Viewer", LEADER: "Leader" };
const dueText = (d: Date | string | null | undefined) => (d ? fullDate(typeof d === "string" ? new Date(Date.parse(`${d}T00:00:00Z`) - 5.5 * 3600_000) : d) : "none");
const toDate = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) - 5.5 * 3600_000);

type Described = { phrase: string; row: { label: string; before?: string; after?: string } };

function gone(what: string): never {
  throw new ApiError(404, `${what} not found`);
}
function T(L: Loaded, id: string) {
  const t = L.tasks.get(id);
  if (!t || t.deletedAt) gone("Task");
  return t;
}
const U = (L: Loaded, id: string) => L.users.get(id) ?? gone("Person");
const P = (L: Loaded, id: string) => L.projects.get(id) ?? gone("Project");

function describe(op: Op, L: Loaded): Described {
  const task = (id: string) => T(L, id);
  const where = (t: TaskFull) => `${t.title} (${t.project.name})`;
  switch (op.k) {
    case "task.create": {
      const p = P(L, op.projectId);
      const after = [op.description ? `Description: ${excerpt(op.description)}` : null, op.due ? `Due ${dueText(op.due)}` : null, op.priority ? `Priority ${PRIORITY[op.priority]}` : null, op.assigneeId ? `Assigned to ${U(L, op.assigneeId).name}` : null].filter(Boolean).join("; ");
      return { phrase: `Create task ${q(op.title)} in ${p.name}`, row: { label: `New task in ${p.name}`, after: `${op.title}${after ? `; ${after}` : ""}` } };
    }
    case "task.edit": {
      const t = task(op.taskId);
      const before: string[] = [], after: string[] = [];
      if (op.title !== undefined) { before.push(`Title ${q(t.title)}`); after.push(`Title ${q(op.title)}`); }
      if (op.description !== undefined) {
        before.push(`Description: ${t.description ? excerpt(t.description) : "none"}`);
        after.push(`Description: ${op.description ? excerpt(op.description) : "cleared"}`);
      }
      if (op.due !== undefined) { before.push(`Due ${dueText(t.dueDate)}`); after.push(`Due ${dueText(op.due)}`); }
      if (op.priority !== undefined) { before.push(`Priority ${PRIORITY[t.priority]}`); after.push(`Priority ${PRIORITY[op.priority]}`); }
      const onlyDue = op.due !== undefined && op.title === undefined && op.description === undefined && op.priority === undefined;
      const phrase = onlyDue ? (op.due ? `Move ${q(t.title)} to ${dueText(op.due)}` : `Remove the due date from ${q(t.title)}`) : `Edit ${q(t.title)}`;
      return { phrase, row: { label: where(t), before: before.join("; "), after: after.join("; ") } };
    }
    case "task.section": {
      const t = task(op.taskId); const s = L.sections.get(op.sectionId) ?? gone("Section");
      return { phrase: `Move ${q(t.title)} to ${s.name}`, row: { label: where(t), before: `Section ${t.section.name}`, after: `Section ${s.name}` } };
    }
    case "task.assign": {
      const t = task(op.taskId); const u = U(L, op.assigneeId);
      return { phrase: `Assign ${q(t.title)} to ${u.name}`, row: { label: where(t), before: `Assigned to ${t.assignee.name}`, after: `Assigned to ${u.name}` } };
    }
    case "task.complete": {
      const t = task(op.taskId); const open = t.subtasks.filter((s) => !s.completedAt).length;
      return { phrase: `Complete ${q(t.title)}`, row: { label: where(t), before: "Open", after: open ? `Completed, with ${open} open subtask${open === 1 ? "" : "s"}` : "Completed" } };
    }
    case "task.reopen": { const t = task(op.taskId); return { phrase: `Reopen ${q(t.title)}`, row: { label: where(t), before: "Completed", after: "Open" } }; }
    case "task.delete": { const t = task(op.taskId); return { phrase: `Move ${q(t.title)} to Trash`, row: { label: where(t), before: "In the project", after: "In Trash (30 days)" } }; }
    case "task.send_for_approval": { const t = task(op.taskId); return { phrase: `Send ${q(t.title)} for approval`, row: { label: where(t), before: `Held by ${t.assignee.name}`, after: `Held by ${t.approver?.name ?? "the approver"} for approval` } }; }
    case "task.send_back": { const t = task(op.taskId); return { phrase: `Send ${q(t.title)} back`, row: { label: where(t), before: "Awaiting approval", after: "Sent back to the previous holder" } }; }
    case "task.collab": {
      const t = task(op.taskId); const u = U(L, op.userId);
      return op.add
        ? { phrase: `Add ${u.name} as collaborator on ${q(t.title)}`, row: { label: where(t), after: `Collaborator ${u.name} added` } }
        : { phrase: `Remove ${u.name} as collaborator on ${q(t.title)}`, row: { label: where(t), before: `Collaborator ${u.name}`, after: "Not a collaborator" } };
    }
    case "task.approver": {
      const t = task(op.taskId); const u = op.approverId ? U(L, op.approverId) : null;
      return {
        phrase: u ? `Make ${u.name} the approver of ${q(t.title)}` : `Remove the approver from ${q(t.title)}`,
        row: { label: where(t), before: `Approver ${t.approver?.name ?? "none"}`, after: `Approver ${u?.name ?? "none"}` },
      };
    }
    case "task.blocked": {
      const t = task(op.taskId);
      return {
        phrase: op.blocked ? `Mark ${q(t.title)} as blocked` : `Clear Blocked on ${q(t.title)}`,
        row: { label: where(t), before: t.blocked ? "Blocked" : "Not blocked", after: op.blocked ? `Blocked${op.reason ? `: ${op.reason}` : ""}` : "Not blocked" },
      };
    }
    case "task.comment": {
      const t = task(op.taskId);
      return { phrase: `Comment on ${q(t.title)}`, row: { label: where(t), after: commentExcerpt(op.text) } };
    }
    case "project.create": return { phrase: `Create project ${q(op.name)}`, row: { label: "New project", after: `${op.name}; Leader ${U(L, op.leaderId).name}${op.description ? `; Description: ${excerpt(op.description)}` : ""}` } };
    case "member.add": {
      const p = P(L, op.projectId); const u = U(L, op.userId);
      return { phrase: `Add ${u.name} to ${q(p.name)} as ${ROLE[op.role]}`, row: { label: p.name, after: `${u.name} joins as ${ROLE[op.role]}` } };
    }
    case "member.role": {
      const p = P(L, op.projectId); const u = U(L, op.userId); const cur = p.members.find((m) => m.userId === op.userId);
      return { phrase: `Change ${u.name} to ${ROLE[op.role]} in ${q(p.name)}`, row: { label: `${u.name} in ${p.name}`, before: `Role ${ROLE[cur?.role ?? ""] ?? "none"}`, after: `Role ${ROLE[op.role]}` } };
    }
    case "member.remove": {
      const p = P(L, op.projectId); const u = U(L, op.userId); const n = L.held.get(`${op.projectId}|${op.userId}`)?.length ?? 0;
      return { phrase: `Remove ${u.name} from ${q(p.name)}`, row: { label: `${u.name} in ${p.name}`, before: "Member", after: n ? `Removed; ${n} open task${n === 1 ? "" : "s"} handed over` : "Removed" } };
    }
  }
}

const PAST: Record<string, string> = {
  Move: "Moved", Create: "Created", Edit: "Edited", Assign: "Assigned", Complete: "Completed", Reopen: "Reopened", Add: "Added", Make: "Made",
  Remove: "Removed", Send: "Sent", Mark: "Marked", Clear: "Cleared", Change: "Changed", Comment: "Commented",
};
export const pastTense = (phrase: string) => phrase.replace(/^\w+/, (w) => PAST[w] ?? w);

// ------------------------------------------------------------------ permission pre-check
/** Why the person cannot make this change, or null. The same rules are enforced again by the lib functions on Confirm. */
async function blockedReason(user: Actor, op: Op, L: Loaded): Promise<string | null> {
  try {
    const needWrite = async (projectId: string) => {
      const a = await projectAccess(user, projectId, { write: true });
      if (a.role === "VIEWER") return "Viewers cannot make changes.";
      return a;
    };
    if (op.k === "project.create") {
      const lead = U(L, op.leaderId);
      return lead.deactivatedAt || !lead.emailVerifiedAt ? "Choose an active person as Leader." : null;
    }
    if (op.k === "task.create") {
      const a = await needWrite(op.projectId);
      if (typeof a === "string") return a;
      if (op.assigneeId && !(await activeMember(db, op.projectId, op.assigneeId, WORKERS))) return `${U(L, op.assigneeId).name} must be an active Leader or Editor of this project.`;
      return null;
    }
    if (op.k === "member.add" || op.k === "member.role" || op.k === "member.remove") {
      const a = await projectAccess(user, op.projectId, { write: true });
      if (a.role !== "LEADER") return "Only the project Leader or an Admin can do this.";
      const m = a.project.members.find((x) => x.userId === op.userId);
      const person = U(L, op.userId);
      if (op.k === "member.add") {
        if (person.deactivatedAt || !person.emailVerifiedAt) return "Choose an active person.";
        return m ? `${person.name} is already a member.` : null;
      }
      if (!m) return `${person.name} is not a member of this project.`;
      if (m.role === "LEADER") return "The Leader can only be replaced from the project's Members screen.";
      if (op.k === "member.role" && m.role === op.role) return `${person.name} already has that role.`;
      return null;
    }
    // task operations
    const t = T(L, op.taskId);
    const a = await needWrite(t.projectId);
    if (typeof a === "string") return a;
    const holder = awaiting(t) && user.id === t.approverId && a.role !== "LEADER";
    if (holder && op.k !== "task.complete" && op.k !== "task.send_back" && op.k !== "task.comment") return "While you hold this task for approval you can only close it or send it back.";
    switch (op.k) {
      case "task.complete":
        if (t.completedAt) return "This task is already complete.";
        return canClose(user.id, a.role, t) ? null : t.approverId ? "Only the approver, the Leader or an Admin can close this task." : "You cannot complete this task.";
      case "task.reopen": return t.completedAt ? null : "This task is not complete.";
      case "task.assign": {
        if (t.approverId && user.id === t.assigneeId && op.assigneeId !== t.approverId && a.role !== "LEADER") return "With an approver, this task can only be handed to the approver.";
        return (await activeMember(db, t.projectId, op.assigneeId, WORKERS)) ? null : `${U(L, op.assigneeId).name} must be an active Leader or Editor of this project.`;
      }
      case "task.section": {
        const s = L.sections.get(op.sectionId);
        if (!s || s.projectId !== t.projectId) return "That section is not in this project.";
        if (s.isDone) return "To finish a task, ask me to complete it instead.";
        return t.parentId ? "Subtasks move with their parent task." : t.completedAt ? "Reopen this task first." : null;
      }
      case "task.collab": {
        if (op.add) {
          if (t.collaborators.some((c) => c.userId === op.userId)) return "That person is already a collaborator.";
          return (await activeMember(db, t.projectId, op.userId)) ? null : "Collaborators must be active members of this project.";
        }
        return t.collaborators.some((c) => c.userId === op.userId) ? null : "That person is not a collaborator on this task.";
      }
      case "task.approver": {
        if (t.parentId) return "Subtasks do not have an approver.";
        if (user.id === t.assigneeId) return "The assignee cannot change their own task's approver.";
        if (awaiting(t) && a.role !== "LEADER") return "Only the Leader or an Admin can change the approver while a task awaits approval.";
        if (!awaiting(t) && a.role !== "LEADER" && t.createdById !== user.id) return "Only the Leader, an Admin or the task's creator can set the approver.";
        if (op.approverId) {
          if (op.approverId === t.assigneeId && !awaiting(t)) return "The approver cannot be the assignee.";
          if (op.approverId === t.approverId) return "That person is already the approver.";
          if (!(await activeMember(db, t.projectId, op.approverId, WORKERS))) return "The approver must be an active Leader or Editor of this project.";
        }
        return null;
      }
      case "task.send_for_approval":
        if (!t.approverId) return "This task has no approver.";
        if (awaiting(t)) return "This task is already awaiting approval.";
        return user.id === t.assigneeId ? null : "Only the assignee can send a task for approval.";
      case "task.send_back":
        if (!awaiting(t)) return "This task is not awaiting approval.";
        return user.id === t.approverId || a.role === "LEADER" ? null : "Only the approver, the Leader or an Admin can send this back.";
      default: return null;
    }
  } catch (e) {
    if (e instanceof ApiError) return e.status === 404 ? "I can't find that." : e.message;
    throw e;
  }
}

// ------------------------------------------------------------------ cards
export type BuiltCard = {
  card: Omit<Card, "id" | "status">;
  fingerprint: string;
  ops: Op[];
  /** updatedAt (ISO) of each task when the card was built. Execute checks this, not a later read. */
  versions: Record<string, string>;
};

/** Builds the card for these operations from the records as they are now. Throws ApiError(404) when a record is gone. */
export async function buildCard(user: Actor, ops: Op[]): Promise<BuiltCard> {
  if (ops.length > MAX_CHANGES) throw new ApiError(400, "A card can hold at most 10 changes.");
  // A blocked write card still contains names, before-values and handover tasks. Check read visibility first,
  // including when an old card is refreshed after membership or CRM visibility changed. A Viewer may read a
  // blocked card; an outsider must get no card at all. Write permission is checked separately below.
  const references = ops.map(refs);
  for (const id of new Set(references.flatMap((r) => r.taskId ? [r.taskId] : []))) await visibleTask(user, id);
  for (const id of new Set(references.flatMap((r) => r.projectId ? [r.projectId] : []))) await projectAccess(user, id);
  const L = await load(ops);
  const described = ops.map((op) => describe(op, L));
  let blocked: string | null = null;
  for (const op of ops) { blocked = blocked ?? (await blockedReason(user, op, L)); }

  // Hand-over: a person who leaves, or becomes a Viewer, must not leave tasks without a holder.
  let handover: Card["handover"];
  let handoverOptions: Card["handoverOptions"];
  let irreversible = false;
  const leaving = ops.filter((o) => o.k === "member.remove" || (o.k === "member.role" && o.role === "VIEWER"));
  if (leaving.length > 1) throw new ApiError(400, "Remove or demote one person at a time.");
  if (leaving[0] && (leaving[0].k === "member.remove" || leaving[0].k === "member.role")) {
    const op = leaving[0];
    const tasks = L.held.get(`${op.projectId}|${op.userId}`) ?? [];
    if (tasks.length) {
      handover = tasks.map((t) => ({ taskId: t.id, taskTitle: t.title }));
      const members = await db.projectMember.findMany({ where: { projectId: op.projectId, role: { in: ["LEADER", "EDITOR"] }, userId: { not: op.userId }, user: { deactivatedAt: null, emailVerifiedAt: { not: null } } }, include: { user: { select: { name: true } } } });
      handoverOptions = members.map((m) => ({ id: m.userId, name: m.user.name })).sort((a, b) => a.name.localeCompare(b.name));
    }
    if (op.k === "member.remove") {
      // Anything handed over, dropped or re-approved cannot be put back by Undo.
      const extra = await db.task.count({ where: { projectId: op.projectId, deletedAt: null, OR: [{ approverId: op.userId }, { collaborators: { some: { userId: op.userId } } }] } });
      irreversible = tasks.length > 0 || extra > 0;
    } else irreversible = tasks.length > 0;
  }
  if (ops.some((o) => o.k === "project.create")) irreversible = true; // creating a project has no Undo

  const title = ops.length === 1 ? described[0].phrase : `Make ${ops.length} changes`;
  const sealed = await stamp(ops);
  return {
    ops,
    fingerprint: sealed.fingerprint,
    versions: sealed.versions,
    card: {
      title,
      changes: described.map((d) => d.row),
      canConfirm: !blocked,
      ...(blocked ? { blockedReason: blocked } : {}),
      ...(irreversible ? { irreversible: true } : {}),
      ...(handover ? { handover, handoverOptions } : {}),
    },
  };
}

export const summaryOf = async (ops: Op[]) => {
  const L = await load(ops);
  return ops.map((op) => pastTense(describe(op, L).phrase));
};

// ------------------------------------------------------------------ Confirm
/** Re-checks permission with fresh data and returns the reason it is not allowed, if any. */
export async function recheck(user: Actor, ops: Op[]) {
  const L = await load(ops);
  for (const op of ops) {
    const r = await blockedReason(user, op, L);
    if (r) return r;
  }
  return null;
}

/**
 * Applies the operations through the existing functions. Runs inside the caller's request context.
 * `versions` is each task's updatedAt when the card was built (APL-2667). A save after the Confirm
 * fingerprint no longer matches, so it is refused. After each write the map follows the updatedAt
 * that write stored, so later ops on the same task in this card still apply. Omitting `versions`
 * re-reads the current row; that path is only for a direct call with no stored card.
 */
export async function execute(user: Actor, ops: Op[], handover: { taskId: string; assigneeId: string }[] = [], onDone?: () => void, versions?: Record<string, string>) {
  const carried = versions ? new Map(Object.entries(versions)) : null;
  const versionFor = async (taskId: string) => {
    if (!carried) return (await db.task.findUnique({ where: { id: taskId }, select: { updatedAt: true } }))?.updatedAt.toISOString() ?? "";
    const v = carried.get(taskId);
    if (v === undefined) throw new ApiError(409, "This task changed while you were editing it.", { stale: true });
    return v;
  };
  const remember = (taskId: string, updatedAt?: Date) => {
    if (carried && updatedAt) carried.set(taskId, updatedAt.toISOString());
  };
  const done: Op[] = [];
  // Every task a leaving person holds must have a taker BEFORE the first write, so this cannot fail half way.
  for (const op of ops) {
    if (op.k !== "member.remove" && !(op.k === "member.role" && op.role === "VIEWER")) continue;
    const held = await db.task.findMany({ where: { projectId: op.projectId, assigneeId: op.userId, completedAt: null, deletedAt: null }, select: { id: true } });
    for (const t of held) if (!handover.find((h) => h.taskId === t.id)?.assigneeId) throw new ApiError(409, "Their tasks changed since the card was shown. Nothing was written.", { stale: true });
  }
  for (const op of ops) {
    switch (op.k) {
      case "task.create":
        await createTask(user, op.projectId, { title: op.title, description: op.description, dueDate: op.due ?? undefined, priority: op.priority, assigneeId: op.assigneeId });
        break;
      case "task.edit":
        remember(op.taskId, await updateTask(user, op.taskId, {
          expectedUpdatedAt: await versionFor(op.taskId),
          ...(op.title !== undefined ? { title: op.title } : {}), ...(op.description !== undefined ? { description: op.description } : {}),
          ...(op.due !== undefined ? { dueDate: op.due } : {}), ...(op.priority !== undefined ? { priority: op.priority } : {}),
        }));
        break;
      case "task.section": remember(op.taskId, await moveTask(user, op.taskId, op.sectionId, await versionFor(op.taskId))); break;
      case "task.assign": remember(op.taskId, await assignTask(user, op.taskId, op.assigneeId, await versionFor(op.taskId))); break;
      case "task.complete": remember(op.taskId, await completeTask(user, op.taskId, await versionFor(op.taskId), true)); break;
      case "task.reopen": remember(op.taskId, await reopenTask(user, op.taskId)); break;
      case "task.delete": remember(op.taskId, await deleteTask(user, op.taskId)); break;
      case "task.send_for_approval": remember(op.taskId, await sendForApproval(user, op.taskId)); break;
      case "task.send_back": remember(op.taskId, await sendBack(user, op.taskId)); break;
      case "task.collab": await (op.add ? addCollaborator(user, op.taskId, op.userId) : removeCollaborator(user, op.taskId, op.userId)); break;
      case "task.approver": remember(op.taskId, await setApprover(user, op.taskId, op.approverId, await versionFor(op.taskId))); break;
      case "task.blocked": remember(op.taskId, await updateTask(user, op.taskId, { expectedUpdatedAt: await versionFor(op.taskId), blocked: op.blocked, ...(op.blocked ? { blockedReason: op.reason ?? null } : {}) })); break;
      case "task.comment": await addComment(user, op.taskId, { text: op.text }); break;
      case "project.create": await createProject(user, { name: op.name, description: op.description, leaderId: op.leaderId }); break;
      case "member.add": await addMember(user, op.projectId, op.userId, op.role); break;
      case "member.role":
      case "member.remove": {
        // Each task goes to the person chosen for it (no "leave unassigned"), inside the one removal transaction, so the
        // notices and the member.removed row come out exactly as from the Members screen (SHO-BUG-7).
        const held = await db.task.findMany({ where: { projectId: op.projectId, assigneeId: op.userId, completedAt: null, deletedAt: null }, select: { id: true } });
        const picks: Handover[] = [];
        for (const t of held) {
          const to = handover.find((h) => h.taskId === t.id)?.assigneeId;
          if (!to) throw new ApiError(400, "Choose who takes each of their tasks first.");
          picks.push({ taskId: t.id, assigneeId: to });
        }
        if (op.k === "member.role") await changeMemberRole(user, op.projectId, op.userId, op.role, undefined, picks);
        else await removeMember(user, op.projectId, op.userId, undefined, picks);
        break;
      }
    }
    done.push(op);
    onDone?.();
  }
  return done;
}

/** Validates the hand-over the person chose: every held task has a taker from the offered list. */
export function checkHandover(card: Card, chosen: { taskId: string; assigneeId: string }[] | undefined) {
  if (!card.handover?.length) return;
  const ok = new Set((card.handoverOptions ?? []).map((o) => o.id));
  for (const h of card.handover) {
    const c = chosen?.find((x) => x.taskId === h.taskId);
    if (!c || !ok.has(c.assigneeId)) throw new ApiError(400, "Choose who takes each task before you confirm.");
  }
}

export { formatDueDate, toDate };
