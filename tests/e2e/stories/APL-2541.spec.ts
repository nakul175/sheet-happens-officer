// SHO-US-12.5 A next step on every open deal (APL-2541).
// One test per acceptance criterion. Data is ZZ-TEST deals, organisations and tasks, archived afterwards.
// A second person (the plain Member) is only used where the assignee must send a task for approval.
// Credentials come from the environment through the admin and member fixtures. workers is 1 in playwright.config.ts.
import { test, expect, zz } from "../support";
import { getTask, ghost, newProject, newTask, ymd, type Who } from "../g2";

type Later = (fn: () => Promise<unknown>) => void;
type Stage = { id: string; name: string; category: string; needsReason: boolean };
type Pipe = { id: string; key: string; stages: Stage[] };
type DealRow = { id: string; nextStep: { id: string; title: string } | null; needsNextStep: boolean; stage: { name: string; category: string } | null };

async function pipelines(admin: Who) {
  const r = await admin.api.get("/api/deals/pipelines");
  expect(r.status).toBe(200);
  return r.json.pipelines as Pipe[];
}

/** A ZZ-TEST organisation and a Proactive deal led by `leaderId` (default: the Super Admin). Both are archived afterwards. */
async function makeDeal(admin: Who, later: Later, o: { label: string; leaderId?: string; due?: string; step?: string } = { label: "deal" }) {
  const org = await admin.api.post("/api/orgs", { name: zz(`org ${o.label}`) });
  expect(org.status, JSON.stringify(org.json)).toBe(201);
  const orgId = org.json.organisation.id as string;
  later(() => admin.api.post(`/api/orgs/${orgId}/archive`, { archive: true }));
  const pro = (await pipelines(admin)).find((p) => p.key === "DEAL_PROACTIVE")!;
  const step = o.step ?? zz(`step ${o.label}`);
  const name = zz(`deal ${o.label}`);
  const d = await admin.api.post("/api/deals", {
    name, organisationId: orgId, pipelineId: pro.id, leaderId: o.leaderId ?? admin.user.id, whyPursue: "ZZ-TEST fit",
    nextStep: { title: step, dueDate: o.due ?? ymd(8) },
  });
  expect(d.status, JSON.stringify(d.json)).toBe(201);
  const id = d.json.deal.id as string;
  later(() => admin.api.post(`/api/projects/${id}/archive`));
  return { id, name, step, pro };
}

async function dealRow(admin: Who, pipeId: string, id: string) {
  const deals = (await admin.api.get(`/api/deals?pipelineId=${pipeId}`)).json.deals as DealRow[];
  const row = deals.find((d) => d.id === id);
  expect(row, "the deal is on the pipeline").toBeTruthy();
  return row!;
}

async function stepNotices(who: Who, dealId: string) {
  const items = (await who.api.get("/api/notifications?limit=200")).json.items as { id: string; text: string; href: string }[];
  return items.filter((n) => n.text.includes("needs a next step") && n.href.includes(dealId));
}

