// SHO-US-8.1 / 8.8: the person's one private thread. Every query here is keyed by the signed-in
// user's id; there is no function that reads another person's chat.
import { db } from "@/lib/db";
import { ApiError } from "@/lib/http";
import type { Actor } from "@/lib/access";
import { UNDO_DAYS } from "@/lib/undoable";
import { disabledFor } from "@/lib/concierge/limits";
import { QUICK_ACTIONS } from "@/lib/concierge/reads";
import type { Message, State, Stored } from "@/lib/concierge/types";

export const RETENTION_DAYS = 90;
export const PRIVACY_WORDING = "Your chats are not visible anywhere in the app to anyone else, and are deleted from the app after 90 days.";

type Row = { id: string; role: "USER" | "ASSISTANT"; content: string; createdAt: Date };

export function parse(content: string): Stored {
  try {
    const s = JSON.parse(content) as Stored;
    if (s && typeof s === "object" && typeof s.text === "string" && s.kind) return s;
  } catch { /* plain text row */ }
  return { kind: "text", text: content };
}

export function present(row: Row): Message {
  const s = parse(row.content);
  const m: Message = { id: row.id, role: row.role, createdAt: row.createdAt.toISOString(), kind: s.kind, text: s.text };
  if (s.links?.length) m.links = s.links;
  if (s.choices) m.choices = s.choices;
  if (s.choiceAnswered) m.choiceAnswered = s.choiceAnswered;
  if (s.card) m.card = { ...s.card, id: row.id };
  if (s.result) {
    const confirmed = s.internal?.confirmedAt ? Date.parse(s.internal.confirmedAt) : row.createdAt.getTime();
    const expired = !s.result.undoneAt && s.result.undoable && Date.now() - confirmed > UNDO_DAYS * 86400_000;
    m.result = { ...s.result, ...(expired ? { undoExpired: true } : {}) };
  }
  return m;
}

export async function addMessage(userId: string, role: "USER" | "ASSISTANT", stored: Stored) {
  return db.chatMessage.create({ data: { userId, role, content: JSON.stringify(stored) } });
}
export async function saveStored(id: string, stored: Stored) {
  await db.chatMessage.update({ where: { id }, data: { content: JSON.stringify(stored) } });
}

/** A message of this person's own, or 404. Another person's message id looks exactly like a missing one. */
export async function ownMessage(userId: string, id: string) {
  const row = await db.chatMessage.findFirst({ where: { id, userId } });
  if (!row) throw new ApiError(404, "Message not found");
  return row;
}

export async function thread(userId: string, limit = 300): Promise<Message[]> {
  const rows = await db.chatMessage.findMany({ where: { userId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit });
  return rows.reverse().map(present);
}

/** A question still waiting for an answer is dropped when the person sends something else (SHO-US-8.4 AC6). */
export async function dropPendingChoices(userId: string) {
  const last = await db.chatMessage.findFirst({ where: { userId, role: "ASSISTANT" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  if (!last) return;
  const s = parse(last.content);
  if (s.kind === "choices" && !s.choiceAnswered) await saveStored(last.id, { ...s, choiceAnswered: "dropped" });
}

export async function state(user: Actor, now = new Date()): Promise<State> {
  const [me, disabled, messages] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { id: user.id }, select: { conciergeHidden: true, voiceNoticeAckedAt: true } }),
    disabledFor(user.id, now),
    thread(user.id),
  ]);
  return {
    available: !disabled,
    ...(disabled ? { disabled } : {}),
    hidden: me.conciergeHidden,
    voiceNoticeAcked: !!me.voiceNoticeAckedAt,
    quickActions: QUICK_ACTIONS.map((q) => ({ id: q.id as State["quickActions"][number]["id"], label: q.label })),
    messages,
  };
}

export async function setPreferences(user: Actor, p: { hidden?: boolean; voiceNoticeAcked?: true }) {
  const cur = await db.user.findUniqueOrThrow({ where: { id: user.id }, select: { voiceNoticeAckedAt: true } });
  const u = await db.user.update({
    where: { id: user.id },
    data: { ...(p.hidden !== undefined ? { conciergeHidden: p.hidden } : {}), ...(p.voiceNoticeAcked && !cur.voiceNoticeAckedAt ? { voiceNoticeAckedAt: new Date() } : {}) },
    select: { conciergeHidden: true, voiceNoticeAckedAt: true },
  });
  return { hidden: u.conciergeHidden, voiceNoticeAcked: !!u.voiceNoticeAckedAt };
}

/** "Clear my chat" (SHO-US-8.8 AC4): the whole thread at once. The audit log learns only that it happened. */
export async function clearChat(user: Actor) {
  await db.$transaction([
    db.chatMessage.deleteMany({ where: { userId: user.id } }),
    db.auditLog.create({ data: { event: "CHAT_CLEARED", actorId: user.id, channel: "CONCIERGE" } }),
  ]);
}

/** Scheduled job: messages older than 90 days are deleted (SHO-US-8.8 AC2), whoever they belong to. */
export async function purgeChat(now = new Date()) {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86400_000);
  const r = await db.chatMessage.deleteMany({ where: { createdAt: { lt: cutoff } } });
  if (r.count) await db.auditLog.create({ data: { event: "CHAT_PURGED", channel: "SCREEN", data: { count: r.count } } });
  return r.count;
}
