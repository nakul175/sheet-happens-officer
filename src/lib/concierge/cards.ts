// SHO-US-8.3 / 8.5: Confirm, Cancel and Undo of a card. Confirm re-reads the data and the person's
// permission on the server; a card whose records changed writes nothing and is replaced by a fresh one.
import { db } from "@/lib/db";
import { ApiError } from "@/lib/http";
import type { Actor } from "@/lib/access";
import { reqCtx, type ReqCtx } from "@/lib/reqctx";
import { checkUndo, undoAction } from "@/lib/undo";
import { UNDO_DAYS, isUndoable } from "@/lib/undoable";
import { buildCard, checkHandover, execute, fingerprint, recheck, summaryOf, type Op } from "@/lib/concierge/changes";
import { addMessage, ownMessage, parse, present, saveStored } from "@/lib/concierge/thread";
import type { Card, Message, Stored } from "@/lib/concierge/types";

async function ownCard(user: Actor, cardId: string) {
  const row = await ownMessage(user.id, cardId);
  const s = parse(row.content);
  if (row.role !== "ASSISTANT" || s.kind !== "card" || !s.card || !s.proposal) throw new ApiError(404, "Card not found");
  return { row, s: s as Stored & { card: Card; proposal: NonNullable<Stored["proposal"]> } };
}

/** Replaces a stale card with a freshly built one, or says why that is no longer possible. */
async function freshCard(user: Actor, ops: Op[]): Promise<Message> {
  try {
    const b = await buildCard(user, ops);
    return present(await addMessage(user.id, "ASSISTANT", {
      kind: "card", text: `Things changed since I showed you that. ${b.card.title}. Review it and tap Confirm to apply it.`,
      card: { id: "", status: "PENDING", ...b.card }, proposal: { ops: b.ops, fingerprint: b.fingerprint },
    }));
  } catch (e) {
    if (e instanceof ApiError) return present(await addMessage(user.id, "ASSISTANT", { kind: "notice", text: "Things changed since I showed you that card, and part of it is no longer possible. Nothing was changed. Ask me again if you still want it." }));
    throw e;
  }
}

export async function confirmCard(user: Actor, cardId: string, handover?: { taskId: string; assigneeId: string }[]) {
  const { row, s } = await ownCard(user, cardId);
  if (s.card.status !== "PENDING") throw new ApiError(409, s.card.status === "CONFIRMED" ? "This card was already confirmed." : "This card is no longer open.");
  const ops = s.proposal.ops as Op[];

  // 1. Re-read: has anything the card was based on changed?
  let now: string;
  try { now = await fingerprint(ops); } catch (e) { if (!(e instanceof ApiError)) throw e; now = "gone"; }
  if (now !== s.proposal.fingerprint) {
    await saveStored(row.id, { ...s, card: { ...s.card, status: "STALE", canConfirm: false } });
    const fresh = await freshCard(user, ops);
    throw new ApiError(409, "That changed since I showed you the card. Nothing was written; here is a fresh card.", { stale: true, messages: [fresh], card: { ...s.card, id: row.id, status: "STALE", canConfirm: false } });
  }
  // 2. Re-check permission with fresh data.
  const blocked = await recheck(user, ops);
  if (blocked) {
    await saveStored(row.id, { ...s, card: { ...s.card, canConfirm: false, blockedReason: blocked } });
    throw new ApiError(403, blocked);
  }
  checkHandover(s.card, handover);

  // 3. Write through the existing functions, in one request context so one Undo covers the whole card.
  const summary = await summaryOf(ops);
  const ctx: ReqCtx = { channel: "CONCIERGE", logIds: [] };
  let failure: ApiError | null = null;
  await reqCtx.run(ctx, async () => {
    try { await execute(user, ops, handover); } catch (e) { if (e instanceof ApiError) failure = e; else throw e; }
  });
  const logIds = ctx.logIds ?? [];
  const wrote = logIds.length > 0;
  if (failure && !wrote) throw failure;

  const confirmedAt = new Date().toISOString();
  const rows = wrote ? await db.actionLog.findMany({ where: { id: { in: logIds } }, select: { id: true, action: true } }) : [];
  const undoable = !s.card.irreversible && rows.some((r) => isUndoable(r.action));
  const text = failure
    ? `Some changes were made before something went wrong: ${(failure as ApiError).message} The rest was not done.`
    : `Done.\n${summary.map((x) => `- ${x}`).join("\n")}`;
  const resultRow = await addMessage(user.id, "ASSISTANT", {
    kind: "result", text,
    result: { cardId: row.id, summary, undoable, noticeSent: !!ctx.notified, notNotified: !ctx.notified },
    internal: { logIds, confirmedAt, cardMessageId: row.id },
  });
  await saveStored(row.id, { ...s, card: { ...s.card, status: "CONFIRMED", canConfirm: false }, internal: { ...s.internal, resultMessageId: resultRow.id, confirmedAt } });
  const card = present((await db.chatMessage.findUniqueOrThrow({ where: { id: row.id } }))).card!;
  return { messages: [present(resultRow)], card };
}

