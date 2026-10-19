// APL-2655: an already-undone delete says so (409) before the Leader/Admin check.
// Pam has not assigned TC ids. Titles keep the literal marker until then.
import { afterAll, describe, expect, it } from "vitest";
import { ApiError } from "@/lib/http";
import { undoAction } from "@/lib/undo";
import { type Account } from "./helpers";
import { cleanupZz, editorDeletedT1, snapshot } from "./apl-2655-zz";

function editorActor(ed: Account) {
  return { id: ed.id, orgRole: "MEMBER" as const };
}

describe("qa:TC missing APL-2655 already-undone delete", () => {
  afterAll(cleanupZz);

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
    const { lead, ed, projectId, t, row } = await editorDeletedT1();
    expect((await lead.c.post(`/api/actions/${row.id}/undo`)).status).toBe(200);
    const before = await snapshot(t, row.id);

    const u = await ed.c.post(`/api/actions/${row.id}/undo`);
    expect(u.status).toBe(409);
    expect(u.json.error).toBe("This was already undone.");
    expect(await snapshot(t, row.id)).toEqual(before);
    expect((await ed.c.get(`/api/tasks/${t}`)).status).toBe(200);
    const trash = await ed.c.get(`/api/projects/${projectId}/trash`);
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
    const { ed, projectId, t, title, row } = await editorDeletedT1();
    const before = await snapshot(t, row.id);

    const u = await ed.c.post(`/api/actions/${row.id}/undo`);
    expect(u.status).toBe(403);
    expect(u.json.error).toBe("Only the project Leader or an Admin can do this.");
    expect(await snapshot(t, row.id)).toEqual(before);
    expect((await ed.c.get(`/api/tasks/${t}`)).status).toBe(404);
    const trash = await ed.c.get(`/api/projects/${projectId}/trash`);
    expect(trash.status).toBe(200);
    expect((trash.json.items as { id: string; title: string }[]).some((item) => item.id === t && item.title === title)).toBe(true);
  });
});
