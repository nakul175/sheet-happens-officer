// APL-2717. The concierge Undo (cards.ts) and its "Too old to undo" flag (thread.ts) use isTooOldToUndo,
// the same 30 × 24 h rule as Undo in undo.ts. At each boundary all three must agree.
import { afterEach, describe, expect, it, vi } from "vitest";
import { account, patchTask, project, task } from "./helpers";
import { actor, db } from "./actor";
import { checkUndo } from "../src/lib/undo";
import { UNDO_DAYS, isTooOldToUndo } from "../src/lib/undoable";

const WINDOW = UNDO_DAYS * 86400_000;
const CASES = [
  { name: "30d - 1 ms", age: WINDOW - 1, tooOld: false },
  { name: "exactly 30d", age: WINDOW, tooOld: false },
  { name: "30d + 1 ms", age: WINDOW + 1, tooOld: true },
];

const tooOldFlag = (p: Promise<unknown>) => p.then(() => false, (e) => e?.extra?.tooOld === true);

describe("qa:TC missing APL-2717 Undo boundary matches undo.ts", () => {
  afterEach(() => { vi.useRealTimers(); });

  for (const c of CASES) {
    it(`qa:TC missing ${c.name}: isTooOldToUndo and undo.ts agree (tooOld=${c.tooOld})`, async () => {
      const lead = await account("lead");
      const p = await project(lead, lead);
      const t = await task(lead, p.id, { title: "Boundary" });
      const logId = (await patchTask(lead, t, { title: "Boundary edited" })).headers.get("x-undo-id")!;
      expect(logId).toBeTruthy();

      const now = Date.now();
      const at = new Date(now - c.age);
      await db.actionLog.update({ where: { id: logId }, data: { createdAt: at } });

      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(now);

      expect(isTooOldToUndo(at.getTime(), now)).toBe(c.tooOld);
      const viaUndo = await tooOldFlag(checkUndo(actor(lead), logId));

      expect(viaUndo).toBe(c.tooOld);
    });
  }

});
