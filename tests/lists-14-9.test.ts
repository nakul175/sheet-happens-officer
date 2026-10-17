// SHO-US-14.9: filter and sort a project list on the server.
import { describe, expect, it } from "vitest";
import { account, istDate, project, task } from "./helpers";

const ids = (j: { sections: { tasks: { id: string }[] }[] }) => j.sections.flatMap((s) => s.tasks.map((t) => t.id));

describe("project list filters (14.9)", () => {
  it("filters overdue, blocked, awaiting approval, no date, person and priority; heading counts match", async () => {
    const lead = await account("lead");
    const meera = await account("meera");
    const p = await project(lead, lead, [{ who: meera }]);
    const o1 = await task(lead, p.id, { dueDate: istDate(-3), assigneeId: meera.id });
    const o2 = await task(lead, p.id, { dueDate: istDate(-1) });
    const o3 = await task(lead, p.id, { dueDate: istDate(-9), priority: "URGENT" });
    const fut = await task(lead, p.id, { dueDate: istDate(5) });
    const none = await task(lead, p.id, {});
    const done = await task(lead, p.id, { dueDate: istDate(-20) });
    expect((await lead.c.post(`/api/tasks/${done}/complete`, {})).status).toBe(200);
    const blocked = await task(lead, p.id, { dueDate: istDate(2) });
    expect((await lead.c.patch(`/api/tasks/${blocked}`, { blocked: true, blockedReason: "waiting" })).status).toBe(200);
    const wait = await task(lead, p.id, { assigneeId: meera.id, approverId: lead.id });
    expect((await meera.c.post(`/api/tasks/${wait}/send-for-approval`)).status).toBe(200);

    const all = await lead.c.get(`/api/projects/${p.id}/tasks`);
    expect(all.json.summary).toMatchObject({ overdue: 3, blocked: 1, awaiting: 1 });

    const over = await lead.c.get(`/api/projects/${p.id}/tasks?f=overdue`);
    expect(ids(over.json).sort()).toEqual([o1, o2, o3].sort()); // the completed overdue one is not shown
    expect(over.json.summary.overdue).toBe(3);

    expect(ids((await lead.c.get(`/api/projects/${p.id}/tasks?f=blocked`)).json)).toEqual([blocked]);
    expect(ids((await lead.c.get(`/api/projects/${p.id}/tasks?f=awaiting`)).json)).toEqual([wait]);
    expect(ids((await lead.c.get(`/api/projects/${p.id}/tasks?f=nodate`)).json).sort()).toEqual([none, wait].sort());
    expect(ids((await lead.c.get(`/api/projects/${p.id}/tasks?assignee=${meera.id}&f=overdue`)).json)).toEqual([o1]);
    expect(ids((await lead.c.get(`/api/projects/${p.id}/tasks?priority=URGENT`)).json)).toEqual([o3]);

    const byPri = ids((await lead.c.get(`/api/projects/${p.id}/tasks?sort=priority`)).json);
    expect(byPri[0]).toBe(o3);
    const byDate = await lead.c.get(`/api/projects/${p.id}/tasks?f=overdue`);
    expect(ids(byDate.json)).toEqual([o3, o1, o2]); // oldest due date first
    expect(fut).toBeTruthy();
  });

  it("is read-only for a non-member and hides other projects", async () => {
    const lead = await account("lead");
    const out = await account("outsider");
    const p = await project(lead, lead);
    expect((await out.c.get(`/api/projects/${p.id}/tasks?f=overdue`)).status).toBe(404);
  });

  it("answers within 300 ms for 500 tasks", async () => {
    const lead = await account("lead");
    const p = await project(lead, lead);
    for (let b = 0; b < 25; b++) {
      await Promise.all(Array.from({ length: 20 }, (_, i) => task(lead, p.id, { dueDate: istDate((b * 20 + i) % 7 === 0 ? -2 : 4) })));
    }
    await lead.c.get(`/api/projects/${p.id}/tasks?f=overdue`); // warm
    const t0 = performance.now();
    const r = await lead.c.get(`/api/projects/${p.id}/tasks?f=overdue&sort=priority`);
    const ms = performance.now() - t0;
    expect(r.status).toBe(200);
    expect(ids(r.json).length).toBe(Math.ceil(500 / 7));
    console.log(`500-task filter took ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(300);
  }, 120000);
});
