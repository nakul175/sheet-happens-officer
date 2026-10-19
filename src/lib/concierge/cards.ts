// SHO-US-8.3 / 8.5: Confirm, Cancel and Undo of a card. Confirm re-reads the data and the person's
// permission on the server; a card whose records changed writes nothing and is replaced by a fresh one.
import { db } from "@/lib/db";
import { ApiError } from "@/lib/http";
import { canManage, projectAccess, type Actor } from "@/lib/access";
import { reqCtx, type ReqCtx } from "@/lib/reqctx";
import { checkUndo, undoAction } from "@/lib/undo";
import { isTooOldToUndo, isUndoable } from "@/lib/undoable";
import { buildCard, checkHandover, execute, fingerprint, recheck, summaryOf, type Op } from "@/lib/concierge/changes";
import { addMessage, casStored, ownMessage, parse, present } from "@/lib/concierge/thread";
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
      card: { id: "", status: "PENDING", ...b.card }, proposal: { ops: b.ops, fingerprint: b.fingerprint, versions: b.versions },
    }));
  } catch (e) {
    if (e instanceof ApiError) return present(await addMessage(user.id, "ASSISTANT", { kind: "notice", text: "Things changed since I showed you that card, and part of it is no longer possible. Nothing was changed. Ask me again if you still want it." }));
    throw e;
  }
}

const UNDOING_STALE_MS = 2 * 60_000;

/**
 * A confirmed card offers Undo only when this person can reverse every logged action.
 * Undoing a delete is a restore from Trash, so it takes the same Leader or Admin check as checkUndo (APL-2675).
 * A card that both deletes and edits hides Undo for the whole card when that check fails.
 */
async function offerUndo(user: Actor, rows: { action: string; projectId: string | null }[]) {
  const live = rows.filter((r) => isUndoable(r.action));
  if (!live.length) return false;
  for (const projectId of new Set(live.flatMap((r) => (r.action === "task.deleted" && r.projectId ? [r.projectId] : [])))) {
    if (!canManage(await projectAccess(user, projectId))) return false;
  }
  return true;
}

export async function confirmCard(user: Actor, cardId: string, handover?: { taskId: string; assigneeId: string }[], acknowledge?: boolean) {
  const { row, s } = await ownCard(user, cardId);
  if (s.card.status !== "PENDING") throw new ApiError(409, s.card.status === "CONFIRMED" ? "This card was already confirmed." : "This card is no longer open.");
  if (s.internal?.state === "RUNNING") throw new ApiError(409, "This card is already being applied.");
  const ops = s.proposal.ops as Op[];

  // 1. Re-read: has anything the card was based on changed?
  const now = await fingerprint(ops);
  if (now !== s.proposal.fingerprint) {
    if (!(await casStored(row.id, row.content, { ...s, card: { ...s.card, status: "STALE", canConfirm: false } }))) throw new ApiError(409, "This card was already handled.");
    const fresh = await freshCard(user, ops);
    throw new ApiError(409, "That changed since I showed you the card. Nothing was written; here is a fresh card.", { stale: true, messages: [fresh], card: { ...s.card, id: row.id, status: "STALE", canConfirm: false } });
  }
  // 2. Re-check permission with fresh data.
  const blocked = await recheck(user, ops);
  if (blocked) {
    await casStored(row.id, row.content, { ...s, card: { ...s.card, canConfirm: false, blockedReason: blocked } });
    throw new ApiError(403, blocked);
  }
  if (s.card.irreversible && acknowledge !== true) {
    throw new ApiError(400, "This can't be undone. Confirm again to accept that.", { needsAcknowledge: true });
  }
  checkHandover(s.card, handover);

  // 3. Claim the card: only one request gets past this line, so a double tap or a second tab writes nothing.
  const summary = await summaryOf(ops);
  const claimed: Stored = { ...s, card: { ...s.card, canConfirm: false }, internal: { ...s.internal, state: "RUNNING", runningAt: new Date().toISOString() } };
  if (!(await casStored(row.id, row.content, claimed))) throw new ApiError(409, "This card was already confirmed.");

  // 4. Write through the existing functions, in one request context so one Undo covers the whole card.
  const ctx: ReqCtx = { channel: "CONCIERGE", logIds: [] };
  let applied = 0;
  let failure: unknown = null;
  await reqCtx.run(ctx, async () => {
    try { await execute(user, ops, handover, () => { applied++; }, s.proposal.versions ?? {}); } catch (e) { failure = e; }
  });
  const logIds = ctx.logIds ?? [];
  if (failure && !logIds.length) {
    // Nothing was written: the card goes back to being confirmable.
    await db.chatMessage.update({ where: { id: row.id }, data: { content: row.content } });
    throw failure instanceof ApiError ? failure : new ApiError(500, "Something went wrong. Nothing was changed.");
  }

  const confirmedAt = new Date().toISOString();
  const rows = logIds.length ? await db.actionLog.findMany({ where: { id: { in: logIds } }, select: { action: true, projectId: true } }) : [];
  const undoable = !s.card.irreversible && await offerUndo(user, rows);
  const done = summary.slice(0, applied);
  const why = failure instanceof ApiError ? failure.message : "an unexpected error";
  const text = failure
    ? `Only part of this was done: ${why}${done.length ? `\nDone:\n${done.map((x) => `- ${x}`).join("\n")}` : ""}\nThe rest was not done. Ask me again for what is left.`
    : `Done.\n${summary.map((x) => `- ${x}`).join("\n")}`;
  const resultRow = await addMessage(user.id, "ASSISTANT", {
    kind: "result", text,
    result: { cardId: row.id, summary: failure ? done : summary, undoable, noticeSent: !!ctx.notified, notNotified: !ctx.notified },
    internal: { logIds, confirmedAt, cardMessageId: row.id },
  });
  // A half-applied card is closed for good; it can never be confirmed again as if untouched.
  await db.chatMessage.update({
    where: { id: row.id },
    data: { content: JSON.stringify({ ...s, card: { ...s.card, status: "CONFIRMED", canConfirm: false }, internal: { ...s.internal, ...(failure ? { state: "PARTIAL" as const } : {}), resultMessageId: resultRow.id, confirmedAt } } satisfies Stored) },
  });
  const card = present(await db.chatMessage.findUniqueOrThrow({ where: { id: row.id } })).card!;
  if (failure) throw new ApiError(409, text.split("\n")[0], { partial: true, messages: [present(resultRow)], card });
  return { messages: [present(resultRow)], card };
}

