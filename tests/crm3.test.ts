// CRM slice 3: idea flag (13.2), convert to deal (12.2), Home data (13.1, 12.5 AC3).
import { describe, expect, it } from "vitest";
import { account, istDate, project, task, type Account } from "./helpers";

let seq = 0;
async function pipes(a: Account) {
  const pr = (await a.c.get("/api/deals/pipelines")).json.pipelines;
  return { proactive: pr.find((p: { key: string }) => p.key === "DEAL_PROACTIVE"), bid: pr.find((p: { key: string }) => p.key === "DEAL_BID") };
}
const newOrg = async (a: Account) => (await a.c.post("/api/orgs", { name: `Org3 ${Date.now()}-${seq++}` })).json.organisation.id as string;
const gate = async (a: Account, bid = false, extra: Record<string, unknown> = {}) => {
  const p = await pipes(a);
  return { organisationId: await newOrg(a), pipelineId: (bid ? p.bid : p.proactive).id, whyPursue: "Fits our work", ...(bid ? { submissionDeadline: istDate(30) } : {}), ...extra };
};

describe("idea flag (13.2)", () => {
  it("lets an Editor flag and unflag, refuses a Viewer, and undoes", async () => {
    const lead = await account("ilead");
    const viewer = await account("iview");
    const p = await project(lead, lead, [{ who: viewer, role: "VIEWER" }]);
    const t = await task(lead, p.id, { title: "Maybe a deal" });
    const on = await lead.c.post(`/api/tasks/${t}/idea`, { isIdea: true });
    expect(on.status).toBe(200);
    expect(on.headers.get("x-undo-label")).toBe("Idea flag changed");
    expect((await lead.c.get(`/api/tasks/${t}`)).json.task.isIdea).toBe(true);
    expect((await viewer.c.post(`/api/tasks/${t}/idea`, { isIdea: false })).status).toBe(403);
    expect((await lead.c.post(`/api/actions/${on.headers.get("x-undo-id")}/undo`)).status).toBe(200);
    expect((await lead.c.get(`/api/tasks/${t}`)).json.task.isIdea).toBe(false);
  });

  it("filters Search to ideas and shows the flag", async () => {
    const lead = await account("isearch");
    const p = await project(lead, lead);
    const tag = `zebra${Date.now()}`;
    const a = await task(lead, p.id, { title: `${tag} idea` });
    await task(lead, p.id, { title: `${tag} plain` });
    await lead.c.post(`/api/tasks/${a}/idea`, { isIdea: true });
    const all = (await lead.c.get(`/api/search?q=${tag}`)).json.tasks;
    expect(all).toHaveLength(2);
    const only = (await lead.c.get(`/api/search?q=${tag}&idea=true`)).json.tasks;
    expect(only).toHaveLength(1);
    expect(only[0].isIdea).toBe(true);
  });
});

