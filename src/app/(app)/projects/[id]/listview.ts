// SHO-US-14.9: the filter, sort and group choices that live in the page URL, and how a grouped list is laid out.
import { addDays } from "@/lib/dates";

export const FLAG_LABEL: Record<string, string> = { overdue: "Overdue", blocked: "Blocked", awaiting: "Awaiting approval", nodate: "No date" };
export const FLAG_KEYS = ["overdue", "blocked", "awaiting", "nodate"] as const;
export const PRIORITY_KEYS = ["URGENT", "HIGH", "MEDIUM", "LOW"] as const;
export type Group = "section" | "assignee" | "week";
export type ListState = { assignee: string; flags: string[]; priority: string; sort: "date" | "priority"; group: Group };

const csv = (v: string | null) => (v ? v.split(",").filter(Boolean) : []);

export function readState(sp: { get(k: string): string | null }): ListState {
  const g = sp.get("group");
  return {
    assignee: csv(sp.get("assignee"))[0] ?? "",
    flags: csv(sp.get("f")).filter((x) => (FLAG_KEYS as readonly string[]).includes(x)),
    priority: csv(sp.get("priority")).filter((x) => (PRIORITY_KEYS as readonly string[]).includes(x))[0] ?? "",
    sort: sp.get("sort") === "priority" ? "priority" : "date",
    group: g === "assignee" || g === "week" ? g : "section",
  };
}
/** Query-string fragment for the list endpoint (view, task and group stay out; group only widens the page). */
export function apiQuery(s: ListState) {
  const q = new URLSearchParams();
  if (s.assignee) q.set("assignee", s.assignee);
  if (s.flags.length) q.set("f", s.flags.join(","));
  if (s.priority) q.set("priority", s.priority);
  if (s.sort !== "date") q.set("sort", s.sort);
  if (s.group !== "section") q.set("group", s.group);
  const t = q.toString();
  return t ? `?${t}` : "";
}
export const isFiltered = (s: ListState) => !!(s.assignee || s.flags.length || s.priority);

type Row = { dueDate: string | null; priority: string; completedAt: string | null; assignee: { id: string; name: string } };
const RANK: Record<string, number> = { URGENT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
export function compare(sort: "date" | "priority") {
  return (a: Row, b: Row) => {
    const done = Number(!!a.completedAt) - Number(!!b.completedAt);
    if (done) return done;
    const d = (a.dueDate ?? "9999-99-99").localeCompare(b.dueDate ?? "9999-99-99");
    if (sort === "priority") return RANK[a.priority] - RANK[b.priority] || d;
    return d;
  };
}

const mondayOf = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  return addDays(d, -((d.getUTCDay() + 6) % 7)).toISOString().slice(0, 10);
};
const weekName = (monday: string) => new Date(`${monday}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });

/** Sections for Group by person or by due week. Tasks keep the chosen sort order inside each group. */
export function groupTasks<T extends Row>(tasks: T[], by: "assignee" | "week", today: string, sort: "date" | "priority") {
  const sorted = tasks.map((t, i) => [t, i] as const).sort(([a, i], [b, j]) => compare(sort)(a, b) || i - j).map(([t]) => t);
  const groups = new Map<string, { key: string; name: string; order: string; tasks: T[] }>();
  const put = (key: string, name: string, order: string, t: T) => {
    const g = groups.get(key) ?? { key, name, order, tasks: [] };
    g.tasks.push(t);
    groups.set(key, g);
  };
  const thisMonday = mondayOf(today);
  const nextMonday = addDays(new Date(`${thisMonday}T00:00:00Z`), 7).toISOString().slice(0, 10);
  for (const t of sorted) {
    if (by === "assignee") { put(t.assignee.id, t.assignee.name, t.assignee.name.toLowerCase(), t); continue; }
    if (!t.dueDate) { put("none", "No date", "9", t); continue; }
    const m = mondayOf(t.dueDate);
    if (m < thisMonday) put("earlier", "Earlier", "0", t);
    else if (m === thisMonday) put("this", "This week", "1", t);
    else if (m === nextMonday) put("next", "Next week", "2", t);
    else put(m, `Week of ${weekName(m)}`, `3${m}`, t);
  }
  return [...groups.values()].sort((a, b) => a.order.localeCompare(b.order));
}
