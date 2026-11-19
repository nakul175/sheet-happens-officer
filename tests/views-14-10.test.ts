// SHO-US-14.10: saved views are personal, capped at 10 per project, and survive a person leaving the project.
import { describe, expect, it } from "vitest";
import { account, project } from "./helpers";

const state = (over: Record<string, unknown> = {}) => ({ assignee: "", flags: ["overdue"], priority: "", sort: "date", group: "section", ...over });

describe("saved views (14.10)", () => {
  it("saves, lists, renames and deletes; only the owner sees or changes them", async () => {
    const lead = await account("lead");
    const ed = await account("ed");
    const p = await project(lead, lead, [{ who: ed }]);
    const made = await lead.c.post(`/api/projects/${p.id}/views`, { name: "Overdue", state: state() });
    expect(made.status).toBe(201);
    const id = made.json.view.id as string;
    expect((await lead.c.get(`/api/projects/${p.id}/views`)).json.views.map((v: { name: string }) => v.name)).toEqual(["Overdue"]);
    expect((await ed.c.get(`/api/projects/${p.id}/views`)).json.views).toEqual([]);
    expect((await ed.c.patch(`/api/views/${id}`, { name: "Mine now" })).status).toBe(404);
    expect((await ed.c.del(`/api/views/${id}`)).status).toBe(404);
    expect((await lead.c.patch(`/api/views/${id}`, { name: "Late" })).json.view.name).toBe("Late");
    expect((await lead.c.post(`/api/projects/${p.id}/views`, { name: "late", state: state() })).status).toBe(409); // same name
    expect((await lead.c.del(`/api/views/${id}`)).status).toBe(204);
    expect((await lead.c.get(`/api/projects/${p.id}/views`)).json.views).toEqual([]);
  });

  it("lets a Viewer manage only their personal saved view", async () => {
    const lead = await account("lead");
    const viewer = await account("viewer");
    const p = await project(lead, lead, [{ who: viewer, role: "VIEWER" }]);
    const path = `/api/projects/${p.id}/views`;
    const leaderView = await lead.c.post(path, { name: "Leader view", state: state() });
    expect(leaderView.status).toBe(201);
    const ownView = await viewer.c.post(path, { name: "My view", state: state() });
    expect(ownView.status).toBe(201);
    expect((await viewer.c.get(path)).json.views.map((v: { id: string }) => v.id)).toEqual([ownView.json.view.id]);
    expect((await viewer.c.patch(`/api/views/${leaderView.json.view.id}`, { name: "Taken" })).status).toBe(404);
    expect((await viewer.c.del(`/api/views/${leaderView.json.view.id}`)).status).toBe(404);
    expect((await viewer.c.patch(`/api/views/${ownView.json.view.id}`, { name: "Renamed" })).json.view.name).toBe("Renamed");
    expect((await viewer.c.del(`/api/views/${ownView.json.view.id}`)).status).toBe(204);
    expect((await viewer.c.get(path)).json.views).toEqual([]);
    expect((await lead.c.get(path)).json.views.map((v: { id: string }) => v.id)).toEqual([leaderView.json.view.id]);
  });

  it("stops at 10 per project with a clear message, and another project is separate", async () => {
    const lead = await account("lead");
    const p = await project(lead, lead);
    const q = await project(lead, lead);
    for (let i = 0; i < 10; i++) expect((await lead.c.post(`/api/projects/${p.id}/views`, { name: `V${i}`, state: state() })).status).toBe(201);
    const r = await lead.c.post(`/api/projects/${p.id}/views`, { name: "One too many", state: state() });
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/up to 10 saved views/);
    expect((await lead.c.post(`/api/projects/${q.id}/views`, { name: "Fine here", state: state() })).status).toBe(201);
  });

  it("refuses non-members, bad state and empty names", async () => {
    const lead = await account("lead");
    const out = await account("out");
    const p = await project(lead, lead);
    expect((await out.c.get(`/api/projects/${p.id}/views`)).status).toBe(404);
    expect((await out.c.post(`/api/projects/${p.id}/views`, { name: "X", state: state() })).status).toBe(404);
    expect((await lead.c.post(`/api/projects/${p.id}/views`, { name: "  ", state: state() })).status).toBe(400);
    expect((await lead.c.post(`/api/projects/${p.id}/views`, { name: "Bad", state: state({ sort: "mood" }) })).status).toBe(400);
  });

  it("a view naming someone who left still opens (the list answers, with no match for that person)", async () => {
    const lead = await account("lead");
    const gone = await account("gone");
    const p = await project(lead, lead, [{ who: gone }]);
    await lead.c.post(`/api/projects/${p.id}/views`, { name: "Gone's work", state: state({ flags: [], assignee: gone.id }) });
    expect((await lead.c.del(`/api/projects/${p.id}/members/${gone.id}`)).status).toBeLessThan(300);
    const v = (await lead.c.get(`/api/projects/${p.id}/views`)).json.views[0];
    expect(v.state.assignee).toBe(gone.id);
    const list = await lead.c.get(`/api/projects/${p.id}/tasks?assignee=${gone.id}`);
    expect(list.status).toBe(200);
    expect(list.json.sections.flatMap((s: { tasks: unknown[] }) => s.tasks)).toEqual([]);
  });
});