test("AC1: the next step is the earliest-due open top-level dated task, including one awaiting approval, and not a subtask, an undated task or Trash", async ({ admin, member, later }) => {
  test.setTimeout(120_000);
  const d = await makeDeal(admin, later, { label: "earliest", due: ymd(8), step: zz("first") });
  const midTitle = zz("mid");
  const mid = await newTask(admin, d.id, { title: midTitle, dueDate: ymd(4) });
  const subTitle = zz("sub earlier");
  await newTask(admin, d.id, { title: subTitle, dueDate: ymd(0), parentId: mid }); // earlier than every top-level task, but a subtask
  await newTask(admin, d.id, { title: zz("undated") }); // no date, so not a next step
  expect((await admin.api.post(`/api/projects/${d.id}/members`, { userId: member.user.id, role: "EDITOR" })).status).toBe(201);
  const approver = await ghost(admin, later, "approver");
  expect((await admin.api.post(`/api/projects/${d.id}/members`, { userId: approver.id, role: "EDITOR" })).status).toBe(201);
  const soonTitle = zz("soon");
  const soon = await newTask(admin, d.id, { title: soonTitle, dueDate: ymd(1), assigneeId: member.user.id });

  expect((await dealRow(admin, d.pro.id, d.id)).nextStep?.title).toBe(soonTitle);

  // The assignee cannot name their own approver, so the Leader sets one and the holder sends it.
  expect((await admin.api.put(`/api/tasks/${soon}/approver`, { approverId: approver.id, expectedUpdatedAt: (await admin.api.get(`/api/tasks/${soon}`)).json.task.updatedAt })).status).toBe(200);
  expect((await member.api.post(`/api/tasks/${soon}/send-for-approval`, {})).status).toBe(200);
  expect((await getTask(admin, soon)).awaitingApproval, "the task is waiting for approval").toBe(true);
  expect((await dealRow(admin, d.pro.id, d.id)).nextStep, "a task awaiting approval still counts").toMatchObject({ id: soon, title: soonTitle });

  expect((await admin.api.del(`/api/tasks/${soon}`)).status).toBe(204);
  expect((await dealRow(admin, d.pro.id, d.id)).nextStep?.title, "Trash drops out; the subtask still does not count").toBe(midTitle);
  expect((await admin.api.del(`/api/tasks/${mid}`)).status).toBe(204);
  expect((await dealRow(admin, d.pro.id, d.id)).nextStep?.title).toBe(d.step);
});

test("AC2: a working deal with no next step is flagged on the deal, the board, the list and Home, and the Leader is told again only after the first notice was read", async ({ admin, later }) => {
  test.setTimeout(180_000);
  const d = await makeDeal(admin, later, { label: "flag", due: ymd(3) });
  const stepId = (await dealRow(admin, d.pro.id, d.id)).nextStep!.id;
  expect((await admin.api.post(`/api/tasks/${stepId}/complete`, { expectedUpdatedAt: (await admin.api.get(`/api/tasks/${stepId}`)).json.task.updatedAt })).status).toBe(200);

  await admin.page.goto(`/projects/${d.id}`);
  await expect(admin.page.getByText("No next step. Add a dated task.")).toBeVisible();

  await admin.page.goto("/deals");
  const card = admin.page.locator(".dcard", { hasText: d.name });
  await expect(card.locator(".chip.red")).toHaveText("Needs a next step");
  await admin.page.getByRole("group", { name: "Layout" }).getByRole("button", { name: "List" }).click();
  // The list's warning is the red chip "None". The board uses the longer phrase above.
  await expect(admin.page.locator("tr", { hasText: d.name }).locator(".chip.red")).toHaveText("None");

  await admin.page.goto("/");
  const home = admin.page.getByRole("region", { name: "Deals that need a next step" });
  await expect(home.locator(".card", { hasText: d.name }).getByRole("button", { name: "+ Add task" })).toBeVisible();

  const first = await stepNotices(admin, d.id);
  expect(first).toHaveLength(1);
  expect(first[0].text).toBe(`"${d.name}" needs a next step.`);

  // An undated task is not a next step, and finishing it does not send another notice while one is unread.
  const undated = await newTask(admin, d.id, { title: zz("no date") });
  expect((await admin.api.post(`/api/tasks/${undated}/complete`, { expectedUpdatedAt: (await admin.api.get(`/api/tasks/${undated}`)).json.task.updatedAt })).status).toBe(200);
  expect(await stepNotices(admin, d.id)).toHaveLength(1);
  // Losing the only dated task is the same gate: still one unread notice, so nothing new is sent.
  const dated = await newTask(admin, d.id, { title: zz("dated again"), dueDate: ymd(2) });
  expect((await admin.api.patch(`/api/tasks/${dated}`, { dueDate: null, expectedUpdatedAt: (await admin.api.get(`/api/tasks/${dated}`)).json.task.updatedAt })).status).toBe(200);
  expect(await stepNotices(admin, d.id)).toHaveLength(1);

  expect((await admin.api.post(`/api/notifications/${first[0].id}/read`)).status).toBe(204);
  const again = await newTask(admin, d.id, { title: zz("dated once more"), dueDate: ymd(4) });
  expect((await admin.api.post(`/api/tasks/${again}/complete`, { expectedUpdatedAt: (await admin.api.get(`/api/tasks/${again}`)).json.task.updatedAt })).status).toBe(200);
  expect(await stepNotices(admin, d.id), "once the first notice is read, the deal can notify again").toHaveLength(2);
});

