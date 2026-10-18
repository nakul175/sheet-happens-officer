// APL-2691: the Move to Won dialog shows the open-task refusal from the list already on the page.
import { describe, expect, it } from "vitest";
import { closingAlert, LOAD_OPEN_TASKS, moreOpenTasks, openTaskAlertText, openTaskFeed, planClosing, stageClosesDeal } from "../src/components/DealPanel";
import { openTaskBlock } from "../src/lib/deals";
import { admin, istDate, superAdmin, task, withVersion, type Account } from "./helpers";

const row = (id: string, done = false) => ({ id, title: id, completedAt: done ? "2026-01-01" : null, assignee: null });
const section = (tasks: ReturnType<typeof row>[], total = tasks.length, nextCursor: string | null = null, isDone = false) => ({ isDone, total, nextCursor, tasks });

describe("closing alert payload", () => {
  it("@APL-2691 TC6: names a closing stage, keeps the first 20, and says how many remain", () => {
    expect(stageClosesDeal("DONE")).toBe(true);
    expect(stageClosesDeal("LOST")).toBe(true);
    expect(stageClosesDeal("ACTIVE")).toBe(false);
    expect(stageClosesDeal("PAUSED")).toBe(false);
    expect(stageClosesDeal("NOT_STARTED")).toBe(false);

    expect(closingAlert(null)).toBeNull();
    expect(closingAlert({ openTasks: 0, tasks: [] })).toBeNull();
    expect(closingAlert({})).toBeNull();
    const tasks = Array.from({ length: 21 }, (_, i) => ({ id: `t${i}`, title: `Task ${i}` }));
    expect(closingAlert({ openTasks: 21, tasks })).toEqual({ openTasks: 21, tasks: tasks.slice(0, 20) });
    expect(closingAlert({ openTasks: 1 })).toEqual({ openTasks: 1, tasks: [] });
    expect(openTaskBlock(tasks)).toEqual({ openTasks: 21, tasks: tasks.slice(0, 20).map(({ id, title }) => ({ id, title })) });
    expect(openTaskBlock([])).toEqual({ openTasks: 0, tasks: [] });
    expect(openTaskAlertText(21)).toContain("21");
    expect(openTaskAlertText(21)).toContain("open tasks");
    expect(openTaskAlertText(1)).toContain("1 open task");
    expect(openTaskAlertText(1)).not.toContain("open tasks");
    expect(moreOpenTasks(21, 20)).toBe("and 1 more");
    expect(moreOpenTasks(25, 20)).toBe("and 5 more");
    expect(moreOpenTasks(1, 1)).toBeNull();
    expect(moreOpenTasks(20, 20)).toBeNull();
  });

  it("@APL-2691 TC8: plans the dialog from the list the page already has", () => {
    const tasks = Array.from({ length: 21 }, (_, i) => ({ id: `t${i}`, title: `Task ${i}` }));
    expect(planClosing({ pending: true, status: "ready", openCount: 21, tasks })).toEqual({ kind: "ignore" });
    expect(planClosing({ pending: false, status: "loading", openCount: 0, tasks: [] })).toEqual({ kind: "wait" });
    expect(planClosing({ pending: false, status: "error", openCount: 0, tasks: [] })).toEqual({ kind: "open", blocked: null, loadError: LOAD_OPEN_TASKS });
    expect(planClosing({ pending: false, status: "partial", openCount: 21, tasks })).toEqual({ kind: "fetch" });
    expect(planClosing({ pending: false, status: "ready", openCount: 21, tasks })).toEqual({
      kind: "open", blocked: { openTasks: 21, tasks: tasks.slice(0, 20) }, loadError: null,
    });
    expect(planClosing({ pending: false, status: "ready", openCount: 0, tasks: [] })).toEqual({ kind: "open", blocked: null, loadError: null });
    const one = planClosing({ pending: false, status: "ready", openCount: 1, tasks: tasks.slice(0, 1) });
    expect(one).toEqual({ kind: "open", blocked: { openTasks: 1, tasks: tasks.slice(0, 1) }, loadError: null });
    expect(openTaskAlertText(1)).toContain("1 open task");

    const ready = openTaskFeed([section([row("a"), row("b", true)])], 1, false);
    expect(ready).toEqual({ status: "ready", openCount: 1, tasks: [{ id: "a", title: "a", assignee: null }] });
    expect(openTaskFeed([section([row("a")])], undefined, false).openCount).toBe(1);
    expect(openTaskFeed([section([row("a")])], 5, true).status).toBe("partial");
    expect(openTaskFeed([section([row("a")], 21, "next")], 21, false).status).toBe("partial");
    expect(openTaskFeed([section([row("a")], 30, "next", true)], 1, false).status).toBe("ready");
  });
});

async function pipelines(a: Account) {
  const r = await a.c.get("/api/deals/pipelines");
  expect(r.status).toBe(200);
  return r.json.pipelines as { id: string; key: string; stages: { id: string; name: string }[] }[];
}

describe("open tasks that block Won (APL-2691)", () => {
  it("@APL-2691 TC3 AC3: Won returns 409 with openTasks 21 and does not move, close, or archive the deal", async () => {
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
    expect((await lead.c.get(`/api/projects/${id}`)).json.project.deal.stage.name).toBe("Lead");
    expect((await lead.c.get(`/api/tasks/${stepId}`)).json.task.completedAt).toBeNull();

    const won = pro.stages.find((s) => s.name === "Won")!.id;
    const blocked = await lead.c.post(`/api/projects/${id}/stage`, { stageId: won });
    expect(blocked.status).toBe(409);
    expect(blocked.json.openTasks).toBe(21);
    expect(blocked.json.error).toContain("21 tasks are still open");
    expect(blocked.json.tasks).toHaveLength(20);
    const returned = (blocked.json.tasks as { id: string; title: string }[]).map((t) => t.title);
    expect(named.map((t) => t.title).filter((t) => !returned.includes(t))).toHaveLength(1);
    expect((await lead.c.get(`/api/projects/${id}`)).json.project.deal.stage.name).toBe("Lead");
    expect((await lead.c.get(`/api/projects/${id}`)).json.project.archived).toBe(false);
    expect((await lead.c.get(`/api/tasks/${stepId}`)).json.task.completedAt).toBeNull();

    for (const item of named) expect((await lead.c.post(`/api/tasks/${item.id}/complete`, await withVersion(lead, item.id))).status, item.title).toBe(200);
    expect((await lead.c.post(`/api/projects/${id}/stage`, { stageId: won })).status).toBe(200);
    const after = (await lead.c.get(`/api/projects/${id}`)).json.project;
    expect(after.deal.stage.name).toBe("Won");
    expect(after.archived).toBe(false);
  });
});
