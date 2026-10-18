// APL-2691: the Move to Won dialog must show the open-task refusal (SHO-US-10.3 AC6) before anyone clicks Move.
import { describe, expect, it } from "vitest";
import { closingAlert, stageClosesDeal } from "../src/components/DealPanel";
import { openTaskBlock } from "../src/lib/deals";
import { account, admin, istDate, project, superAdmin, task, withVersion, type Account } from "./helpers";

describe("closing alert payload", () => {
  it("names a closing stage and ignores every other category", () => {
    expect(stageClosesDeal("DONE")).toBe(true);
    expect(stageClosesDeal("LOST")).toBe(true);
    expect(stageClosesDeal("ACTIVE")).toBe(false);
    expect(stageClosesDeal("PAUSED")).toBe(false);
    expect(stageClosesDeal("NOT_STARTED")).toBe(false);
  });

  it("keeps the count and the first 20 titles, and stays quiet when nothing is open", () => {
    expect(closingAlert(null)).toBeNull();
    expect(closingAlert({ openTasks: 0, tasks: [] })).toBeNull();
    expect(closingAlert({})).toBeNull();
    const tasks = Array.from({ length: 21 }, (_, i) => ({ id: `t${i}`, title: `Task ${i}` }));
    expect(closingAlert({ openTasks: 21, tasks })).toEqual({ openTasks: 21, tasks: tasks.slice(0, 20) });
    expect(closingAlert({ openTasks: 1 })).toEqual({ openTasks: 1, tasks: [] });
    expect(openTaskBlock(tasks)).toEqual({ openTasks: 21, tasks: tasks.slice(0, 20).map(({ id, title }) => ({ id, title })) });
    expect(openTaskBlock([])).toEqual({ openTasks: 0, tasks: [] });
  });
});

async function pipelines(a: Account) {
  const r = await a.c.get("/api/deals/pipelines");
  expect(r.status).toBe(200);
  return r.json.pipelines as { id: string; key: string; stages: { id: string; name: string }[] }[];
}

describe("open tasks that block Won (APL-2691)", () => {
  it("returns the same first 20 the move refuses with, and does not move, close or archive the deal", async () => {
    const sa = await superAdmin();
    const lead = await admin(sa, "won2691");
    const pipes = await pipelines(lead);
    const pro = pipes.find((p) => p.key === "DEAL_PROACTIVE")!;
    const orgId = (await lead.c.post("/api/orgs", { name: `Org 2691 ${Date.now()}` })).json.organisation.id as string;
    const step = `Call the buyer ${Date.now()}`;
    const made = await lead.c.post("/api/deals", {
      name: `Deal 2691 ${Date.now()}`, organisationId: orgId, pipelineId: pro.id, leaderId: lead.id, whyPursue: "fit",
      nextStep: { title: step, dueDate: istDate(3) },
    });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    const id = made.json.deal.id as string;
    const stepId = (await lead.c.get(`/api/projects/${id}`)).json.project.deal.nextStep.id as string;
    const extra: { id: string; title: string }[] = [];
    for (let i = 0; i < 20; i++) {
      const title = `Open ${i} ${Date.now()}`;
      extra.push({ id: await task(lead, id, { title }), title });
    }
    const named = [{ id: stepId, title: step }, ...extra];

    const preview = await lead.c.get(`/api/projects/${id}/stage`);
    expect(preview.status, JSON.stringify(preview.json)).toBe(200);
    expect(preview.json.openTasks).toBe(21);
    expect(preview.json.tasks).toHaveLength(20);
    const returned = (preview.json.tasks as { id: string; title: string }[]).map((t) => t.title);
    expect(named.map((t) => t.title).filter((t) => !returned.includes(t))).toHaveLength(1);
    expect((await lead.c.get(`/api/projects/${id}`)).json.project.deal.stage.name).toBe("Lead");
    expect((await lead.c.get(`/api/tasks/${stepId}`)).json.task.completedAt).toBeNull();

    const won = pro.stages.find((s) => s.name === "Won")!.id;
    const blocked = await lead.c.post(`/api/projects/${id}/stage`, { stageId: won });
    expect(blocked.status).toBe(409);
    expect(blocked.json.error).toContain("21 tasks are still open");
    expect(blocked.json.tasks).toEqual(preview.json.tasks);
    expect((await lead.c.get(`/api/projects/${id}`)).json.project.archived).toBe(false);

    for (const item of named) expect((await lead.c.post(`/api/tasks/${item.id}/complete`, await withVersion(lead, item.id))).status, item.title).toBe(200);
    const clear = await lead.c.get(`/api/projects/${id}/stage`);
    expect(clear.json).toEqual({ openTasks: 0, tasks: [] });
    expect((await lead.c.post(`/api/projects/${id}/stage`, { stageId: won })).status).toBe(200);
    const after = (await lead.c.get(`/api/projects/${id}`)).json.project;
    expect(after.deal.stage.name).toBe("Won");
    expect(after.archived).toBe(false);
  });

  it("refuses the preview on a plain project", async () => {
    const m = await account("plain2691");
    const p = await project(m, m);
    const r = await m.c.get(`/api/projects/${p.id}/stage`);
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("Only deals have stages.");
  });
});