test("AC3: completing the last dated task on Home asks what is next at the top of the page, with + Next task and Not now", async ({ admin, later }) => {
  test.setTimeout(120_000);
  const d = await makeDeal(admin, later, { label: "prompt", due: ymd(2), step: zz("only step") });
  await admin.page.goto("/");
  await admin.page.getByRole("button", { name: `Complete "${d.step}"` }).click();
  const prompt = admin.page.locator(".card", { hasText: `What is next for ${d.name}?` });
  await expect(prompt).toBeVisible();
  await expect(prompt.getByRole("button", { name: "+ Next task" })).toBeVisible();
  await expect(prompt.getByRole("button", { name: "Not now" })).toBeVisible();
  // The prompt is the first card, above every task group. It does not sit under the task that was just completed.
  const promptY = (await prompt.boundingBox())!.y;
  const group = admin.page.locator(".grp").first();
  await expect(group).toBeVisible();
  expect((await group.boundingBox())!.y).toBeGreaterThan(promptY);
  await expect(admin.page.getByRole("button", { name: `Complete "${d.step}"` })).toHaveCount(0);
  await prompt.getByRole("button", { name: "Not now" }).click();
  await expect(prompt).toHaveCount(0);
});

test("AC4: Paused, Done, Lost and archived deals are not flagged, and neither is a plain project", async ({ admin, later }) => {
  test.setTimeout(180_000);
  const pro = (await pipelines(admin)).find((p) => p.key === "DEAL_PROACTIVE")!;
  const stage = (name: string) => pro.stages.find((s) => s.name === name)!;
  const needs = async () => ((await admin.api.get("/api/my-tasks")).json.needsNextStep as { id: string }[]).map((n) => n.id);

  // Paused before the last dated task is closed: the close does not flag it and does not notify.
  const paused = await makeDeal(admin, later, { label: "paused" });
  expect((await admin.api.post(`/api/projects/${paused.id}/stage`, { stageId: stage("On hold").id, reason: "ZZ-TEST pause" })).status).toBe(200);
  const pausedStep = (await dealRow(admin, pro.id, paused.id)).nextStep!.id;
  expect((await admin.api.post(`/api/tasks/${pausedStep}/complete`, { expectedUpdatedAt: (await admin.api.get(`/api/tasks/${pausedStep}`)).json.task.updatedAt })).status).toBe(200);
  expect((await dealRow(admin, pro.id, paused.id)).needsNextStep).toBe(false);
  expect(await stepNotices(admin, paused.id)).toHaveLength(0);
  expect(await needs()).not.toContain(paused.id);
  await admin.page.goto(`/projects/${paused.id}`);
  await expect(admin.page.getByText("No next step needed in this stage.")).toBeVisible();
  await expect(admin.page.getByText("No next step. Add a dated task.")).toHaveCount(0);

  // Done and Lost cannot be reached while a task is open, so the close flags the working deal and the stage change clears it.
  for (const name of ["Won", "Lost"] as const) {
    const d = await makeDeal(admin, later, { label: name.toLowerCase() });
    const step = (await dealRow(admin, pro.id, d.id)).nextStep!.id;
    expect((await admin.api.post(`/api/tasks/${step}/complete`, { expectedUpdatedAt: (await admin.api.get(`/api/tasks/${step}`)).json.task.updatedAt })).status).toBe(200);
    expect((await dealRow(admin, pro.id, d.id)).needsNextStep, `${name}: flagged while the deal is still working`).toBe(true);
    const body = name === "Lost" ? { stageId: stage(name).id, reason: "ZZ-TEST lost" } : { stageId: stage(name).id };
    expect((await admin.api.post(`/api/projects/${d.id}/stage`, body)).status, name).toBe(200);
    // A closed deal leaves the working columns; read it from the project.
    const block = (await admin.api.get(`/api/projects/${d.id}`)).json.project.deal as { needsNextStep: boolean; stage: { name: string } };
    expect(block.stage.name).toBe(name);
    expect(block.needsNextStep, `${name} is not a working stage`).toBe(false);
    expect(await needs()).not.toContain(d.id);
  }

  const archived = await makeDeal(admin, later, { label: "archived" });
  const archivedStep = (await dealRow(admin, pro.id, archived.id)).nextStep!.id;
  expect((await admin.api.post(`/api/tasks/${archivedStep}/complete`, { expectedUpdatedAt: (await admin.api.get(`/api/tasks/${archivedStep}`)).json.task.updatedAt })).status).toBe(200);
  expect((await admin.api.post(`/api/projects/${archived.id}/archive`)).status).toBeLessThan(300);
  const live = (await admin.api.get(`/api/deals?pipelineId=${pro.id}`)).json.deals as { id: string }[];
  expect(live.some((d) => d.id === archived.id)).toBe(false);
  const old = (await admin.api.get(`/api/deals?pipelineId=${pro.id}&archived=true`)).json.deals as DealRow[];
  expect(old.find((d) => d.id === archived.id)?.needsNextStep).toBe(false);
  expect(await needs()).not.toContain(archived.id);

  const plain = await newProject(admin, later, { label: "plain" });
  const task = await newTask(admin, plain.id, { title: zz("plain task"), dueDate: ymd(1), assigneeId: admin.user.id });
  expect((await admin.api.post(`/api/tasks/${task}/complete`, { expectedUpdatedAt: (await admin.api.get(`/api/tasks/${task}`)).json.task.updatedAt })).status).toBe(200);
  expect(await needs()).not.toContain(plain.id);
  expect(await stepNotices(admin, plain.id)).toHaveLength(0);
});

