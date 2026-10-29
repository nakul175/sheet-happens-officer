// Executed from the dedicated Linux staging directory; fixture output contains synthetic accounts only.
import { expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { account, istDate, task, withVersion } from "./helpers";

it("SHO-3050 staging AC1–AC6: retain comments/history, assigned follow-ups, terminal signals and atomic refusals", async () => {
  const lead = await account("zztest3050leader");
  const worker = await account("zztest3050worker");
  const viewer = await account("zztest3050viewer");
  const pipes = (await lead.c.get("/api/deals/pipelines")).json.pipelines;
  const pipe = pipes.find((p: { key: string }) => p.key === "DEAL_PROACTIVE");
  const won = pipe.stages.find((s: { name: string }) => s.name === "Won").id;
  const lost = pipe.stages.find((s: { name: string }) => s.name === "Lost").id;
  const organisationId = (await lead.c.post("/api/orgs", { name: `ZZ-TEST-3050-buyer-${Date.now()}` })).json.organisation.id;
  const made = await lead.c.post("/api/deals", { name: `ZZ-TEST-3050-contract-${Date.now()}`, organisationId, pipelineId: pipe.id, leaderId: lead.id, whyPursue: "Isolated Won acceptance", nextStep: { title: "ZZ-TEST existing sales work", dueDate: istDate(3) } });
  expect(made.status).toBe(201);
  const id = made.json.deal.id;
  for (const [who, role] of [[worker, "EDITOR"], [viewer, "VIEWER"]] as const) {
    expect((await lead.c.post(`/api/projects/${id}/members`, { userId: who.id, role })).status).toBe(201);
  }
  const t = await task(lead, id, { title: "ZZ-TEST retain contract task", assigneeId: worker.id, collaboratorIds: [lead.id], dueDate: istDate(4) });
  expect((await worker.c.post(`/api/tasks/${t}/comments`, { text: "ZZ-TEST contract history must survive Won" })).status).toBe(201);
  const snapshot = (await worker.c.get(`/api/tasks/${t}`)).json.task;
  const comments = (await worker.c.get(`/api/tasks/${t}/comments`)).json.comments;
  const active = (await lead.c.get(`/api/projects/${id}`)).json.project.deal.stage.id;
  const lostAttempt = await lead.c.post(`/api/projects/${id}/stage`, { stageId: lost, reason: "ZZ-TEST refusal" });
  expect(lostAttempt.status).toBe(409);
  const moved = await lead.c.post(`/api/projects/${id}/stage`, { stageId: won, expectedStageId: active });
  expect(moved.status).toBe(200);
  expect((await worker.c.get(`/api/tasks/${t}`)).json.task).toEqual(snapshot);
  expect((await worker.c.get(`/api/tasks/${t}/comments`)).json.comments).toEqual(comments);
  const follow = await worker.c.post(`/api/projects/${id}/tasks`, { title: "ZZ-TEST assigned Won follow-up", assigneeId: worker.id, dueDate: istDate(5) });
  expect(follow.status).toBe(201);
  const followId = follow.json.task.id;
  const mine = (await worker.c.get("/api/my-tasks")).json;
  const rows = Object.values(mine).filter(Array.isArray).flat() as { id: string }[];
  expect(rows.some((x) => x.id === t)).toBe(true);
  expect(rows.some((x) => x.id === followId)).toBe(true);
  const beforeRefusal = (await lead.c.get(`/api/projects/${id}`)).json.project;
  const history = (await lead.c.get(`/api/projects/${id}/activity`)).json.items;
  expect((await viewer.c.post(`/api/projects/${id}/tasks`, { title: "Denied follow-up" })).status).toBe(403);
  expect((await worker.c.post(`/api/projects/${id}/tasks`, { title: "Invalid holder", assigneeId: viewer.id })).status).toBe(400);
  expect((await lead.c.post(`/api/projects/${id}/stage`, { stageId: active, expectedStageId: active, fields: { need: "Must roll back" } })).status).toBe(409);
  // This validation fails inside the transaction, after the guarded stage write:
  // optional detail validation must roll back that write and its updatedAt too.
  expect((await lead.c.post(`/api/projects/${id}/stage`, { stageId: active, expectedStageId: won, fields: { value: -1, currency: "INR" } })).status).toBe(400);
  expect((await lead.c.get(`/api/projects/${id}`)).json.project).toEqual(beforeRefusal);
  expect((await lead.c.get(`/api/projects/${id}/activity`)).json.items).toEqual(history);
  const report = (await lead.c.get(`/api/deals?pipelineId=${pipe.id}`)).json.deals.find((d: { id: string }) => d.id === id);
  expect(report).toMatchObject({ stage: { id: won, category: "DONE" }, nextStep: null, stalled: false, needsNextStep: false });
  expect((await worker.c.post(`/api/tasks/${followId}/complete`, await withVersion(worker, followId))).status).toBe(200);
  expect((await lead.c.get(`/api/projects/${id}`)).json.project.deal.stage.id).toBe(won);
  writeFileSync("browser-fixture.json", JSON.stringify({ projectId: id, taskId: t, lead: { email: lead.email, id: lead.id }, worker: { email: worker.email, id: worker.id }, won, active, release: process.env.RELEASE }, null, 2));
});
