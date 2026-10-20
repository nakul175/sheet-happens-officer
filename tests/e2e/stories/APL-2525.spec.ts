// SHO-E12 Deals (Linear APL-2525).
// Pam left no qa:TC id. Each title says qa:TC missing. The annotation is qa:TC with description missing. An AC number is not a TC id.
// One test per acceptance criterion. People are nakul17+ aliases signed in with SHO_QA_PASS.
// Deals, organisations and tasks are ZZ-TEST and archived afterwards.
// Pam left no qa:TC cases on this issue.
import { test, expect, zz, withTaskVersion } from "../support";
import { getTask, newProject, newTask, ymd, type Who } from "../g2";
import { pipelines, type Stage } from "../helpers/deal-board";
import { createDeal, createOrg, dealBody, projectOf } from "../helpers/claude-a";
import { cast, gateFile } from "../helpers/qa-alias";

gateFile("APL-2525");

const CRM_OFF = "CRM routes answer not found on this server (CRM_VISIBLE is off).";

async function pipes(who: Who) {
  const r = await who.api.get("/api/deals/pipelines");
  expect(r.status, CRM_OFF + " " + JSON.stringify(r.json)).toBe(200);
  return pipelines(who.api);
}

const stageNamed = (stages: Stage[], name: string) => {
  const stage = stages.find((s) => s.name === name);
  expect(stage, name).toBeTruthy();
  return stage!;
};

// qa:TC missing
test("AC1: creating a deal with a name, Leader, buyer and a dated first next step saves a Deal qa:TC missing", async ({ browser, later }) => {
  test.setTimeout(120_000);
  const { admin, people: [leader] } = await cast(browser, later, ["deal leader"]);
  const { pro } = await pipes(admin);
  const org = await createOrg(admin, later, "e12 buyer");
  const step = zz("first next step");
  const due = ymd(6);
  const name = zz("e12 created");
  const deal = await createDeal(admin, later, dealBody({ name, organisationId: org.id, pipelineId: pro.id, leaderId: leader.user.id, step, due }));
  later(() => admin.api.post(`/api/projects/${deal.id}/leader`, { newLeaderId: admin.user.id, previousRole: "EDITOR" }));
  const project = await projectOf(admin, deal.id);
  expect(project.type).toBe("DEAL");
  expect(project.deal.organisation.id).toBe(org.id);
  expect(project.deal.parties.some((p: { role: string; organisation: { id: string } }) => p.role === "BUYER" && p.organisation.id === org.id)).toBe(true);
  const role = (project.members as { userId: string; role: string }[]).find((m) => m.userId === leader.user.id)?.role;
  expect(role).toBe("LEADER");
  const next = await getTask(admin, project.deal.nextStep.id as string);
  expect(next.title).toBe(step);
  expect(next.dueDate).toBe(due);
  expect(next.completedAt).toBeNull();
  expect(next.project.id).toBe(deal.id);
});

// qa:TC missing
test("AC2: an open project task converts through the same gate, and a task already in a deal does not qa:TC missing", async ({ browser, later }) => {
  test.setTimeout(180_000);
  const { admin } = await cast(browser, later, []);
  const { pro } = await pipes(admin);
  const org = await createOrg(admin, later, "e12 convert buyer");
  const source = await newProject(admin, later, { label: "e12 convert from" });
  const title = zz("convert me");
  const due = ymd(5);
  const taskId = await newTask(admin, source.id, { title, dueDate: due, assigneeId: admin.user.id });
  const name = zz("e12 converted");
  const converted = await admin.api.post(`/api/tasks/${taskId}/convert`, {
    organisationId: org.id, pipelineId: pro.id, whyPursue: "ZZ-TEST fit", dueDate: due, name, leaderId: admin.user.id,
  });
  expect(converted.status, JSON.stringify(converted.json)).toBe(201);
  const dealId = converted.json.deal.id as string;
  later(() => admin.api.post(`/api/projects/${dealId}/archive`));
  const project = await projectOf(admin, dealId);
  expect(project.type).toBe("DEAL");
  expect(project.deal.organisation.id).toBe(org.id);
  expect(project.deal.nextStep.id).toBe(taskId);
  expect((await getTask(admin, taskId)).completedAt).toBeNull();
  const again = await admin.api.post(`/api/tasks/${taskId}/convert`, {
    organisationId: org.id, pipelineId: pro.id, whyPursue: "ZZ-TEST fit", dueDate: due, name: zz("second convert"), leaderId: admin.user.id,
  });
  expect(again.status, JSON.stringify(again.json)).toBe(400);
  expect(again.json.error).toBe("Only a task in a project can be converted to a deal.");
});

