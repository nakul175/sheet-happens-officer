import { describe, expect, it } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client";
import { account, project, task } from "./helpers";

const db = new PrismaClient();

describe("SHO-2656 restore logging", () => {
  it("writes one restored row for Trash and only one undo row for Undo", async () => {
    const lead = await account("restore2656");
    const p = await project(lead, lead);
    for (const via of ["trash", "undo"] as const) {
      const id = await task(lead, p.id, { title: `ZZ-TEST restore log ${via}` });
      const deleted = await lead.c.del(`/api/tasks/${id}`);
      expect(deleted.status).toBe(204);
      const undoId = deleted.headers.get("x-undo-id");
      expect(undoId).toBeTruthy();
      const restored = via === "trash"
        ? await lead.c.post(`/api/tasks/${id}/restore`)
        : await lead.c.post(`/api/actions/${undoId}/undo`);
      expect(restored.status, JSON.stringify(restored.json)).toBe(200);
      expect((await lead.c.get(`/api/tasks/${id}`)).status).toBe(200);
      const rows = await db.actionLog.findMany({
        where: { targetId: id, action: { in: ["task.restored", "undo"] } },
      });
      expect(rows.map((row) => row.action)).toEqual([via === "trash" ? "task.restored" : "undo"]);
      if (via === "undo") expect(rows[0].beforeState).toMatchObject({ undoes: undoId, action: "task.deleted" });
    }
  });
});
