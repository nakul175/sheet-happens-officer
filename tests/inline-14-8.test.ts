// SHO-US-14.8: the server side of inline edits (stale check on assign; edits log an undoable action).
import { describe, expect, it } from "vitest";
import { account, istDate, project, task, patchTask, withVersion } from "./helpers";

describe("inline editing (14.8)", () => {
  it("assign accepts the expected version and refuses a stale one with the stale-edit answer", async () => {
    const lead = await account("lead");
    const meera = await account("meera");
    const p = await project(lead, lead, [{ who: meera }]);
    const t = await task(lead, p.id, { dueDate: istDate(2) });
    const seen = (await lead.c.get(`/api/tasks/${t}`)).json.task.updatedAt as string;
    expect((await patchTask(lead, t, { priority: "HIGH" })).status).toBe(200); // someone else saves first
    const r = await lead.c.post(`/api/tasks/${t}/assign`, { assigneeId: meera.id, expectedUpdatedAt: seen });
    expect(r.status).toBe(409);
    expect(r.json).toEqual({ error: { code: "version_conflict", message: "This task changed while you were editing it." } });
    expect((await lead.c.get(`/api/tasks/${t}`)).json.task.assignee.id).toBe(lead.id);
    const fresh = (await lead.c.get(`/api/tasks/${t}`)).json.task.updatedAt as string;
    const ok = await lead.c.post(`/api/tasks/${t}/assign`, { assigneeId: meera.id, expectedUpdatedAt: fresh });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("x-undo-id")).toBeTruthy();
  });

  it("a date edit is stale-checked and undoable", async () => {
    const lead = await account("lead");
    const p = await project(lead, lead);
    const t = await task(lead, p.id);
    const seen = (await lead.c.get(`/api/tasks/${t}`)).json.task.updatedAt as string;
    const r = await lead.c.patch(`/api/tasks/${t}`, { dueDate: istDate(1), expectedUpdatedAt: seen });
    expect(r.status).toBe(200);
    const undo = r.headers.get("x-undo-id")!;
    expect((await lead.c.patch(`/api/tasks/${t}`, { dueDate: istDate(3), expectedUpdatedAt: seen })).status).toBe(409);
    expect((await lead.c.post(`/api/actions/${undo}/undo`, { anyway: true })).status).toBe(200);
    expect((await lead.c.get(`/api/tasks/${t}`)).json.task.dueDate).toBe(null);
  });

  it("a viewer cannot edit, and an awaiting task is held by its approver", async () => {
    const lead = await account("lead");
    const view = await account("viewer");
    const ed = await account("ed");
    const p = await project(lead, lead, [{ who: view, role: "VIEWER" }, { who: ed }]);
    const t = await task(lead, p.id, { assigneeId: ed.id, approverId: lead.id });
    expect((await patchTask(view, t, { priority: "LOW" })).status).toBe(403);
    expect((await view.c.post(`/api/tasks/${t}/assign`, await withVersion(view, t, { assigneeId: lead.id }))).status).toBe(403);
    expect((await ed.c.post(`/api/tasks/${t}/send-for-approval`)).status).toBe(200);
    expect((await lead.c.get(`/api/tasks/${t}`)).json.task.awaitingApproval).toBe(true);
    expect((await patchTask(lead, t, { priority: "LOW" })).status).toBe(200); // the Leader keeps full authority
  });
});