// qa:TC missing
test("AC3: the deal page shows members, sections, tasks, Trash and Activity, plus stage, organisations, reason and next step qa:TC missing", async ({ browser, later }) => {
  test.setTimeout(180_000);
  const { admin } = await cast(browser, later, []);
  const { pro } = await pipes(admin);
  const org = await createOrg(admin, later, "e12 page org");
  const step = zz("page step");
  const deal = await createDeal(admin, later, dealBody({ name: zz("e12 page"), organisationId: org.id, pipelineId: pro.id, leaderId: admin.user.id, step }));
  const hold = stageNamed(pro.stages, "On hold");
  const reason = "ZZ-TEST pause";
  await admin.page.goto(`/projects/${deal.id}`);
  const stage = admin.page.getByRole("group", { name: "Stage" });
  await stage.getByRole("button", { name: hold.name, exact: true }).click();
  const dialog = admin.page.getByRole("dialog", { name: `Move to ${hold.name}` });
  await dialog.getByLabel("Reason (required)").fill(reason);
  await dialog.getByRole("button", { name: "Move deal" }).click();
  await expect(stage.getByRole("button", { name: hold.name, exact: true })).toHaveAttribute("aria-current", "step");
  await expect(admin.page.getByRole("link", { name: "Members" })).toBeVisible();
  await expect(admin.page.getByRole("link", { name: "Trash" })).toBeVisible();
  await expect(admin.page.getByRole("link", { name: "Activity" })).toBeVisible();
  await expect(admin.page.getByRole("region", { name: "To do" })).toBeVisible();
  await expect(admin.page.getByRole("region", { name: "In progress" })).toBeVisible();
  await expect(admin.page.getByRole("region", { name: "Done" })).toBeVisible();
  await expect(admin.page.getByRole("region", { name: "To do" }).getByText(step)).toBeVisible();
  await expect(admin.page.getByRole("main").getByRole("link", { name: org.name, exact: true })).not.toHaveCount(0);
  await expect(admin.page.getByText("Buyer:")).toBeVisible();
  await expect(admin.page.getByText(`Reason: ${reason}`)).toBeVisible();
  await expect(admin.page.getByText(`Next step: ${step}`)).toBeVisible();
  await admin.page.getByRole("link", { name: "Members" }).click();
  await expect(admin.page.getByRole("heading", { name: "Members" })).toBeVisible();
});

// qa:TC missing
test("AC4: the next step is the earliest-due open dated task qa:TC missing", async ({ browser, later }) => {
  const { admin } = await cast(browser, later, []);
  const { pro } = await pipes(admin);
  const org = await createOrg(admin, later, "e12 next org");
  const laterTitle = zz("later step");
  const deal = await createDeal(admin, later, dealBody({
    name: zz("e12 next"), organisationId: org.id, pipelineId: pro.id, leaderId: admin.user.id, step: laterTitle, due: ymd(12),
  }));
  const sooner = zz("sooner step");
  const soonerId = await newTask(admin, deal.id, { title: sooner, dueDate: ymd(2), assigneeId: admin.user.id });
  await newTask(admin, deal.id, { title: zz("undated step"), assigneeId: admin.user.id });
  const first = await projectOf(admin, deal.id);
  expect(first.deal.nextStep.title).toBe(sooner);
  expect(first.deal.nextStep.id).toBe(soonerId);
  expect((await admin.api.post(`/api/tasks/${soonerId}/complete`, await withTaskVersion(admin.api, soonerId))).status).toBe(200);
  const second = await projectOf(admin, deal.id);
  expect(second.deal.nextStep.title).toBe(laterTitle);
  expect(second.deal.nextStep.dueDate).toBe(ymd(12));
});

