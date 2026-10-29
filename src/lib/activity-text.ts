// SHO-US-14.14: an action log row as a plain sentence. Names, never ids; dates as "10 Oct"; no field names.
// Pure so it can be tested without a server. `names` maps ids (users, sections, tasks as "t:<id>") to labels.

const IST_MS = 5.5 * 3600_000;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
type Row = { action: string; beforeState: unknown; afterState: unknown; targetId: string };
type Names = Map<string, string>;
type Rec = Record<string, unknown>;

/** "10 Oct", or "10 Oct 2025" when it is not this year. Takes a YYYY-MM-DD date or an instant (shown in India time). */
export function shortDay(v: unknown, now = new Date()): string | null {
  if (typeof v !== "string" && !(v instanceof Date)) return null;
  const s = v instanceof Date ? v.toISOString() : v;
  let y: number, m: number, d: number;
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (date) { y = +date[1]; m = +date[2] - 1; d = +date[3]; }
  else if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const t = new Date(new Date(s).getTime() + IST_MS);
    if (Number.isNaN(t.getTime())) return null;
    y = t.getUTCFullYear(); m = t.getUTCMonth(); d = t.getUTCDate();
  } else return null;
  const thisYear = new Date(now.getTime() + IST_MS).getUTCFullYear();
  return `${d} ${MON[m]}${y === thisYear ? "" : ` ${y}`}`;
}

