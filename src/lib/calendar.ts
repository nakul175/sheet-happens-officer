import { createHash, randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { crmProjectWhere, crmVisible, isAdmin, WORKSTREAM_DEAL, type Actor } from "@/lib/access";
import { addDays, formatDueDate, startOfTodayIST } from "@/lib/dates";

export type CalendarEvent = { id: string; title: string; date: string; href: string; projectId: string; projectName: string; kind: "task" | "deadline"; updatedAt: string };
export const feedHash = (secret: string) => createHash("sha256").update(secret).digest("hex");
export async function issueFeed(user: Actor) {
  const secret = randomBytes(32).toString("hex");
  // One row per person makes concurrent resets atomic: exactly one secret survives.
  await db.$transaction(async (tx) => {
    await tx.feedToken.upsert({ where: { userId: user.id }, create: { userId: user.id, tokenHash: feedHash(secret) }, update: { tokenHash: feedHash(secret), createdAt: new Date() } });
    await tx.auditLog.create({ data: { event: "FEED_TOKEN_RESET", actorId: user.id, channel: "SCREEN" } });
  });
  return secret;
}
export async function feedUser(secret: string) {
  if (!/^[a-f0-9]{64}$/.test(secret)) return null;
  const row = await db.feedToken.findUnique({ where: { tokenHash: feedHash(secret) }, include: { user: true } });
  return row && row.type === "FEED" && !row.user.deactivatedAt && row.user.emailVerifiedAt && !row.user.tempPasswordAt ? row.user : null;
}
export async function calendarEvents(user: Actor, from: Date, to: Date): Promise<CalendarEvent[]> {
  const projectWhere = { archivedAt: null, ...crmProjectWhere(user), ...(isAdmin(user) ? {} : { members: { some: { userId: user.id } } }) };
  const tasks = await db.task.findMany({ where: { deletedAt: null, dueDate: { gte: from, lt: to }, project: projectWhere, OR: [{ assigneeId: user.id }, { collaborators: { some: { userId: user.id } } }] }, select: { id: true, title: true, dueDate: true, updatedAt: true, project: { select: { id: true, name: true } } } });
  const deals = crmVisible(user) ? await db.project.findMany({ where: { archivedAt: null, typeId: WORKSTREAM_DEAL, members: { some: { userId: user.id } }, deal: { submissionDeadline: { gte: new Date(formatDueDate(from)! + "T00:00:00Z"), lt: new Date(formatDueDate(to)! + "T00:00:00Z") } } }, select: { id: true, name: true, updatedAt: true, deal: { select: { submissionDeadline: true } } } }) : [];
  return [...tasks.map(t => ({ id: t.id, title: t.title, date: formatDueDate(t.dueDate)!, href: `/tasks/${t.id}`, projectId: t.project.id, projectName: t.project.name, kind: "task" as const, updatedAt: t.updatedAt.toISOString() })), ...deals.map(p => ({ id: p.id, title: `${p.name} — submission deadline`, date: p.deal!.submissionDeadline!.toISOString().slice(0, 10), href: `/deals/${p.id}`, projectId: p.id, projectName: p.name, kind: "deadline" as const, updatedAt: p.updatedAt.toISOString() }))].sort((a,b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
}
const escapeText = (s: string) => s.replace(/\\/g, "\\\\").replace(/\r\n|\r|\n/g, "\\n").replace(/;/g, "\\;").replace(/,/g, "\\,");
// RFC 5545 limits content lines to 75 octets, including continuation whitespace.
function fold(line: string) {
  let result = "", bytes = 0;
  for (const ch of line) { const n = Buffer.byteLength(ch); if (bytes + n > 75) { result += "\r\n "; bytes = 1; } result += ch; bytes += n; }
  return result;
}
export function calendarIcs(events: CalendarEvent[], origin: string, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Sheet Happens Officer//Calendar//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
  for (const e of events) {
    const end = new Date(`${e.date}T00:00:00Z`); end.setUTCDate(end.getUTCDate()+1);
    lines.push("BEGIN:VEVENT", `UID:${e.kind}-${e.id}@sheet-happens-officer`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${e.date.replace(/-/g, "")}`, `DTEND;VALUE=DATE:${end.toISOString().slice(0,10).replace(/-/g, "")}`, `SUMMARY:${escapeText(e.title)}`, `URL:${new URL(e.href, origin).href}`, "END:VEVENT");
  }
  return [...lines, "END:VCALENDAR", ""].map(fold).join("\r\n");
}
export function feedRange(now = new Date()) { const today = startOfTodayIST(now); return { from: addDays(today, -90), to: addDays(today, 366) }; }