describe("convert a task to a deal (12.2)", () => {
  it("moves the task with subtasks into a new deal, sets membership, clears Idea, and logs it in both places", async () => {
    const lead = await account("clead");
    const ed = await account("ced");
    const asg = await account("casg");
    const col = await account("ccol");
    const p = await project(lead, lead, [{ who: ed }, { who: asg }, { who: col }]);
    const t = await task(ed, p.id, { title: "Ministry of Health lead", description: "Met at conference", dueDate: istDate(5), assigneeId: asg.id, collaboratorIds: [col.id] });
    const sub = await task(ed, p.id, { title: "Draft intro", parentId: t });
    await ed.c.post(`/api/tasks/${t}/idea`, { isIdea: true });

    const r = await ed.c.post(`/api/tasks/${t}/convert`, { ...(await gate(ed)), leaderId: lead.id });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const dealId = r.json.deal.id as string;

    const moved = (await lead.c.get(`/api/tasks/${t}`)).json.task;
    expect(moved.project.id).toBe(dealId);
    expect(moved.description).toBe("Met at conference");
    expect(moved.assignee.id).toBe(asg.id);
    expect(moved.dueDate).toBe(istDate(5));
    expect(moved.isIdea).toBe(false);
    expect(moved.subtaskList.map((s: { id: string }) => s.id)).toEqual([sub]);
    expect((await lead.c.get(`/api/tasks/${sub}`)).json.task.projectId).toBe(dealId);

    const deal = (await lead.c.get(`/api/projects/${dealId}`)).json.project;
    const role = (u: Account) => deal.members.find((m: { userId: string }) => m.userId === u.id)?.role;
    expect(role(lead)).toBe("LEADER");
    expect(role(ed)).toBe("EDITOR"); // the converter
    expect(role(asg)).toBe("EDITOR"); // the idea's assignee
    expect(role(col)).toBe("VIEWER"); // collaborators
    expect(deal.deal.stage.name).toBe("Lead");
    expect(deal.deal.nextStep.id).toBe(t);

    const act = JSON.stringify((await lead.c.get(`/api/projects/${p.id}/activity`)).json);
    expect(act).toMatch(/moved this task to a deal/);
    // The source project no longer lists the task.
    expect(JSON.stringify((await lead.c.get(`/api/projects/${p.id}/tasks`)).json)).not.toContain(t);
  });

  it("refuses when any gate field is missing, with no bypass", async () => {
    const lead = await account("gate");
    const p = await project(lead, lead);
    const nodate = await task(lead, p.id, { title: "No date" });
    const g = await gate(lead);
    const miss = async (id: string, body: Record<string, unknown>) => { const r = await lead.c.post(`/api/tasks/${id}/convert`, body); expect(r.status).toBe(400); return r.json.needsFields as string[]; };
    expect(await miss(nodate, g)).toContain("dueDate");
    const dated = await task(lead, p.id, { title: "Dated", dueDate: istDate(3) });
    expect(await miss(dated, {})).toEqual(expect.arrayContaining(["organisation", "pipeline", "whyPursue"]));
    expect(await miss(dated, { ...g, whyPursue: "" })).toContain("whyPursue");
    const bid = await gate(lead, true);
    expect(await miss(dated, { ...bid, submissionDeadline: undefined })).toContain("submissionDeadline");
    // Supplying the date at conversion is allowed and becomes the next step.
    expect((await lead.c.post(`/api/tasks/${nodate}/convert`, { ...g, dueDate: istDate(4) })).status).toBe(201);
    expect((await lead.c.get(`/api/tasks/${nodate}`)).json.task.dueDate).toBe(istDate(4));
  });

  it("refuses Viewers, subtasks, Trash, archived projects, completed tasks and tasks awaiting approval", async () => {
    const lead = await account("rlead3");
    const viewer = await account("rview3");
    const ap = await account("rapp3");
    const p = await project(lead, lead, [{ who: viewer, role: "VIEWER" }, { who: ap }]);
    const g = await gate(lead);
    const mk = (extra: Record<string, unknown> = {}) => task(lead, p.id, { title: "T", dueDate: istDate(3), ...extra });
    const conv = (a: Account, id: string) => a.c.post(`/api/tasks/${id}/convert`, g);

    expect((await conv(viewer, await mk())).status).toBe(403);
    const parent = await mk();
    expect((await conv(lead, await task(lead, p.id, { title: "Sub", parentId: parent }))).status).toBe(400);
    const trashed = await mk();
    await lead.c.del(`/api/tasks/${trashed}`);
    expect((await conv(lead, trashed)).status).toBe(404);
    const done = await mk();
    await lead.c.post(`/api/tasks/${done}/complete`);
    expect((await conv(lead, done)).status).toBe(409);
    const held = await mk({ approverId: ap.id });
    expect((await lead.c.post(`/api/tasks/${held}/send-for-approval`)).status).toBe(200);
    expect((await conv(lead, held)).status).toBe(409);
    const late = await mk();
    await lead.c.post(`/api/projects/${p.id}/archive`);
    expect((await conv(lead, late)).status).toBe(409);
  });

  it("undoes: the task and subtasks go back to their Section and the new deal is archived", async () => {
    const lead = await account("ulead");
    const p = await project(lead, lead);
    const t = await task(lead, p.id, { title: "Undo me", dueDate: istDate(3), sectionId: p.doing });
    const sub = await task(lead, p.id, { title: "Child", parentId: t });
    await lead.c.post(`/api/tasks/${t}/idea`, { isIdea: true });
    const r = await lead.c.post(`/api/tasks/${t}/convert`, await gate(lead));
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.headers.get("x-undo-label")).toBe("Task converted to a deal");
    const dealId = r.json.deal.id as string;
    const u = await lead.c.post(`/api/actions/${r.headers.get("x-undo-id")}/undo`);
    expect(u.status, JSON.stringify(u.json)).toBe(200);
    const back = (await lead.c.get(`/api/tasks/${t}`)).json.task;
    expect(back.project.id).toBe(p.id);
    expect(back.section.id).toBe(p.doing);
    expect(back.isIdea).toBe(true);
    expect((await lead.c.get(`/api/tasks/${sub}`)).json.task.projectId).toBe(p.id);
    expect((await lead.c.get(`/api/projects/${dealId}`)).json.project.archived).toBe(true);
  });

  it("converts a task that lives in a deal, flags the source deal's missing next step, and undoes", async () => {
    const lead = await account("dlead3");
    const org = await newOrg(lead);
    const pr = await pipes(lead);
    const d = await lead.c.post("/api/deals", { name: `D ${Date.now()}`, organisationId: org, pipelineId: pr.proactive.id, leaderId: lead.id, whyPursue: "x", nextStep: { title: "n", dueDate: istDate(2) } });
    const src = d.json.deal.id;
    type Row = { id: string; needsNextStep: boolean; nextStep: { id: string } | null };
    const before = ((await lead.c.get("/api/deals")).json.deals as Row[]).find((x) => x.id === src)!;
    expect(before.nextStep).toBeTruthy();
    const r = await lead.c.post(`/api/tasks/${before.nextStep!.id}/convert`, await gate(lead));
    expect(r.status).toBe(201);
    expect(r.json.deal.id).not.toBe(src);
    const after = ((await lead.c.get("/api/deals")).json.deals as Row[]).find((x) => x.id === src)!;
    expect(after.nextStep).toBeNull();
    expect(after.needsNextStep).toBe(true);
  });
});

describe("Home data (13.1, 12.5 AC3)", () => {
  it("marks deal headings with type and stage, and lists led deals that need a next step", async () => {
    const lead = await account("hlead");
    const org = await newOrg(lead);
    const pr = await pipes(lead);
    const d = await lead.c.post("/api/deals", { name: `HD ${Date.now()}`, organisationId: org, pipelineId: pr.proactive.id, leaderId: lead.id, whyPursue: "x", nextStep: { title: "n", dueDate: istDate(2) } });
    const id = d.json.deal.id as string;
    const mine = (await lead.c.get("/api/my-tasks")).json;
    const item = [...mine.overdue, ...mine.next7, ...mine.later].find((x: { project: { id: string } }) => x.project.id === id);
    expect(item.project).toMatchObject({ type: "DEAL", stage: "Lead" });
    expect(mine.needsNextStep.some((x: { id: string }) => x.id === id)).toBe(false);
    await lead.c.post(`/api/tasks/${item.id}/complete`);
    const after = (await lead.c.get("/api/my-tasks")).json;
    expect(after.needsNextStep.find((x: { id: string }) => x.id === id)).toMatchObject({ name: expect.any(String), stage: "Lead" });
  });
});