export async function cancelCard(user: Actor, cardId: string) {
  const { row, s } = await ownCard(user, cardId);
  if (s.card.status !== "PENDING" && s.card.status !== "STALE") throw new ApiError(409, "This card is no longer open.");
  await saveStored(row.id, { ...s, card: { ...s.card, status: "CANCELLED", canConfirm: false } });
  return { card: { ...s.card, id: row.id, status: "CANCELLED" as const, canConfirm: false } };
}

/** Reverses every change on a confirmed card in one tap. All of it is checked first; nothing is half undone. */
export async function undoCard(user: Actor, cardId: string, anyway = false) {
  const { row, s } = await ownCard(user, cardId);
  const resultId = s.internal?.resultMessageId;
  const resultRow = resultId ? await db.chatMessage.findFirst({ where: { id: resultId, userId: user.id } }) : null;
  const rs = resultRow ? parse(resultRow.content) : null;
  if (!resultRow || !rs?.result || !rs.internal) throw new ApiError(404, "Nothing to undo");
  if (!rs.result.undoable) throw new ApiError(409, "This can't be undone.");
  if (rs.result.undoneAt) throw new ApiError(409, "This was already undone.");
  const confirmedAt = rs.internal.confirmedAt ? Date.parse(rs.internal.confirmedAt) : resultRow.createdAt.getTime();
  if (Date.now() - confirmedAt > UNDO_DAYS * 86400_000) throw new ApiError(409, "Too old to undo", { tooOld: true });

  const logRows = await db.actionLog.findMany({ where: { id: { in: rs.internal.logIds ?? [] } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  // Subtasks completed together with their parent come back with the parent's own row.
  const todo = logRows.filter((r) => isUndoable(r.action) && !(r.action === "task.completed" && (r.afterState as { withParent?: string } | null)?.withParent));
  if (!anyway) for (const r of todo) await checkUndo(user, r.id);

  const ctx: ReqCtx = { channel: "CONCIERGE", logIds: [] };
  let noticed = false;
  await reqCtx.run(ctx, async () => {
    for (const r of todo) {
      const out = await undoAction(user, r.id, anyway);
      noticed = noticed || out.noticesSent;
    }
  });
  const undoneAt = new Date().toISOString();
  await saveStored(resultRow.id, { ...rs, result: { ...rs.result, undoneAt } });
  const lines = rs.result.summary.map((x) => `- Reversed: ${x}`);
  const note = await addMessage(user.id, "ASSISTANT", {
    kind: "notice",
    text: `Undone. Everything on that card was put back:\n${lines.join("\n")}${noticed || rs.result.noticeSent ? "\nNotices already sent to other people cannot be unsent." : ""}`,
  });
  void row;
  return { messages: [present(await db.chatMessage.findUniqueOrThrow({ where: { id: resultRow.id } })), present(note)] };
}