test("AC5: no new reminder is added; the next step is an ordinary dated task, so the existing daily reminder covers it", async ({ admin, later }) => {
  const d = await makeDeal(admin, later, { label: "remind", due: ymd(1), step: zz("due tomorrow") });
  const step = (await dealRow(admin, d.pro.id, d.id)).nextStep!;
  const task = await getTask(admin, step.id);
  // sendReminders reads open, unblocked, dated tasks on a live project and writes TASK_DUE_TOMORROW / TODAY / OVERDUE.
  // A browser session has no job secret, so this checks the row the job would pick up, not the cron itself.
  expect(task.completedAt).toBeNull();
  expect(task.blocked).toBe(false);
  expect(task.dueDate).toBe(ymd(1));
  expect(task.assignee.id).toBe(admin.user.id);
  const mine = (await admin.api.get("/api/my-tasks")).json as { overdue: { id: string }[]; next7: { id: string }[]; later: { id: string }[] };
  expect([...mine.overdue, ...mine.next7, ...mine.later].some((t) => t.id === step.id), "the next step is on My tasks, which is the reminder's list").toBe(true);

  const jobs = (await admin.api.get("/api/jobs")).json.jobs as { job: string; about: string }[];
  const reminders = jobs.find((j) => j.job === "reminders");
  expect(reminders, "the existing daily reminder job").toBeTruthy();
  expect(reminders!.about).toMatch(/Due-tomorrow, due-today and overdue/);
  expect(jobs.some((j) => j.job !== "reminders" && /remind/i.test(j.job))).toBe(false);

  const notes = (await admin.api.get("/api/notifications?limit=200")).json.items as { text: string }[];
  const aboutStep = notes.filter((n) => n.text.includes(d.step));
  expect(aboutStep.some((n) => /due tomorrow|due today|is overdue/.test(n.text)), "creating the next step does not send a new kind of reminder").toBe(false);
});
