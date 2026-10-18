// SHO-BUG-8 Editor can undo their own delete, skipping the Leader/Admin check (Linear APL-2640, PR #9). Acceptance criteria AC1 to AC4.
// The Super Admin acts as Leader; the plain Member (SHO_MEMBER_*) is the Editor. Projects are ZZ-TEST and archived afterwards.
// Staging runs main, where PR #9 is not merged, so the Editor checks are skipped until it is.
import { test, expect } from "../support";
import { newProject, newTask } from "../g2";
import { deleteTask, raw, why } from "../helpers/jim-http";

const NOT_MERGED = "Needs PR #9 (SHO-BUG-8) merged to main and deployed to staging: on main the Editor's Undo of a delete still succeeds.";
const TWO_SESSIONS = "Needs the Admin and the Member signed in together, which needs a staging window.";
const REFUSED = "Only the project Leader or an Admin can do this.";

test.describe("SHO-BUG-8 / APL-2640", () => {
  test.skip("AC1: an Editor's Undo of their own delete is refused with the unauthorised-restore rule and message, and nothing is restored", why(`${NOT_MERGED} ${TWO_SESSIONS}`), async ({ admin, member, later }) => {
    const p = await newProject(admin, later, { label: "bug8 editor undo", members: [{ who: member, role: "EDITOR" }] });
    const t = await newTask(admin, p.id, { assigneeId: member.user.id });
    const del = await deleteTask(member, t);
    expect(del.status).toBe(204);
    const restore = await member.api.post(`/api/tasks/${t}/restore`); // the unauthorised restore from Trash
    expect(restore.status).toBe(403);
    if (del.undoId) { // APL-2649 (PR #14) also drops the Undo id for an Editor; then there is nothing to undo at all
      const u = await member.api.post(`/api/actions/${del.undoId}/undo`);
      expect(u.status).toBe(403);
      expect(u.json.error).toBe(restore.json.error);
      expect(u.json.error).toBe(REFUSED);
    }
    expect((await member.api.get(`/api/tasks/${t}`)).status).toBe(404);
    const trash = (await admin.api.get(`/api/projects/${p.id}/trash`)).json.items as { id: string }[];
    expect(trash.some((x) => x.id === t), "still in Trash").toBe(true);
  });

  test("AC2: a Leader or Admin who undoes a delete within the window gets the task back and an action-log row is written", async ({ admin, later }) => {
    const p = await newProject(admin, later, { label: "bug8 leader undo" });
    const t = await newTask(admin, p.id);
    const del = await deleteTask(admin, t);
    expect(del.status).toBe(204);
    expect(del.undoId, "x-undo-id on the delete").toBeTruthy();
    expect(del.undoLabel).toBe("Task deleted");
    expect((await admin.api.get(`/api/tasks/${t}`)).status).toBe(404);
    const u = await admin.api.post(`/api/actions/${del.undoId}/undo`);
    expect(u.status, JSON.stringify(u.json)).toBe(200);
    expect((await admin.api.get(`/api/tasks/${t}`)).status).toBe(200);
    // "Audit row" is the action-log row (BA ruling, 18 Oct 2026), shown on the project's Activity.
    const items = (await admin.api.get(`/api/projects/${p.id}/activity`)).json.items as { id: string; what: string; undo: string }[];
    expect(items.some((i) => /undid "task deleted"/.test(i.what)), JSON.stringify(items.map((i) => i.what))).toBe(true);
    expect(items.find((i) => i.id === del.undoId)?.undo).toBe("undone");
  });

  test.skip("AC3: the check is on the server: an Editor calling the Undo and bulk-Undo routes directly is refused", why(`${NOT_MERGED} ${TWO_SESSIONS}`), async ({ admin, member, later }) => {
    const p = await newProject(admin, later, { label: "bug8 server check", members: [{ who: member, role: "EDITOR" }] });
    const t = await newTask(admin, p.id);
    // The action-log id comes from the Leader's Activity, so the check does not rely on the Editor being given an Undo id.
    expect((await deleteTask(member, t)).status).toBe(204);
    const items = (await admin.api.get(`/api/projects/${p.id}/activity`)).json.items as { id: string; what: string }[];
    const row = items.find((i) => /to Trash/.test(i.what));
    expect(row, "the delete's Activity row").toBeTruthy();
    const one = await raw(member, "POST", `/api/actions/${row!.id}/undo`, {});
    expect(one.status).toBe(403);
    expect(one.json.error).toBe(REFUSED);
    const bulk = await member.api.post("/api/actions/bulk-undo", { ids: [row!.id] });
    expect(bulk.status).toBe(403);
    expect(bulk.json.error).toBe(REFUSED);
    expect((await admin.api.get(`/api/tasks/${t}`)).status).toBe(404);
  });

  test.skip("AC4: an Editor's Undo of a delete is refused and the Leader's Undo of the same delete succeeds", why(`${NOT_MERGED} ${TWO_SESSIONS}`), async ({ admin, member, later }) => {
    const p = await newProject(admin, later, { label: "bug8 both", members: [{ who: member, role: "EDITOR" }] });
    const t = await newTask(admin, p.id);
    expect((await deleteTask(member, t)).status).toBe(204);
    const items = (await admin.api.get(`/api/projects/${p.id}/activity`)).json.items as { id: string; what: string }[];
    const id = items.find((i) => /to Trash/.test(i.what))!.id;
    expect((await member.api.post(`/api/actions/${id}/undo`)).status).toBe(403);
    expect((await admin.api.get(`/api/tasks/${t}`)).status).toBe(404);
    const ok = await admin.api.post(`/api/actions/${id}/undo`);
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect((await member.api.get(`/api/tasks/${t}`)).status).toBe(200);
  });
});
