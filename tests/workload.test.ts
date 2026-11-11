// SHO-2589: exercise real query scope and assignment through the public API.
import { expect, it } from "vitest";
import { account, cleanupZz, istDate, patchTask, project, superAdmin, task, withVersion } from "./helpers";
it("SHO-2589 counts only led active projects, includes subtasks, and reassigns with versioned Undo", async () => {
  const lead = await account("zzworklead"), worker = await account("zzworkworker"), viewer = await account("zzworkviewer"), outsider = await account("zzworkout");
  const projects: string[] = [], archived: string[] = [];
  try {
    const p = await project(lead, lead, [{ who: worker }, { who: viewer, role: "VIEWER" }], "ZZ-TEST workload visible"); projects.push(p.id);
    const other = await project(outsider, outsider, [{ who: worker }, { who: lead }], "ZZ-TEST workload not led"); projects.push(other.id);
    const hidden = await task(outsider, other.id, { title: "Must not count", assigneeId: worker.id, dueDate: istDate(-3) });
    const top = await task(lead, p.id, { title: "Workload overdue", assigneeId: worker.id, dueDate: istDate(-2) });
    const child = await task(lead, p.id, { title: "Workload child", parentId: top, assigneeId: worker.id, dueDate: istDate(1) });
    expect((await patchTask(lead, child, { blocked: true, blockedReason: "Awaiting input" })).status).toBe(200);
    const gone = await task(lead, p.id, { title: "Trash excluded", assigneeId: worker.id });
    expect((await lead.c.del(`/api/tasks/${gone}`)).status).toBe(204);
    const r = await lead.c.get(`/api/workload?assignee=${worker.id}&f=open`);
    expect(r.status).toBe(200);
    expect(r.json.people.find((x: { id: string }) => x.id === worker.id).counts).toMatchObject({ open: 2, overdue: 1, next7: 1, blocked: 1 });
    expect(r.json.items).toHaveLength(2);
    expect(JSON.stringify(r.json)).not.toContain(hidden);
    expect((await worker.c.get("/api/workload")).status).toBe(404);
    expect((await viewer.c.get("/api/workload")).status).toBe(404);
    expect((await lead.c.get(`/api/workload?assignee=${outsider.id}`)).status).toBe(404);
    for (const assigneeId of [viewer.id, outsider.id]) expect((await lead.c.post(`/api/tasks/${top}/assign`, await withVersion(lead, top, { assigneeId }))).status).toBe(400);
    const assigned = await lead.c.post(`/api/tasks/${top}/assign`, await withVersion(lead, top, { assigneeId: lead.id }));
    expect(assigned.status).toBe(200);
    const undo = assigned.headers.get("x-undo-id");
    expect(undo).toBeTruthy();
    expect((await lead.c.post(`/api/actions/${undo}/undo`)).status).toBe(200);
    expect((await lead.c.get(`/api/tasks/${top}`)).json.task.assignee.id).toBe(worker.id);
    expect((await lead.c.post(`/api/projects/${p.id}/archive`, { archive: true })).status).toBe(200);
    archived.push(p.id);
    const sa = await superAdmin();
    const adminCounts = await sa.c.get(`/api/workload?assignee=${worker.id}`);
    expect(adminCounts.status).toBe(200);
    expect(adminCounts.json.items).toHaveLength(1); // only the other live project
  } finally {
    for (const id of archived) expect((await lead.c.post(`/api/projects/${id}/unarchive`)).status).toBe(200);
    await cleanupZz(projects, [lead, worker, viewer, outsider]);
  }
});