/** "18 Oct, 3:42 pm" in India time (with the year when it is not this year). */
export function whenText(at: Date, now = new Date()) {
  const t = new Date(at.getTime() + IST_MS);
  const h = t.getUTCHours();
  const clock = `${h % 12 === 0 ? 12 : h % 12}:${String(t.getUTCMinutes()).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
  return `${shortDay(at, now)}, ${clock}`;
}

const q = (s: string) => `"${s}"`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
const role = (r: unknown) => (typeof r === "string" ? cap(r) : "Editor");

/** Every id-shaped value a row may need a name for. */
export function idsIn(a: { beforeState: unknown; afterState: unknown; targetId: string; targetType?: string }) {
  const out = new Set<string>([a.targetId]);
  for (const st of [a.beforeState, a.afterState]) {
    for (const [k, v] of Object.entries((st ?? {}) as Rec)) if (typeof v === "string" && /Id$/.test(k) && v) out.add(v);
  }
  return [...out];
}

function person(names: Names, id: unknown) {
  return typeof id === "string" && id ? names.get(id) ?? "someone no longer on the project" : "no one";
}

function taskChange(b: Rec, f: Rec, label: string, now: Date) {
  const same: string[] = []; // "due date from 10 Oct to 14 Oct" style changes share one "on <task>"
  const own: string[] = [];
  const dayOr = (v: unknown) => shortDay(v, now) ?? "no date";
  for (const k of Object.keys(f)) {
    if (JSON.stringify(b[k]) === JSON.stringify(f[k])) continue;
    switch (k) {
      case "title": own.push(`renamed ${q(String(b.title ?? ""))} to ${q(String(f.title ?? ""))}`); break;
      case "description": own.push(`edited the description of ${label}`); break;
      case "dueDate": same.push(`due date from ${dayOr(b.dueDate)} to ${dayOr(f.dueDate)}`); break;
      case "priority": same.push(`priority from ${cap(String(b.priority ?? "medium"))} to ${cap(String(f.priority ?? "medium"))}`); break;
      case "blocked": own.push(f.blocked ? `marked ${label} as blocked` : `unblocked ${label}`); break;
      case "blockedReason": if (!("blocked" in f) && f.blockedReason) own.push(`gave the blocked reason "${String(f.blockedReason)}" on ${label}`); break;
      default: break;
    }
  }
  const bits = [...(same.length ? [`changed ${same.join(" and ")} on ${label}`] : []), ...own];
  return bits.length ? bits.join("; ") : `edited ${label}`;
}

/** The part after the person's name: "moved "Prepare handover doc" to Trash". */
export function sentence(a: Row, names: Names, now = new Date()): string {
  const b = (a.beforeState ?? {}) as Rec;
  const f = (a.afterState ?? {}) as Rec;
  const task = names.get(`t:${a.targetId}`) ?? (typeof f.title === "string" ? f.title : typeof b.title === "string" ? b.title : null);
  const T = task ? q(task) : "a task";
  const sec = (id: unknown) => (typeof id === "string" ? names.get(id) ?? "another section" : "no section");
  switch (a.action) {
    case "project.created": return `created the project ${q(String(f.name ?? ""))}`;
    case "project.updated": {
      const bits: string[] = [];
      if (f.name !== undefined && f.name !== b.name) bits.push(`renamed the project from ${q(String(b.name ?? ""))} to ${q(String(f.name))}`);
      if (f.description !== undefined && f.description !== b.description) bits.push("edited the project description");
      return bits.join("; ") || "edited the project";
    }
    case "project.archived": return "archived the project";
    case "project.unarchived": return "unarchived the project";
    case "project.leader_changed": return `made ${person(names, f.leaderId)} the project Leader (was ${person(names, b.leaderId)})`;
    case "member.added": return `added ${person(names, a.targetId)} to the project as ${role(f.role)}`;
    case "member.removed": return `removed ${person(names, a.targetId)} from the project`;
    case "member.role_changed": return `changed ${person(names, a.targetId)}'s role from ${role(b.role)} to ${role(f.role)}`;
    case "section.added": return `added the section ${q(String(f.name ?? ""))}`;
    case "section.deleted": return `deleted the section ${q(String(b.name ?? ""))}`;
    case "section.renamed": return `renamed the section ${q(String(b.name ?? ""))} to ${q(String(f.name ?? ""))}`;
    case "section.moved": return `moved the section ${q(names.get(a.targetId) ?? "a section")} ${f.move === "left" ? "left" : "right"}`;
    case "section.done_changed": return `made ${q(names.get(a.targetId) ?? "a section")} the done section`;
    case "task.created": return f.parentId ? `added the subtask ${T}` : `added ${T} to ${sec(f.sectionId)}`;
    case "task.updated": return taskChange(b, f, T, now);
    case "task.assigned": return `assigned ${T} to ${person(names, f.assigneeId)} (was ${person(names, b.assigneeId)})`;
    case "task.collaborator_added": return `added ${person(names, f.userId)} as a collaborator on ${T}`;
    case "task.collaborator_removed": return `removed ${person(names, b.userId)} as a collaborator on ${T}`;
    case "task.approver_changed": return f.approverId ? `named ${person(names, f.approverId)} as approver of ${T}` : `removed the approver of ${T}`;
    case "task.sent_for_approval": return `sent ${T} to ${person(names, f.assigneeId)} for approval`;
    case "task.sent_back": return `sent ${T} back to ${person(names, f.assigneeId)}`;
    case "task.completed": return `completed ${T}`;
    case "task.reopened": return `reopened ${T}`;
    case "task.moved": return `moved ${T} from ${sec(b.sectionId)} to ${sec(f.sectionId)}`;
    case "task.deleted": return `moved ${T} to Trash`;
    case "task.restored": return `restored ${T} from Trash`;
    case "task.idea_changed": return f.isIdea ? `marked ${T} as an idea` : `took the idea mark off ${T}`;
    case "task.link_added": return `linked ${T} to ${typeof f.label === "string" && f.label ? q(f.label) : "a record"}`;
    case "task.link_removed": return `removed a link from ${T}`;
    case "comment.added": return `commented on ${T}`;
    case "comment.edited": return `edited a comment on ${T}`;
    case "comment.removed": return `deleted a comment on ${T}`;
    case "task.moved_to_deal": return `moved ${T} to the deal ${q(String(f.deal ?? ""))}`;
    case "deal.created": return `created the deal ${q(String(f.name ?? ""))}`;
    case "deal.stage_changed": return `moved the deal from ${String(b.stage ?? "no stage")} to ${String(f.stage ?? "no stage")}${f.reason ? ` (${String(f.reason)})` : ""}`;
    case "deal.details_updated": return "edited the deal details";
    case "deal.party_added": return `added ${String(f.organisation ?? "an organisation")} to the deal`;
    case "deal.party_removed": return `removed ${String(b.organisation ?? "an organisation")} from the deal`;
    case "deal.converted": return `converted ${T} to this deal`;
    case "tasks.reassigned": return "handed a person's open tasks to someone else";
    case "tasks.collaborations_dropped": return "took a person off tasks as a collaborator";
    case "tasks.approver_reassigned": return "moved a person's approver duties to the Leader";
    case "undo": return `undid ${q(String(f.label ?? "an action").toLowerCase())}`;
    default: return "made a change";
  }
}
