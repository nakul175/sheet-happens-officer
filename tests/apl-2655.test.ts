// APL-2655: an already-undone delete says so (409) before the Leader/Admin check.
// Pam has not assigned TC ids. Titles keep the literal marker until then.
import { describe, expect, it } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client";
import { ApiError } from "@/lib/http";
import { undoAction } from "@/lib/undo";
import { account, project, task, type Account } from "./helpers";

const db = new PrismaClient();

const deleteRow = (taskId: string, actorId: string) =>
  db.actionLog.findFirstOrThrow({ where: { action: "task.deleted", targetId: taskId, actorId }, orderBy: { createdAt: "desc" } });

async function editorDeletedT1() {
  const lead = await account("lead");
  const ed = await account("editor");
  const p = await project(lead, lead, [{ who: ed }]);
  const t = await task(lead, p.id, { title: "T1", assigneeId: ed.id });
  expect((await ed.c.del(`/api/tasks/${t}`)).status).toBeLessThan(300);
  const row = await deleteRow(t, ed.id);
  return { lead, ed, p, t, row };
}

function editorActor(ed: Account) {
  return { id: ed.id, orgRole: "MEMBER" as const };
}

async function snapshot(taskId: string, logId: string) {
  const [log, taskRow, undoCount] = await Promise.all([
    db.actionLog.findUniqueOrThrow({ where: { id: logId } }),
    db.task.findUniqueOrThrow({ where: { id: taskId } }),
    db.actionLog.count({ where: { action: "undo", targetId: taskId } }),
  ]);
  return {
    undoneAt: log.undoneAt?.toISOString() ?? null,
    undoneById: log.undoneById,
    deletedAt: taskRow.deletedAt?.toISOString() ?? null,
    updatedAt: taskRow.updatedAt.toISOString(),
    undoCount,
  };
}

describe("qa:TC missing APL-2655 already-undone delete", () => {
  it("qa:TC missing AC1 unit: undoAction throws 409 This was already undone and changes nothing", async () => {
    const { lead, ed, t, row } = await editorDeletedT1();
    expect((await lead.c.post(`/api/actions/${row.id}/undo`)).status).toBe(200);
    const before = await snapshot(t, row.id);
    expect(before.deletedAt).toBeNull();
    expect(before.undoneById).toBe(lead.id);

    const caught = await undoAction(editorActor(ed), row.id).then(() => null, (err: unknown) => err);
    expect(caught).toBeInstanceOf(ApiError);
    expect(caught).toMatchObject({ status: 409, message: "This was already undone." });
    expect(await snapshot(t, row.id)).toEqual(before);
  });

  it("qa:TC missing AC1 route: POST undo returns 409 This was already undone and changes nothing", async () => {
    const { lead, ed, p, t, row } = await editorDeletedT1();
    expect((await lead.c.post(`/api/actions/${row.id}/undo`)).status).toBe(200);
    const before = await snapshot(t, row.id);

    const u = await ed.c.post(`/api/actions/${row.id}/undo`);
    expect(u.status).toBe(409);
    expect(u.json.error).toBe("This was already undone.");
    expect(await snapshot(t, row.id)).toEqual(before);
    expect((await ed.c.get(`/api/tasks/${t}`)).status).toBe(200);
    const trash = await ed.c.get(`/api/projects/${p.id}/trash`);
    expect(trash.status).toBe(200);
    expect((trash.json.items as { id: string }[]).some((item) => item.id === t)).toBe(false);
  });

  it("qa:TC missing AC2 unit: undoAction throws 403 and T1 stays in Trash", async () => {
    const { ed, t, row } = await editorDeletedT1();
    const before = await snapshot(t, row.id);
    expect(before.deletedAt).not.toBeNull();
    expect(before.undoneAt).toBeNull();

    const caught = await undoAction(editorActor(ed), row.id).then(() => null, (err: unknown) => err);
    expect(caught).toBeInstanceOf(ApiError);
    expect(caught).toMatchObject({ status: 403, message: "Only the project Leader or an Admin can do this." });
    expect(await snapshot(t, row.id)).toEqual(before);
  });

  it("qa:TC missing AC2 route: POST undo returns 403 and T1 stays in Trash", async () => {
    const { ed, p, t, row } = await editorDeletedT1();
    const before = await snapshot(t, row.id);

    const u = await ed.c.post(`/api/actions/${row.id}/undo`);
    expect(u.status).toBe(403);
    expect(u.json.error).toBe("Only the project Leader or an Admin can do this.");
    expect(await snapshot(t, row.id)).toEqual(before);
    expect((await ed.c.get(`/api/tasks/${t}`)).status).toBe(404);
    const trash = await ed.c.get(`/api/projects/${p.id}/trash`);
    expect(trash.status).toBe(200);
    expect((trash.json.items as { id: string; title: string }[]).some((item) => item.id === t && item.title === "T1")).toBe(true);
  });
});
