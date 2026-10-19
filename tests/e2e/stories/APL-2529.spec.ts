// SHO-US-10.3 See and move a workstream's stage (APL-2529).
// Pam left no qa:TC id. Each title says qa:TC missing. The annotation is qa:TC with description missing. An AC number is not a TC id.
// One test per acceptance criterion. ZZ-TEST deals, organisations and people are archived or deactivated afterwards.
// The Super Admin acts as Leader except where AC1 needs someone else to move the stage. The plain Member is that Editor,
// and in AC4 the Viewer. workers is 1 in playwright.config.ts. Traces stay off.
import { expect, zz, withTaskVersion } from "../support";
import { test } from "../helpers/story-people";
import { storyGate } from "../helpers/qa-alias";
import { getTask, ghost, newProject, newTask, ymd, type Who } from "../g2";
import { undoToast } from "../helpers/jim-http";

storyGate({ admin: true, id: "APL-2529" });

type Later = (fn: () => Promise<unknown>) => void;
type Stage = { id: string; name: string; category: string; needsReason: boolean; requiredFields: string[] };
type Pipe = { id: string; key: string; name: string; stages: Stage[] };
type Sec = { id: string; name: string; position: number; isDone: boolean };

const CRM_OFF = "CRM routes answer not found on this server (CRM_VISIBLE is off).";
const CRM_MEMBER = "CRM is hidden from this Member (CRM_VISIBLE is admins or off).";
const FIELD_LABEL: Record<string, string> = {
  value: "Value", currency: "Currency", expectedClose: "Expected close", submissionDeadline: "Submission deadline",
  probability: "Probability", need: "Need", serviceLine: "Service line", introducedBy: "Introduced by",
};

async function crmPipes(who: Who, hidden: string) {
  const r = await who.api.get("/api/deals/pipelines");
  expect(r.status, hidden + " " + JSON.stringify(r.json)).toBe(200);
  return r.json.pipelines as Pipe[];
}

async function makeDeal(admin: Who, later: Later, o: { label: string; leaderId?: string; step?: string }) {
  const pro = (await crmPipes(admin, CRM_OFF)).find((p) => p.key === "DEAL_PROACTIVE");
  if (!pro) throw new Error("Proactive pipeline is missing");
  const org = await admin.api.post("/api/orgs", { name: zz(`org ${o.label}`) });
  expect(org.status, JSON.stringify(org.json)).toBe(201);
  const orgId = org.json.organisation.id as string;
  later(() => admin.api.post(`/api/orgs/${orgId}/archive`, { archive: true }));
  const step = o.step ?? zz(`step ${o.label}`);
  const name = zz(`deal ${o.label}`);
  const d = await admin.api.post("/api/deals", {
    name, organisationId: orgId, pipelineId: pro.id, leaderId: o.leaderId ?? admin.user.id, whyPursue: "ZZ-TEST fit",
    nextStep: { title: step, dueDate: ymd(6) },
  });
  expect(d.status, JSON.stringify(d.json)).toBe(201);
  const id = d.json.deal.id as string;
  later(() => admin.api.post(`/api/projects/${id}/archive`));
  return { id, name, step, pro };
}

const projectOf = async (who: Who, id: string) => (await who.api.get(`/api/projects/${id}`)).json.project as {
  type: string; archived: boolean; openTasks: number; deal: { stage: { name: string }; stageReason: string | null; nextStep: { id: string; title: string } | null; details: Record<string, unknown> | null };
  sections: Sec[];
};

const empty = (v: unknown) => v === null || v === undefined || v === "";

function fieldValues(keys: string[]) {
  const fields: Record<string, unknown> = {};
  for (const k of keys) {
    if (k === "value" || k === "currency") { fields.value = 10; fields.currency = "INR"; }
    else if (k === "probability") fields.probability = 10;
    else if (k === "expectedClose" || k === "submissionDeadline") fields[k] = ymd(30);
    else fields[k] = "ZZ-TEST";
  }
  return fields;
}