// qa:TC missing
test("AC5: Won and Lost are refused while a task is open, and a finished move leaves the deal and its tasks as they were qa:TC missing", async ({ browser, later }) => {
  test.setTimeout(120_000);
  const { admin } = await cast(browser, later, []);
  const { pro } = await pipes(admin);
  const org = await createOrg(admin, later, "e12 close org");
  const deal = await createDeal(admin, later, dealBody({ name: zz("e12 close"), organisationId: org.id, pipelineId: pro.id, leaderId: admin.user.id }));
  const won = stageNamed(pro.stages, "Won");
  const lost = stageNamed(pro.stages, "Lost");
  const stepId = (await projectOf(admin, deal.id)).deal.nextStep.id as string;
  const wonOpen = await admin.api.post(`/api/projects/${deal.id}/stage`, { stageId: won.id });
  expect(wonOpen.status, JSON.stringify(wonOpen.json)).toBe(409);
  expect(wonOpen.json.openTasks).toBeGreaterThan(0);
  const lostOpen = await admin.api.post(`/api/projects/${deal.id}/stage`, { stageId: lost.id, reason: "ZZ-TEST lost" });
  expect(lostOpen.status).toBe(409);
  expect((await getTask(admin, stepId)).completedAt).toBeNull();
  expect((await projectOf(admin, deal.id)).archived).toBe(false);
  expect((await admin.api.post(`/api/tasks/${stepId}/complete`, await withTaskVersion(admin.api, stepId))).status).toBe(200);
  const closedAt = (await getTask(admin, stepId)).completedAt as string;
  const moved = await admin.api.post(`/api/projects/${deal.id}/stage`, { stageId: won.id });
  expect(moved.status, JSON.stringify(moved.json)).toBe(200);
  const after = await projectOf(admin, deal.id);
  expect(after.deal.stage.name).toBe("Won");
  expect(after.archived).toBe(false);
  expect((await getTask(admin, stepId)).completedAt).toBe(closedAt);
});

// qa:TC missing
test("AC6 (no next step): a working deal whose dated step is done tells its Leader it needs a next step qa:TC missing", async ({ browser, later }) => {
  // The 30-quiet-days half of AC6 runs on an in-process clock in tests/stall-clock-2709.test.ts. The server has no clock hook yet (APL-2757).
  test.setTimeout(180_000);
  const { admin, people: [leader] } = await cast(browser, later, ["stall leader"]);
  const { pro } = await pipes(admin);
  const org = await createOrg(admin, later, "e12 stall org");
  const empty = await createDeal(admin, later, dealBody({ name: zz("e12 no step"), organisationId: org.id, pipelineId: pro.id, leaderId: leader.user.id }));
  later(() => admin.api.post(`/api/projects/${empty.id}/leader`, { newLeaderId: admin.user.id, previousRole: "EDITOR" }));
  const notes = async () => ((await leader.api.get("/api/notifications?limit=200")).json.items ?? []) as { text: string; href: string }[];
  const stepId = (await projectOf(admin, empty.id)).deal.nextStep.id as string;
  expect((await admin.api.post(`/api/tasks/${stepId}/complete`, await withTaskVersion(admin.api, stepId))).status).toBe(200);
  const needs = (await notes()).filter((n) => n.text.includes(empty.name) && n.text.includes("needs a next step"));
  expect(needs).toHaveLength(1);
});

// qa:TC missing
test("AC7: on the pipeline board each deal sits in the column of its current stage qa:TC missing", async ({ browser, later }) => {
  test.setTimeout(180_000);
  const { admin } = await cast(browser, later, []);
  const { pro } = await pipes(admin);
  const org = await createOrg(admin, later, "e12 board org");
  const deal = await createDeal(admin, later, dealBody({ name: zz("e12 board"), organisationId: org.id, pipelineId: pro.id, leaderId: admin.user.id }));
  const lead = pro.stages[0];
  const next = pro.stages[1];
  await admin.page.goto("/deals");
  const column = (name: string) => admin.page.getByRole("region", { name, exact: true });
  await expect(column(lead.name).getByRole("link", { name: deal.name, exact: true })).toBeVisible();
  expect((await admin.api.post(`/api/projects/${deal.id}/stage`, { stageId: next.id })).status).toBe(200);
  await admin.page.reload();
  await expect(column(next.name).getByRole("link", { name: deal.name, exact: true })).toBeVisible();
  await expect(column(lead.name).getByRole("link", { name: deal.name, exact: true })).toHaveCount(0);
});
