// SHO-US-14.11: bulk actions in one request, skip-and-say, 50 limit, one Undo.
import { describe, expect, it } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client";
import { account, bulkWithVersions, istDate, project, task } from "./helpers";

const db = new PrismaClient();

const notices = async (who: { c: { get: (p: string) => Promise<{ json: { items: { text: string }[] } }> } }) => (await who.c.get("/api/notifications")).json.items.map((i) => i.text);

describe("bulk actions (14.11)", () => {
  it("assigns 5 tasks in one request, notifies the assignee once, and one Undo reverses all", async () => {
    const lead = await account("lead");
    const meera = await account("meera");
    const old = await account("old");
    const p = await project(lead, lead, [{ who: meera }, { who: old }]);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await task(lead, p.id, { assigneeId: i < 3 ? old.id : lead.id }));
    const r = await lead.c.post(`/api/projects/${p.id}/tasks/bulk`, await bulkWithVersions(lead, ids, { action: "assign", assigneeId: meera.id }));
    expect(r.status).toBe(200);
    expect(r.json.changed).toBe(5);
    expect(r.json.skipped).toEqual([]);
    expect(r.json.message).toBe("5 changed");
    expect(r.headers.get("x-undo-id")).toBeNull(); // the page raises one toast for the group
    for (const id of ids) expect((await lead.c.get(`/api/tasks/${id}`)).json.task.assignee.id).toBe(meera.id);
    const mine = (await notices(meera)).filter((t) => /assigned you 5 tasks/.test(t));
    expect(mine.length).toBe(1);
    expect((await notices(meera)).filter((t) => /assigned you/.test(t) && !/5 tasks/.test(t)).length).toBe(0); // no per-task notices
    expect((await notices(old)).filter((t) => /handed to a new owner|took/.test(t)).length).toBe(1); // told once

    const u = await lead.c.post("/api/actions/bulk-undo", { ids: r.json.undoIds });
    expect(u.status, JSON.stringify(u.json)).toBe(200);
    expect(u.json.count).toBe(5);
    for (const [i, id] of ids.entries()) expect((await lead.c.get(`/api/tasks/${id}`)).json.task.assignee.id).toBe(i < 3 ? old.id : lead.id);
    expect((await lead.c.post("/api/actions/bulk-undo", { ids: r.json.undoIds })).status).toBe(409); // already undone
  });

  it("sets a date, moves section, completes; skips what is already so and says so", async () => {
    const lead = await account("lead");
    const p = await project(lead, lead);
    const a = await task(lead, p.id, { dueDate: istDate(1) });
    const b = await task(lead, p.id);
    const d = (await lead.c.post(`/api/projects/${p.id}/tasks/bulk`, { taskIds: [a, b], action: "date", dueDate: istDate(1) })).json;
    expect(d.changed).toBe(1);
    expect(d.message).toBe("1 changed, 1 skipped (already up to date)");
    const m = (await lead.c.post(`/api/projects/${p.id}/tasks/bulk`, await bulkWithVersions(lead, [a, b], { action: "move", sectionId: p.doing }))).json;
    expect(m.changed).toBe(2);
    expect((await lead.c.get(`/api/tasks/${a}`)).json.task.section.id).toBe(p.doing);
    const c = (await lead.c.post(`/api/projects/${p.id}/tasks/bulk`, await bulkWithVersions(lead, [a, b], { action: "complete" }))).json;
    expect(c.changed).toBe(2);
    expect((await lead.c.get(`/api/tasks/${a}`)).json.task.completedAt).toBeTruthy();
    const u = await lead.c.post("/api/actions/bulk-undo", { ids: c.undoIds });
    expect(u.status).toBe(200);
    expect((await lead.c.get(`/api/tasks/${a}`)).json.task.completedAt).toBeNull();
    const clear = (await lead.c.post(`/api/projects/${p.id}/tasks/bulk`, { taskIds: [a], action: "date", dueDate: null })).json;
    expect(clear.changed).toBe(1);
    expect((await lead.c.get(`/api/tasks/${a}`)).json.task.dueDate).toBeNull();
  });

  it("skips tasks the person may not change, and says '4 changed, 1 skipped (no permission)'", async () => {
    const lead = await account("lead");
    const ed = await account("ed");
    const other = await account("other");
    const p = await project(lead, lead, [{ who: ed }, { who: other }]);
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push(await task(lead, p.id, { assigneeId: ed.id }));
    const held = await task(lead, p.id, { assigneeId: other.id, approverId: ed.id });
    expect((await other.c.post(`/api/tasks/${held}/send-for-approval`)).status).toBe(200); // ed now holds it and may only close or send back
    const r = await ed.c.post(`/api/projects/${p.id}/tasks/bulk`, await bulkWithVersions(ed, [...ids, held], { action: "assign", assigneeId: other.id }));
    expect(r.status).toBe(200);
    expect(r.json.changed).toBe(4);
    expect(r.json.message).toBe("4 changed, 1 skipped (no permission)");
    expect(r.json.skipped.map((s: { id: string }) => s.id)).toEqual([held]);
    expect((await ed.c.get(`/api/tasks/${held}`)).json.task.assignee.id).toBe(ed.id); // untouched
  });

  it("refuses more than 50 with a clear message and changes nothing", async () => {
    const lead = await account("lead");
    const p = await project(lead, lead);
    const first = await task(lead, p.id);
    const ids = [first, ...Array.from({ length: 50 }, (_, i) => `fake${i}`)];
    const r = await lead.c.post(`/api/projects/${p.id}/tasks/bulk`, await bulkWithVersions(lead, ids, { action: "complete" }));
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/up to 50 tasks at once/);
    expect((await lead.c.get(`/api/tasks/${first}`)).json.task.completedAt).toBeNull();
    // exactly 50 is allowed
    const ok = await lead.c.post(`/api/projects/${p.id}/tasks/bulk`, await bulkWithVersions(lead, ids.slice(0, 50), { action: "complete" }));
    expect(ok.status).toBe(200);
    expect(ok.json.changed).toBe(1);
    expect(ok.json.skipped.length).toBe(49);
  });

  it("viewers and outsiders cannot use it; a bad assignee fails the whole request", async () => {
    const lead = await account("lead");
    const view = await account("view");
    const out = await account("out");
    const p = await project(lead, lead, [{ who: view, role: "VIEWER" }]);
    const t = await task(lead, p.id);
    expect((await view.c.post(`/api/projects/${p.id}/tasks/bulk`, await bulkWithVersions(view, [t], { action: "complete" }))).status).toBe(403);
    expect((await out.c.post(`/api/projects/${p.id}/tasks/bulk`, await bulkWithVersions(out, [t], { action: "complete" }))).status).toBe(404);
    const bad = await lead.c.post(`/api/projects/${p.id}/tasks/bulk`, await bulkWithVersions(lead, [t], { action: "assign", assigneeId: view.id }));
    expect(bad.status).toBe(400);
    expect((await lead.c.get(`/api/tasks/${t}`)).json.task.assignee.id).toBe(lead.id);
  });

  it("undoes every id in a bulk Undo past 500 (APL-2680)", async () => {
    const OVER = 501; // one past the old lookup cap, so the second page has to run
    const lead = await account("lead");
    const p = await project(lead, lead);
    const proj = await db.project.findUniqueOrThrow({ where: { id: p.id }, select: { workspaceId: true } });
    const doneAt = new Date("2026-02-01T00:00:00Z");
    const tasks = await db.task.createManyAndReturn({
      data: Array.from({ length: OVER }, (_, i) => ({
        workspaceId: proj.workspaceId, projectId: p.id, sectionId: p.done, title: `bulk ${i}`,
        assigneeId: lead.id, createdById: lead.id, completedAt: doneAt, previousSectionId: p.todo, position: i,
      })),
      select: { id: true },
    });
    const logs = await db.actionLog.createManyAndReturn({
      data: tasks.map((t) => ({
        actorId: lead.id, channel: "SCREEN" as const, projectId: p.id, targetType: "task", targetId: t.id, action: "task.completed",
        beforeState: { sectionId: p.todo, completedAt: null, previousSectionId: p.todo },
        afterState: { completedAt: doneAt.toISOString(), subtasksCompleted: 0, subtaskIds: [] },
      })),
      select: { id: true },
    });
    expect(logs).toHaveLength(OVER);

    const u = await lead.c.post("/api/actions/bulk-undo", { ids: logs.map((l) => l.id) });
    expect(u.status, JSON.stringify(u.json)).toBe(200);
    expect(u.json.count).toBe(OVER);
    const left = await db.task.count({ where: { id: { in: tasks.map((t) => t.id) }, OR: [{ completedAt: { not: null } }, { sectionId: { not: p.todo } }] } });
    expect(left).toBe(0);
    expect(await db.actionLog.count({ where: { id: { in: logs.map((l) => l.id) }, undoneAt: null } })).toBe(0);
  }, 180000);
});