// qa:TC missing
test("AC1: the stage changes, the log keeps the before-state, Undo restores it, and the Leader is told qa:TC missing", async ({ admin, member, later }) => {
  test.setTimeout(180_000);
  await crmPipes(member, CRM_MEMBER);
  // The assignee is a ZZ-TEST person with no mailbox, so this session cannot open their bell. The Leader holds no task,
  // and is still the person who is told. The mover is not.
  const assignee = await ghost(admin, later, "assignee");
  const d = await makeDeal(admin, later, { label: "2529 undo", leaderId: member.user.id, step: zz("leader step") });
  expect((await admin.api.post(`/api/projects/${d.id}/members`, { userId: assignee.id, role: "EDITOR" })).status).toBe(201);
  const stepId = (await projectOf(admin, d.id)).deal.nextStep!.id;
  expect((await admin.api.post(`/api/tasks/${stepId}/assign`, await withTaskVersion(admin.api, stepId, { assigneeId: assignee.id }))).status).toBe(200);
  expect((await getTask(admin, stepId)).assignee.id).toBe(assignee.id);

  await member.page.goto("/");
  await admin.page.goto(`/projects/${d.id}`);
  const stage = admin.page.getByRole("group", { name: "Stage" });
  await expect(stage.getByRole("button", { name: "Lead", exact: true })).toHaveAttribute("aria-current", "step");
  await stage.getByRole("button", { name: "Conversation", exact: true }).click();
  const dialog = admin.page.getByRole("dialog", { name: "Move to Conversation" });
  await expect(dialog.getByLabel("Reason (required)")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Move deal" }).click();
  await expect(stage.getByRole("button", { name: "Conversation", exact: true })).toHaveAttribute("aria-current", "step");

  const toast = undoToast(admin);
  await expect(toast).toContainText("Stage changed.");
  await expect(toast).toContainText("Anyone already notified will not be un-notified.");
  const activity = (await admin.api.get(`/api/projects/${d.id}/activity`)).json.items as { what: string }[];
  expect(activity.some((i) => i.what.includes("moved the deal from Lead to Conversation")), "the log row stores the stage it moved from").toBe(true);

  await toast.getByRole("button", { name: "Undo" }).click();
  await expect(admin.page.getByText("Undone: stage changed.")).toBeVisible();
  await expect(stage.getByRole("button", { name: "Lead", exact: true })).toHaveAttribute("aria-current", "step");
  expect((await projectOf(member, d.id)).deal.stage.name).toBe("Lead");

  const leaderNotes = (await member.api.get("/api/notifications?limit=200")).json.items as { text: string; href: string }[];
  const told = leaderNotes.filter((n) => n.text.includes(d.name) && n.text.includes("to Conversation"));
  expect(told).toHaveLength(1);
  expect(told[0].text).toContain(admin.user.name);
  expect(told[0].href).toBe(`/projects/${d.id}`);
  await member.page.getByRole("button", { name: /Notifications/ }).click();
  // The same deal is also the "made you Leader" bell item. The stage notice is the one that says moved.
  await expect(member.page.getByRole("dialog", { name: "Notifications" }).getByRole("link").filter({ hasText: d.name }).filter({ hasText: "moved" })).toContainText("to Conversation");

  const moverNotes = (await admin.api.get("/api/notifications?limit=200")).json.items as { text: string }[];
  expect(moverNotes.some((n) => n.text.includes(d.name) && n.text.includes("to Conversation")), "the mover is not told").toBe(false);
});

// qa:TC missing
test("AC2: On hold and Lost require a reason, and the reason is kept and shown qa:TC missing", async ({ admin, later }) => {
  test.setTimeout(120_000);
  const d = await makeDeal(admin, later, { label: "2529 reason", step: zz("still open") });
  const lost = d.pro.stages.find((s) => s.name === "Lost")!;
  const hold = d.pro.stages.find((s) => s.name === "On hold")!;
  const noReason = await admin.api.post(`/api/projects/${d.id}/stage`, { stageId: lost.id });
  expect(noReason.status).toBe(400);
  expect(noReason.json.needsReason).toBe(true);
  expect((await projectOf(admin, d.id)).deal.stage.name).toBe("Lead");

  await admin.page.goto(`/projects/${d.id}`);
  const stage = admin.page.getByRole("group", { name: "Stage" });
  await stage.getByRole("button", { name: "Lost", exact: true }).click();
  let dialog = admin.page.getByRole("dialog", { name: "Move to Lost" });
  await expect(dialog.getByRole("button", { name: "Move deal" })).toBeDisabled();
  await dialog.getByLabel("Reason (required)").fill("ZZ-TEST lost");
  await dialog.getByRole("button", { name: "Move deal" }).click();
  // Lost also waits until every task is closed. The reason is not stored while the move is refused.
  await expect(dialog.getByRole("alert")).toContainText(d.step);
  expect((await projectOf(admin, d.id)).deal.stageReason).toBeNull();
  await dialog.getByRole("button", { name: "Cancel" }).click();

  const reason = "ZZ-TEST pause";
  await stage.getByRole("button", { name: "On hold", exact: true }).click();
  dialog = admin.page.getByRole("dialog", { name: "Move to On hold" });
  await expect(dialog.getByRole("button", { name: "Move deal" })).toBeDisabled();
  await dialog.getByLabel("Reason (required)").fill(reason);
  await dialog.getByRole("button", { name: "Move deal" }).click();
  await expect(stage.getByRole("button", { name: "On hold", exact: true })).toHaveAttribute("aria-current", "step");
  await expect(admin.page.getByText(`Reason: ${reason}`)).toBeVisible();
  expect((await projectOf(admin, d.id)).deal.stageReason).toBe(reason);
  expect((await admin.api.post(`/api/projects/${d.id}/stage`, { stageId: hold.id })).status, "already there, so the reason stands").toBe(200);
  expect((await projectOf(admin, d.id)).deal.stageReason).toBe(reason);

  await admin.page.goto(`/projects/${d.id}/activity`);
  await expect(admin.page.getByText(`moved the deal from Lead to On hold (${reason})`)).toBeVisible();
});

// qa:TC missing
test("AC3: a stage that lists empty required fields refuses the move until they are sent qa:TC missing", async ({ admin, later }) => {
  test.setTimeout(120_000);
  const pipes = await crmPipes(admin, CRM_OFF);
  const stage = pipes.flatMap((p) => p.stages).find((s) => s.requiredFields.length > 0);
  // APL-2709 defect (Linear APL-2709): no seeded stage lists requiredFields, so a move is never asked for them.
  if (!stage) throw new Error("APL-2709 APL-2529 defect: no stage lists requiredFields, so no move is ever refused for missing fields.");
  const pipe = pipes.find((p) => p.stages.some((s) => s.id === stage.id))!;
  const org = await admin.api.post("/api/orgs", { name: zz("org 2529 fields") });
  expect(org.status, JSON.stringify(org.json)).toBe(201);
  const orgId = org.json.organisation.id as string;
  later(() => admin.api.post(`/api/orgs/${orgId}/archive`, { archive: true }));
  const body: Record<string, unknown> = {
    name: zz("deal 2529 fields"), organisationId: orgId, pipelineId: pipe.id, leaderId: admin.user.id, whyPursue: "ZZ-TEST fit",
    nextStep: { title: zz("fields step"), dueDate: ymd(6) },
  };
  if (pipe.key === "DEAL_BID") body.submissionDeadline = ymd(14);
  const d = await admin.api.post("/api/deals", body);
  expect(d.status, JSON.stringify(d.json)).toBe(201);
  const id = d.json.deal.id as string;
  later(() => admin.api.post(`/api/projects/${id}/archive`));

  if (stage.category === "DONE" || stage.category === "LOST") {
    const step = (await projectOf(admin, id)).deal.nextStep!.id;
    expect((await admin.api.post(`/api/tasks/${step}/complete`, await withTaskVersion(admin.api, step))).status).toBe(200);
  }
  const details = (await projectOf(admin, id)).deal.details ?? {};
  const missing = stage.requiredFields.filter((k) => empty(details[k]));
  expect(missing.length, "a new deal still has an empty required field, so the move can be refused").toBeGreaterThan(0);
  const reason = stage.needsReason ? { reason: "ZZ-TEST fields" } : {};
  const refused = await admin.api.post(`/api/projects/${id}/stage`, { stageId: stage.id, ...reason });
  expect(refused.status).toBe(409);
  expect(refused.json.needsFields).toEqual(expect.arrayContaining(missing));

  await admin.page.goto(`/projects/${id}`);
  const current = (await projectOf(admin, id)).deal.stage.name;
  if (current !== stage.name) {
    await admin.page.getByRole("group", { name: "Stage" }).getByRole("button", { name: stage.name, exact: true }).click();
    const dialog = admin.page.getByRole("dialog", { name: `Move to ${stage.name}` });
    await expect(dialog.getByLabel(`${FIELD_LABEL[missing[0]] ?? missing[0]} (required)`)).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
  }
  const sent = await admin.api.post(`/api/projects/${id}/stage`, { stageId: stage.id, ...reason, fields: fieldValues(missing) });
  expect(sent.status, JSON.stringify(sent.json)).toBe(200);
  expect((await projectOf(admin, id)).deal.stage.name).toBe(stage.name);
});

// qa:TC missing
test("AC4: a Viewer and an archived deal cannot change stage qa:TC missing", async ({ admin, member, later }) => {
  test.setTimeout(120_000);
  await crmPipes(member, CRM_MEMBER);
  const d = await makeDeal(admin, later, { label: "2529 locked" });
  expect((await admin.api.post(`/api/projects/${d.id}/members`, { userId: member.user.id, role: "VIEWER" })).status).toBe(201);
  const conversation = d.pro.stages.find((s) => s.name === "Conversation")!;

  await member.page.goto(`/projects/${d.id}`);
  const buttons = member.page.getByRole("group", { name: "Stage" }).getByRole("button");
  await expect(buttons).toHaveCount(d.pro.stages.length);
  for (const button of await buttons.all()) await expect(button).toBeDisabled();
  const viewer = await member.api.post(`/api/projects/${d.id}/stage`, { stageId: conversation.id });
  expect(viewer.status).toBe(403);
  expect(viewer.json.error).toBe("Viewers cannot make changes.");
  expect((await projectOf(admin, d.id)).deal.stage.name).toBe("Lead");

  expect((await admin.api.post(`/api/projects/${d.id}/archive`)).status).toBeLessThan(300);
  await admin.page.goto(`/projects/${d.id}`);
  await expect(admin.page.getByText("This project is archived and read-only.")).toBeVisible();
  const archivedButtons = admin.page.getByRole("group", { name: "Stage" }).getByRole("button");
  await expect(archivedButtons).toHaveCount(d.pro.stages.length);
  for (const button of await archivedButtons.all()) await expect(button).toBeDisabled();
  const archived = await admin.api.post(`/api/projects/${d.id}/stage`, { stageId: conversation.id });
  expect(archived.status).toBe(409);
  expect(archived.json.error).toBe("This project is archived and read-only.");
  const viewerAgain = await member.api.post(`/api/projects/${d.id}/stage`, { stageId: conversation.id });
  expect(viewerAgain.status).toBe(409);
  expect((await projectOf(admin, d.id)).deal.stage.name).toBe("Lead");
});

// qa:TC missing
test("AC5: a plain project shows no stepper and the server answers that only deals have stages qa:TC missing", async ({ admin, later }) => {
  const pipes = await crmPipes(admin, CRM_OFF);
  const plain = await newProject(admin, later, { label: "2529 plain" });
  await admin.page.goto(`/projects/${plain.id}`);
  await expect(admin.page.getByRole("group", { name: "Stage" })).toHaveCount(0);
  await expect(admin.page.getByRole("region", { name: "To do" })).toBeVisible();
  await expect(admin.page.getByRole("region", { name: "In progress" })).toBeVisible();
  await expect(admin.page.getByRole("region", { name: "Done" })).toBeVisible();
  const conversation = pipes.find((p) => p.key === "DEAL_PROACTIVE")!.stages.find((s) => s.name === "Conversation")!;
  const refused = await admin.api.post(`/api/projects/${plain.id}/stage`, { stageId: conversation.id });
  expect(refused.status).toBe(400);
  expect(refused.json.error).toBe("Only deals have stages.");
  const row = await projectOf(admin, plain.id);
  expect(row.type).toBe("PROJECT");
  expect(row.deal).toBeNull();
});

// qa:TC missing
test("AC6: Won and Lost are refused while a task is open, the dialog lists the first 20, and nothing is closed or archived qa:TC missing", async ({ admin, later }) => {
  test.setTimeout(180_000);
  const wonDeal = await makeDeal(admin, later, { label: "2529 won", step: zz("won step") });
  const extraTitles = Array.from({ length: 20 }, (_, i) => zz(`open ${i}`));
  const extraIds: string[] = [];
  for (const title of extraTitles) extraIds.push(await newTask(admin, wonDeal.id, { title }));
  const step = (await projectOf(admin, wonDeal.id)).deal.nextStep!;
  const named = [step.title, ...extraTitles];
  const made = [{ id: step.id, title: step.title }, ...extraIds.map((id, i) => ({ id, title: extraTitles[i] }))];

  const won = wonDeal.pro.stages.find((s) => s.name === "Won")!;
  const blocked = await admin.api.post(`/api/projects/${wonDeal.id}/stage`, { stageId: won.id });
  expect(blocked.status).toBe(409);
  expect(blocked.json.openTasks).toBe(21);
  expect(blocked.json.error).toContain("21 tasks are still open");
  const returned = (blocked.json.tasks as { title: string }[]).map((t) => t.title);
  expect(returned).toHaveLength(20);
  expect(named.filter((t) => !returned.includes(t))).toHaveLength(1);
  expect((await projectOf(admin, wonDeal.id)).archived).toBe(false);
  expect((await getTask(admin, made[0].id)).completedAt).toBeNull();

  await admin.page.goto(`/projects/${wonDeal.id}`);
  await admin.page.getByRole("group", { name: "Stage" }).getByRole("button", { name: "Won", exact: true }).click();
  let dialog = admin.page.getByRole("dialog", { name: "Move to Won" });
  await dialog.getByRole("button", { name: "Move deal" }).click();
  await expect(dialog.getByRole("alert")).toContainText("21");
  const shown = (await dialog.getByRole("link").allTextContents()).map((t) => t.trim());
  expect(shown).toHaveLength(20);
  expect(named.filter((t) => !shown.includes(t))).toHaveLength(1);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect((await projectOf(admin, wonDeal.id)).deal.stage.name).toBe("Lead");

  for (const task of made) expect((await admin.api.post(`/api/tasks/${task.id}/complete`, await withTaskVersion(admin.api, task.id))).status, task.title).toBe(200);
  const stamps = [];
  for (const task of made) stamps.push((await getTask(admin, task.id)).completedAt as string);
  expect(stamps.every(Boolean)).toBe(true);
  await admin.page.getByRole("group", { name: "Stage" }).getByRole("button", { name: "Won", exact: true }).click();
  dialog = admin.page.getByRole("dialog", { name: "Move to Won" });
  await dialog.getByRole("button", { name: "Move deal" }).click();
  await expect(admin.page.getByRole("group", { name: "Stage" }).getByRole("button", { name: "Won", exact: true })).toHaveAttribute("aria-current", "step");
  const wonAfter = await projectOf(admin, wonDeal.id);
  expect(wonAfter.deal.stage.name).toBe("Won");
  expect(wonAfter.archived, "winning does not archive the deal").toBe(false);
  for (let i = 0; i < made.length; i++) expect((await getTask(admin, made[i].id)).completedAt).toBe(stamps[i]);

  const lostDeal = await makeDeal(admin, later, { label: "2529 lost", step: zz("lost step") });
  const lost = lostDeal.pro.stages.find((s) => s.name === "Lost")!;
  const lostBlock = await admin.api.post(`/api/projects/${lostDeal.id}/stage`, { stageId: lost.id, reason: "ZZ-TEST lost" });
  expect(lostBlock.status).toBe(409);
  expect(lostBlock.json.openTasks).toBe(1);
  expect(lostBlock.json.error).toContain("1 task is still open");
  await admin.page.goto(`/projects/${lostDeal.id}`);
  await admin.page.getByRole("group", { name: "Stage" }).getByRole("button", { name: "Lost", exact: true }).click();
  dialog = admin.page.getByRole("dialog", { name: "Move to Lost" });
  await dialog.getByLabel("Reason (required)").fill("ZZ-TEST lost");
  await dialog.getByRole("button", { name: "Move deal" }).click();
  await expect(dialog.getByRole("alert")).toContainText(lostDeal.step);
  await expect(dialog.getByRole("link", { name: lostDeal.step })).toBeVisible();
  expect((await projectOf(admin, lostDeal.id)).archived).toBe(false);
  await dialog.getByRole("button", { name: "Cancel" }).click();

  const lostStep = (await projectOf(admin, lostDeal.id)).deal.nextStep!.id;
  expect((await admin.api.post(`/api/tasks/${lostStep}/complete`, await withTaskVersion(admin.api, lostStep))).status).toBe(200);
  const lostStamp = (await getTask(admin, lostStep)).completedAt;
  await admin.page.getByRole("group", { name: "Stage" }).getByRole("button", { name: "Lost", exact: true }).click();
  dialog = admin.page.getByRole("dialog", { name: "Move to Lost" });
  await dialog.getByLabel("Reason (required)").fill("ZZ-TEST lost");
  await dialog.getByRole("button", { name: "Move deal" }).click();
  await expect(admin.page.getByRole("group", { name: "Stage" }).getByRole("button", { name: "Lost", exact: true })).toHaveAttribute("aria-current", "step");
  const lostAfter = await projectOf(admin, lostDeal.id);
  expect(lostAfter.deal.stage.name).toBe("Lost");
  expect(lostAfter.archived).toBe(false);
  expect((await getTask(admin, lostStep)).completedAt).toBe(lostStamp);
});

// qa:TC missing
test("AC7: a stage change does not set completedAt and does not touch a Section qa:TC missing", async ({ admin, later }) => {
  test.setTimeout(120_000);
  const d = await makeDeal(admin, later, { label: "2529 sections", step: zz("stays open") });
  const step = (await projectOf(admin, d.id)).deal.nextStep!;
  const doneId = await newTask(admin, d.id, { title: zz("already done") });
  expect((await admin.api.post(`/api/tasks/${doneId}/complete`, await withTaskVersion(admin.api, doneId))).status).toBe(200);
  const openBefore = await getTask(admin, step.id);
  const doneBefore = await getTask(admin, doneId);
  const sections = (await projectOf(admin, d.id)).sections;
  expect(openBefore.completedAt).toBeNull();
  expect(doneBefore.completedAt).toBeTruthy();

  await admin.page.goto(`/projects/${d.id}`);
  await admin.page.getByRole("group", { name: "Stage" }).getByRole("button", { name: "Conversation", exact: true }).click();
  await admin.page.getByRole("dialog", { name: "Move to Conversation" }).getByRole("button", { name: "Move deal" }).click();
  await expect(admin.page.getByRole("group", { name: "Stage" }).getByRole("button", { name: "Conversation", exact: true })).toHaveAttribute("aria-current", "step");

  const openAfter = await getTask(admin, step.id);
  const doneAfter = await getTask(admin, doneId);
  expect(openAfter.completedAt).toBeNull();
  expect(openAfter.sectionId).toBe(openBefore.sectionId);
  expect(doneAfter.completedAt).toBe(doneBefore.completedAt);
  expect(doneAfter.sectionId).toBe(doneBefore.sectionId);
  expect((await projectOf(admin, d.id)).sections).toEqual(sections);
});
