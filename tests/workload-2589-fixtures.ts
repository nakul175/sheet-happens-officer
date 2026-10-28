import { expect } from "vitest";
import { account, BASE, istDate, patchTask, project, superAdmin, task, withVersion, type Account } from "./helpers";

/** API-only setup/cleanup. Refuse remote targets before creating any fixture. */
export async function workloadFixture() {
  if (new URL(BASE).hostname !== "localhost") throw new Error("Workload fixtures require a localhost test server.");
  const run = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const root = await superAdmin();
  const people: Account[] = [];
  const projects: { id: string; lead: string; archived: boolean }[] = [];
  let org = "";
  const cleanup = async () => {
    const errors: string[] = [];
    for (const p of projects) {
      try {
        if (p.archived) expect((await root.c.post(`/api/projects/${p.id}/unarchive`)).status).toBe(200);
        if (p.lead !== root.id) expect((await root.c.post(`/api/projects/${p.id}/leader`, { newLeaderId: root.id, previousRole: "REMOVE", handoverTo: root.id })).status).toBe(200);
        expect((await root.c.post(`/api/projects/${p.id}/archive`)).status).toBe(200);
      } catch (error) { errors.push(`project ${p.id}: ${String(error)}`); }
    }
    for (const p of people) {
      try { expect((await root.c.post(`/api/team/${p.id}/deactivate`, { reassign: "leaders" })).status).toBe(200); }
      catch (error) { errors.push(`person ${p.id}: ${String(error)}`); }
    }
    if (org) {
      try { expect((await root.c.post(`/api/orgs/${org}/archive`, { archive: true })).status).toBe(200); }
      catch (error) { errors.push(`organisation ${org}: ${String(error)}`); }
    }
    if (errors.length) throw new Error(`Workload fixture cleanup failed:\n${errors.join("\n")}`);
  };
  try {
    const person = async (role: string) => { const p = await account(`zzWorkload${role}`, `nakul17+zz-workload-${run}-${role}@aplyd.com`, `ZZ-TEST Workload ${role} ${run}`); people.push(p); return p; };
    const lead = await person("leader"), worker = await person("worker"), viewer = await person("viewer"), outsider = await person("outsider");
    const p = await project(root, lead, [{ who: worker }, { who: viewer, role: "VIEWER" }], `ZZ-TEST Workload led ${run}`);
    projects.push({ id: p.id, lead: lead.id, archived: false });
    const make = async (title: string, fields: Record<string, unknown> = {}) => {
      // Creation requires a date; clearing it is an existing, versioned edit.
      const id = await task(root, p.id, { title: `ZZ-TEST ${title} ${run}`, assigneeId: worker.id, ...fields, ...(fields.dueDate === null ? { dueDate: istDate(7) } : {}) });
      if (fields.dueDate === null) expect((await patchTask(root, id, { dueDate: null })).status).toBe(200);
      return id;
    };
    const parent = await make("Workload blocked parent", { dueDate: istDate(-1) });
    expect((await patchTask(root, parent, { blocked: true, blockedReason: "ZZ-TEST waiting for an answer" })).status).toBe(200);
    const child = await make("Workload child", { parentId: parent, dueDate: istDate(0) });
    const sixthDay = await make("Workload sixth day", { dueDate: istDate(6) });
    const seventhDay = await make("Workload seventh day", { dueDate: istDate(7) });
    const undated = await make("Workload no date", { dueDate: null });
    const approval = await make("Workload approval", { dueDate: null, assigneeId: lead.id, approverId: worker.id });
    expect((await lead.c.post(`/api/tasks/${approval}/send-for-approval`, {})).status).toBe(200);
    const closed = await make("Workload completed");
    expect((await root.c.post(`/api/tasks/${closed}/complete`, await withVersion(root, closed, {}))).status).toBe(200);
    const trash = await make("Workload trash parent");
    await make("Workload trash child", { parentId: trash });
    expect((await root.c.del(`/api/tasks/${trash}`)).status).toBe(204);
    const archivedProject = await project(root, root, [{ who: worker }], `ZZ-TEST Workload archived ${run}`);
    const archivedRecord = { id: archivedProject.id, lead: root.id, archived: false }; projects.push(archivedRecord);
    const archivedTask = await task(root, archivedProject.id, { title: `ZZ-TEST Workload archived task ${run}`, assigneeId: worker.id });
    expect((await root.c.post(`/api/projects/${archivedProject.id}/archive`)).status).toBe(200);
    archivedRecord.archived = true;
    const privateProject = await project(root, root, [{ who: worker }, { who: outsider }], `ZZ-TEST Workload other scope ${run}`);
    projects.push({ id: privateProject.id, lead: root.id, archived: false });
    const privateTask = await task(root, privateProject.id, { title: `ZZ-TEST Workload other scope task ${run}`, assigneeId: worker.id });
    expect((await patchTask(root, privateTask, { dueDate: null })).status).toBe(200);
    const madeOrg = await root.c.post("/api/orgs", { name: `ZZ-TEST Workload organisation ${run}` });
    expect(madeOrg.status).toBe(201); org = madeOrg.json.organisation.id;
    const pipes = (await root.c.get("/api/deals/pipelines")).json.pipelines as { id: string; key: string }[];
    const deal = await root.c.post("/api/deals", { name: `ZZ-TEST Workload hidden deal ${run}`, organisationId: org, pipelineId: pipes.find(p => p.key === "DEAL_PROACTIVE")!.id, leaderId: root.id, whyPursue: "ZZ-TEST Workload scope", nextStep: { title: `ZZ-TEST Workload hidden step ${run}`, dueDate: istDate(7) } });
    expect(deal.status, JSON.stringify(deal.json)).toBe(201);
    const dealId = deal.json.deal.id as string;
    projects.push({ id: dealId, lead: root.id, archived: false });
    expect((await root.c.post(`/api/projects/${dealId}/members`, { userId: worker.id, role: "EDITOR" })).status).toBe(201);
    const dealTasks = (await root.c.get(`/api/projects/${dealId}/tasks?all=true`)).json.sections.flatMap((s: { tasks: { id: string }[] }) => s.tasks) as { id: string }[];
    const dealTask = dealTasks[0].id;
    expect((await root.c.post(`/api/tasks/${dealTask}/assign`, await withVersion(root, dealTask, { assigneeId: worker.id }))).status).toBe(200);
    return { root, lead, worker, viewer, outsider, projectId: p.id, parent, child, sixthDay, seventhDay, undated, approval, archivedTask, privateTask, dealId, dealTask, run, cleanup };
  } catch (error) {
    try { await cleanup(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "Workload setup and cleanup both failed"); }
    throw error;
  }
}