export async function cancelCard(user: Actor, cardId: string) {
  const { row, s } = await ownCard(user, cardId);
  if (s.card.status !== "PENDING" && s.card.status !== "STALE") throw new ApiError(409, "This card is no longer open.");
  if (s.internal?.state === "RUNNING") throw new ApiError(409, "This card is already being applied.");
  if (!(await casStored(row.id, row.content, { ...s, card: { ...s.card, status: "CANCELLED", canConfirm: false } }))) throw new ApiError(409, "This card is no longer open.");
  return { card: { ...s.card, id: row.id, status: "CANCELLED" as const, canConfirm: false } };
}

/**
 * Reverses every change on a confirmed card in one tap. All of it is checked first. It is safe to repeat: rows already
 * reversed are skipped, so a retry after a failure finishes the rest, and two taps at once reverse each row once.
 */
export async function undoCard(user: Actor, cardId: string, anyway = false) {
  const { row } = await ownCard(user, cardId);
  const resultId = (parse(row.content).internal)?.resultMessageId;
  const resultRow = resultId ? await db.chatMessage.findFirst({ where: { id: resultId, userId: user.id } }) : null;
  const rs = resultRow ? parse(resultRow.content) : null;
  if (!resultRow || !rs?.result || !rs.internal) throw new ApiError(404, "Nothing to undo");
  if (!rs.result.undoable) {
    // The button is hidden, but a direct Undo of a delete still runs the Trash restore check (APL-2675 AC3).
    const deletes = await db.actionLog.findMany({
      where: { id: { in: rs.internal.logIds ?? [] }, action: "task.deleted", undoneAt: null },
      select: { id: true },
    });
    for (const r of deletes) await checkUndo(user, r.id);
    throw new ApiError(409, "This can't be undone.");
  }
  if (rs.result.undoneAt) throw new ApiError(409, "This was already undone.");
  const confirmedAt = rs.internal.confirmedAt ? Date.parse(rs.internal.confirmedAt) : resultRow.createdAt.getTime();
  if (isTooOldToUndo(confirmedAt)) throw new ApiError(409, "Too old to undo", { tooOld: true });
  if (rs.internal.undoing && Date.now() - Date.parse(rs.internal.undoingAt ?? "0") < UNDOING_STALE_MS) throw new ApiError(409, "This is already being undone.");

  // Claim the Undo for this card.
  const claimed: Stored = { ...rs, internal: { ...rs.internal, undoing: true, undoingAt: new Date().toISOString() } };
  if (!(await casStored(resultRow.id, resultRow.content, claimed))) throw new ApiError(409, "This is already being undone.");
  const progress = [...(rs.internal.undoneIds ?? [])];
  const save = (extra: Partial<NonNullable<Stored["internal"]>>, result = rs.result) =>
    db.chatMessage.update({ where: { id: resultRow.id }, data: { content: JSON.stringify({ ...rs, result, internal: { ...rs.internal, undoneIds: progress, undoing: false, ...extra } } satisfies Stored) } });

  const logRows = await db.actionLog.findMany({ where: { id: { in: rs.internal.logIds ?? [] }, undoneAt: null }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  // Subtasks completed together with their parent come back with the parent's own row.
  const todo = logRows.filter((r) => isUndoable(r.action) && !(r.action === "task.completed" && (r.afterState as { withParent?: string } | null)?.withParent));
  let noticed = false;
  try {
    if (!anyway) for (const r of todo) await checkUndo(user, r.id);
    const ctx: ReqCtx = { channel: "CONCIERGE", logIds: [] };
    await reqCtx.run(ctx, async () => {
      for (const r of todo) {
        const out = await undoAction(user, r.id, anyway);
        noticed = noticed || out.noticesSent;
        progress.push(r.id);
        await save({ undoing: true, undoingAt: claimed.internal!.undoingAt });
      }
    });
  } catch (e) {
    // What was reversed stays recorded; the claim is released so a retry finishes the rest.
    await save({});
    if (progress.length > (rs.internal.undoneIds ?? []).length) {
      await addMessage(user.id, "ASSISTANT", { kind: "notice", text: `Undo stopped part way: ${progress.length - (rs.internal.undoneIds ?? []).length} change${progress.length - (rs.internal.undoneIds ?? []).length === 1 ? " was" : "s were"} put back and the rest is still as it was. Tap Undo again to finish.` });
    }
    throw e;
  }
  const undoneAt = new Date().toISOString();
  await save({}, { ...rs.result, undoneAt });
  const lines = rs.result.summary.map((x) => `- Reversed: ${x}`);
  const note = await addMessage(user.id, "ASSISTANT", {
    kind: "notice",
    text: `Undone. Everything on that card was put back:\n${lines.join("\n")}${noticed || rs.result.noticeSent ? "\nNotices already sent to other people cannot be unsent." : ""}`,
  });
  return { messages: [present(await db.chatMessage.findUniqueOrThrow({ where: { id: resultRow.id } })), present(note)] };
}
