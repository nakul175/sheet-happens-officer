import type { Card, Disabled, Message } from "./types";

/** Append messages, replacing any with the same id (so a refreshed card or result replaces the old one in place). */
export function mergeMessages(list: Message[], incoming: Message[]): Message[] {
  const out = [...list];
  for (const m of incoming) {
    const i = out.findIndex((x) => x.id === m.id);
    if (i >= 0) out[i] = m; else out.push(m);
  }
  return out;
}

/** Replace the card inside whichever message carries it. */
export function patchCard(list: Message[], card: Card): Message[] {
  return list.map((m) => (m.card?.id === card.id ? { ...m, card } : m));
}

/** A choices message can be tapped only while unanswered and still the latest thing in the thread. */
export function choicesActive(list: Message[], m: Message): boolean {
  if (m.kind !== "choices" || m.choiceAnswered) return false;
  return list[list.length - 1]?.id === m.id;
}

/** Confirm stays disabled until every task being handed over has an assignee. */
export function handoverComplete(card: Card, picked: Record<string, string>): boolean {
  return (card.handover ?? []).every((h) => !!picked[h.taskId]);
}

export function initialPicks(card: Card): Record<string, string> {
  const ok = new Set((card.handoverOptions ?? []).map((o) => o.id));
  const out: Record<string, string> = {};
  for (const h of card.handover ?? []) if (h.assigneeId && ok.has(h.assigneeId)) out[h.taskId] = h.assigneeId;
  return out;
}

export function canShowConfirm(card: Card): boolean {
  return card.status === "PENDING" && card.canConfirm && !card.blockedReason;
}

export type UndoView = "button" | "expired" | "undone" | "none";
export function undoView(r: NonNullable<Message["result"]>): UndoView {
  if (r.undoneAt) return "undone";
  if (!r.undoable) return "none";
  return r.undoExpired ? "expired" : "button";
}

export function resumeText(d: Disabled): string | null {
  if (!d.resumesAt) return null;
  const t = new Date(d.resumesAt);
  if (Number.isNaN(t.getTime())) return null;
  return t.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" });
}

/** A non-empty improve result replaces the draft and remembers the original. A failure leaves the draft alone. */
export function offeredRewrite(original: string, improved: string | null | undefined): { original: string; draft: string } | null {
  if (!improved?.trim()) return null;
  return { original, draft: improved };
}

/** Keep mine puts the typed text back, exactly, and drops the offer. */
export function keptDraft(original: string): string {
  return original;
}

/** Visible text for a failed improve call. The draft is left as it was. */
export function improveError(error: string | undefined): string {
  return error ?? "Could not improve that. Try again.";
}

/** Stale response from confirm: contract says 409 plus a fresh card message. Accept either shape. */
export function freshMessages(data: { messages?: Message[]; message?: Message } | undefined): Message[] {
  if (!data) return [];
  if (Array.isArray(data.messages)) return data.messages;
  return data.message ? [data.message] : [];
}
