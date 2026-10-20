// APL-2717. The concierge Undo (cards.ts) and its "Too old to undo" flag (thread.ts) use isTooOldToUndo,
// the same 30 × 24 h rule as Undo in undo.ts. At each boundary all three must agree.
import { afterEach, describe, expect, it, vi } from "vitest";
import { account, patchTask, project, task, type Account } from "./helpers";
import { actor, db } from "./concierge-helpers";
import { checkUndo } from "../src/lib/undo";
import { undoCard } from "../src/lib/concierge/cards";
import { thread } from "../src/lib/concierge/thread";
import { UNDO_DAYS, isTooOldToUndo } from "../src/lib/undoable";
import type { Stored } from "../src/lib/concierge/types";

const WINDOW = UNDO_DAYS * 86400_000;
const CASES = [
  { name: "30d - 1 ms", age: WINDOW - 1, tooOld: false },
  { name: "exactly 30d", age: WINDOW, tooOld: false },
  { name: "30d + 1 ms", age: WINDOW + 1, tooOld: true },
];

const tooOldFlag = (p: Promise<unknown>) => p.then(() => false, (e) => e?.extra?.tooOld === true);

/** A confirmed card whose result row says it was confirmed at `confirmedAt`. No logged rows, so Undo has nothing else to check. */
async function confirmedCard(a: Account, confirmedAt: Date) {
  const card = await db.chatMessage.create({ data: { userId: a.id, role: "ASSISTANT", content: "{}" } });
  const result = await db.chatMessage.create({
    data: {
      userId: a.id, role: "ASSISTANT",
      content: JSON.stringify({
        kind: "result", text: "Done.",
        result: { cardId: card.id, summary: ["Task edited"], undoable: true },
        internal: { confirmedAt: confirmedAt.toISOString(), logIds: [], cardMessageId: card.id },
      } satisfies Stored),
    },
  });
  await db.chatMessage.update({
    where: { id: card.id },
    data: {
      content: JSON.stringify({
        kind: "card", text: "Change this?",
        card: { id: card.id, status: "CONFIRMED", title: "Edit", changes: [{ label: "Task edited" }], canConfirm: false },
        proposal: { ops: [], fingerprint: "apl-2717" },
        internal: { resultMessageId: result.id, confirmedAt: confirmedAt.toISOString() },
      } satisfies Stored),
    },
  });
  return { cardId: card.id, resultId: result.id };
}

describe("qa:TC missing APL-2717 concierge too-old-to-undo matches undo.ts", () => {
  afterEach(() => { vi.useRealTimers(); });

  for (const c of CASES) {
    it(`qa:TC missing ${c.name}: isTooOldToUndo, undo.ts, cards.ts and thread.ts agree (tooOld=${c.tooOld})`, async () => {
      const lead = await account("lead");
      const p = await project(lead, lead);
      const t = await task(lead, p.id, { title: "Boundary" });
      const logId = (await patchTask(lead, t, { title: "Boundary edited" })).headers.get("x-undo-id")!;
      expect(logId).toBeTruthy();

      const now = Date.now();
      const at = new Date(now - c.age);
      await db.actionLog.update({ where: { id: logId }, data: { createdAt: at } });
      const { cardId, resultId } = await confirmedCard(lead, at);

      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(now);

      expect(isTooOldToUndo(at.getTime(), now)).toBe(c.tooOld);
      const viaUndo = await tooOldFlag(checkUndo(actor(lead), logId));
      const viaThread = (await thread(actor(lead))).find((m) => m.id === resultId)!.result!.undoExpired === true;
      const viaCard = await tooOldFlag(undoCard(actor(lead), cardId));

      expect(viaUndo).toBe(c.tooOld);
      expect({ viaThread, viaCard }).toEqual({ viaThread: viaUndo, viaCard: viaUndo });
    });
  }

  it("qa:TC missing no inline 30-day comparison is left in the concierge files", async () => {
    const { readFileSync } = await import("node:fs");
    for (const f of ["src/lib/concierge/cards.ts", "src/lib/concierge/thread.ts"]) {
      expect(readFileSync(f, "utf8")).not.toMatch(/UNDO_DAYS\s*\*/);
    }
  });
});
