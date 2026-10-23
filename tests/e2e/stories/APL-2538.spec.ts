// SHO-US-12.2 Convert a task to a deal (Linear APL-2538).
// One test per acceptance criterion. Sign-in is login("ADMIN") / login("MEMBER") via the fixtures.
// Ghost assignees cannot sign in. Projects, deals and organisations are ZZ-TEST and archived afterwards.
import { test, expect, zz } from "../support";
import { getTask, ghost, newProject, newTask, ymd, type Who } from "../g2";
import { pipelines } from "../helpers/deal-board";
import { raw } from "../helpers/jim-http";
import { activity, audit, createOrg, projectOf, type Later } from "../helpers/claude-a";

async function gate(admin: Who, orgId: string, pipelineId: string, extra: Record<string, unknown> = {}) {
  return { organisationId: orgId, pipelineId, whyPursue: "ZZ-TEST why", leaderId: admin.user.id, ...extra };
}

test("APL-2538 > AC1: convert moves the task and its subtasks into a first-stage deal and records the move", async ({ admin, member, later }) => {
  test.setTimeout(120_000);
  const p = await newProject(admin, later, { label: "convert source", members: [{ who: member, role: "EDITOR" }] });
  const asg = await ghost(admin, later, "asg");
  const col = await ghost(admin, later, "col");
  expect((await admin.api.post(`/api/projects/${p.id}/members`, { userId: asg.id, role: "EDITOR" })).status).toBe(201);
  expect((await admin.api.post(`/api/projects/${p.id}/members`, { userId: col.id, role: "VIEWER" })).status).toBe(201);
  const title = zz("idea task");
  const detail = zz("idea detail");
  const due = ymd(6);
  const taskId = await newTask(member, p.id, { title, description: detail, dueDate: due, assigneeId: asg.id, collaboratorIds: [col.id], sectionId: p.doing });
  const subTitle = zz("idea sub");
  const sub = await newTask(member, p.id, { title: subTitle, parentId: taskId });
  expect((await member.api.post(`/api/tasks/${taskId}/idea`, { isIdea: true })).status).toBe(200);
  const org = await createOrg(admin, later, "convert buyer");
  const pipes = await pipelines(admin.api);
  const dealName = zz("converted deal");
  const r = await member.api.post(`/api/tasks/${taskId}/convert`, await gate(admin, org.id, pipes.pro.id, { name: dealName, leaderId: admin.user.id }));
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const dealId = r.json.deal.id as string;
  later(() => admin.api.post(`/api/projects/${dealId}/archive`));

  const moved = await getTask(admin, taskId);
  expect(moved.project.id).toBe(dealId);
  expect(moved.description).toBe(detail);
  expect(moved.assignee.id).toBe(asg.id);
  expect(moved.dueDate).toBe(due);
  expect(moved.collaborators.map((c: { id: string }) => c.id)).toContain(col.id);
  expect(moved.subtaskList.map((s: { id: string }) => s.id)).toEqual([sub]);
  expect((await getTask(admin, sub)).projectId).toBe(dealId);
  const deal = await projectOf(admin, dealId);
  const role = (id: string) => (deal.members as { userId: string; role: string }[]).find((m) => m.userId === id)?.role;
  expect(deal.deal.stage.name).toBe(pipes.pro.stages[0].name);
  expect(deal.deal.nextStep.id).toBe(taskId);
  expect(role(admin.user.id)).toBe("LEADER");
  expect(role(member.user.id), "the person converting").toBe("EDITOR");
  expect(role(asg.id), "the idea's assignee").toBe("EDITOR");
  expect(role(col.id), "a collaborator").toBe("VIEWER");
  const source = await activity(admin, p.id);
  expect(source.some((row) => row.what === `moved "${title}" to the deal "${dealName}"`)).toBe(true);
  const listed = JSON.stringify((await admin.api.get(`/api/projects/${p.id}/tasks`)).json);
  expect(listed.includes(taskId)).toBe(false);
});

test("APL-2538 > AC2: missing gate fields block the dialog and the server returns 400 with the list", async ({ admin, later }) => {
  test.setTimeout(120_000);
  const p = await newProject(admin, later, { label: "convert gate" });
  const undated = await newTask(admin, p.id, { title: zz("no date yet") });
  const dated = await newTask(admin, p.id, { title: zz("has a date"), dueDate: ymd(3) });
  const miss = async (id: string, body: Record<string, unknown>) => {
    const r = await admin.api.post(`/api/tasks/${id}/convert`, body);
    expect(r.status, JSON.stringify(r.json)).toBe(400);
    return r.json.needsFields as string[];
  };
  expect(await miss(undated, {})).toEqual(expect.arrayContaining(["organisation", "pipeline", "whyPursue", "dueDate"]));
  expect(await miss(dated, {})).toEqual(expect.arrayContaining(["organisation", "pipeline", "whyPursue"]));
  const org = await createOrg(admin, later, "gate buyer");
  const pipes = await pipelines(admin.api);
  const filled = await gate(admin, org.id, pipes.pro.id);
  expect(await miss(dated, { ...filled, whyPursue: "" })).toContain("whyPursue");
  expect(await miss(dated, { ...filled, pipelineId: pipes.bid.id })).toContain("submissionDeadline");

  await admin.page.goto(`/projects/${p.id}?task=${dated}`);
  await admin.page.getByRole("dialog", { name: "Task" }).getByRole("button", { name: "Convert to deal" }).click();
  const dialog = admin.page.getByRole("dialog", { name: "Convert to deal" });
  await expect(dialog.getByLabel("Pipeline").locator("option").first()).toBeAttached();
  await expect(dialog.getByRole("button", { name: "Convert to deal" })).toBeDisabled();

  const made = await admin.api.post(`/api/tasks/${undated}/convert`, { ...filled, dueDate: ymd(4) });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  later(() => admin.api.post(`/api/projects/${made.json.deal.id}/archive`));
  expect((await getTask(admin, undated)).dueDate).toBe(ymd(4));
});

test("APL-2538 > AC3: Not listed? New organisation creates the organisation inline", async ({ admin, later }) => {
  test.setTimeout(120_000);
  const p = await newProject(admin, later, { label: "convert inline" });
  const title = zz("inline idea");
  const taskId = await newTask(admin, p.id, { title, dueDate: ymd(5) });
  const orgName = zz("inline org");
  const dealName = zz("inline deal");
  later(async () => {
    const rows = (await admin.api.get(`/api/orgs?q=${encodeURIComponent(orgName)}`)).json.organisations as { id: string; name: string }[] | undefined;
    const id = rows?.find((row) => row.name === orgName)?.id;
    if (id) await admin.api.post(`/api/orgs/${id}/archive`, { archive: true });
    const deals = (await admin.api.get("/api/deals")).json.deals as { id: string; name: string }[] | undefined;
    const dealId = deals?.find((row) => row.name === dealName)?.id;
    if (dealId) await admin.api.post(`/api/projects/${dealId}/archive`);
  });

  await admin.page.goto(`/projects/${p.id}?task=${taskId}`);
  await admin.page.getByRole("dialog", { name: "Task" }).getByRole("button", { name: "Convert to deal" }).click();
  const dialog = admin.page.getByRole("dialog", { name: "Convert to deal" });
  await dialog.getByLabel("Not listed? New organisation").fill(orgName);
  await dialog.getByLabel("Kind").fill("Ministry");
  await dialog.getByRole("button", { name: "Add" }).click();
  await expect.poll(async () => {
    const rows = (await admin.api.get(`/api/orgs?q=${encodeURIComponent(orgName)}`)).json.organisations as { id: string; name: string }[];
    return rows.find((row) => row.name === orgName)?.id ?? "";
  }).not.toBe("");
  const orgId = (await admin.api.get(`/api/orgs?q=${encodeURIComponent(orgName)}`)).json.organisations.find((row: { name: string }) => row.name === orgName).id as string;
  await expect(dialog.getByLabel("Organisation (buyer)")).toHaveValue(orgId);
  await dialog.getByLabel("Deal name").fill(dealName);
  await dialog.getByLabel("Why are we pursuing this?").fill("ZZ-TEST inline");
  // The task is open at /projects/<source>?task=<task>, which already matches /projects/. Wait for /projects/<newId> with newId not the source.
  const dealPath = /^\/projects\/([^/]+)$/;
  const landed = admin.page.waitForURL((u) => { const m = dealPath.exec(u.pathname); return !!m && m[1] !== p.id; });
  await dialog.getByRole("button", { name: "Convert to deal" }).click();
  await landed;
  const dealId = dealPath.exec(new URL(admin.page.url()).pathname)![1];
  expect(dealId).not.toBe(p.id);
  // The deal page's title carries the Deals breadcrumb.
  await expect(admin.page.getByRole("heading", { level: 1, name: `Deals / ${dealName}`, exact: true })).toBeVisible();
  await expect(admin.page.getByRole("group", { name: "Stage" })).toBeVisible();
  await expect(admin.page.getByText(/^Buyer:/).getByRole("link", { name: orgName, exact: true })).toHaveAttribute("href", `/accounts/${orgId}`);
  expect((await projectOf(admin, dealId)).deal.organisation.id).toBe(orgId);
});

test("APL-2538 > AC4: Undo of Task converted to a deal returns the tasks and archives the deal", async ({ admin, later }) => {
  const p = await newProject(admin, later, { label: "convert undo" });
  const title = zz("undo convert");
  const taskId = await newTask(admin, p.id, { title, dueDate: ymd(3), sectionId: p.doing });
  const sub = await newTask(admin, p.id, { title: zz("undo child"), parentId: taskId });
  expect((await admin.api.post(`/api/tasks/${taskId}/idea`, { isIdea: true })).status).toBe(200);
  const org = await createOrg(admin, later, "undo buyer");
  const pipes = await pipelines(admin.api);
  const r = await raw(admin, "POST", `/api/tasks/${taskId}/convert`, await gate(admin, org.id, pipes.pro.id));
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  expect(r.headers["x-undo-label"]).toBe("Task converted to a deal");
  const dealId = r.json.deal.id as string;
  later(() => admin.api.post(`/api/projects/${dealId}/archive`));
  const undo = await admin.api.post(`/api/actions/${r.headers["x-undo-id"]}/undo`, {});
  expect(undo.status, JSON.stringify(undo.json)).toBe(200);
  const back = await getTask(admin, taskId);
  expect(back.project.id).toBe(p.id);
  expect(back.section.id).toBe(p.doing);
  expect(back.isIdea).toBe(true);
  expect((await getTask(admin, sub)).projectId).toBe(p.id);
  expect((await projectOf(admin, dealId)).archived).toBe(true);
});

test("APL-2538 > AC5: Convert to deal is hidden and refused for a Viewer, a subtask, Trash, an archived project, a completed task and a task awaiting approval", async ({ admin, member, later }) => {
  test.setTimeout(180_000);
  const p = await newProject(admin, later, { label: "convert refuse", members: [{ who: member, role: "VIEWER" }] });
  const org = await createOrg(admin, later, "refuse buyer");
  const pipes = await pipelines(admin.api);
  const body = await gate(admin, org.id, pipes.pro.id);
  const openTitle = zz("offered");
  const open = await newTask(admin, p.id, { title: openTitle, dueDate: ymd(3) });

  await admin.page.goto(`/projects/${p.id}?task=${open}`);
  await expect(admin.page.getByRole("dialog", { name: "Task" }).getByRole("button", { name: "Convert to deal" })).toBeVisible();
  const viewTitle = zz("viewer task");
  const view = await newTask(admin, p.id, { title: viewTitle, dueDate: ymd(3) });
  await member.page.goto(`/projects/${p.id}?task=${view}`);
  await expect(member.page.getByRole("dialog", { name: "Task" }).getByText(viewTitle)).toBeVisible();
  await expect(member.page.getByRole("button", { name: "Convert to deal" })).toHaveCount(0);
  expect((await member.api.post(`/api/tasks/${view}/convert`, body)).status).toBe(403);

  const parent = await newTask(admin, p.id, { title: zz("parent task"), dueDate: ymd(3) });
  const sub = await newTask(admin, p.id, { title: zz("child task"), parentId: parent, dueDate: ymd(3) });
  await admin.page.goto(`/projects/${p.id}?task=${sub}`);
  await expect(admin.page.getByRole("button", { name: "Convert to deal" })).toHaveCount(0);
  const subRes = await admin.api.post(`/api/tasks/${sub}/convert`, body);
  expect(subRes.status, JSON.stringify(subRes.json)).toBe(400);
  expect(JSON.stringify(subRes.json)).toContain("subtask");

  const done = await newTask(admin, p.id, { title: zz("done task"), dueDate: ymd(3) });
  // The complete endpoint is versioned: send the task's current updatedAt, as the app does.
  const doneVersion = (await admin.api.get(`/api/tasks/${done}`)).json.task.updatedAt as string;
  expect(doneVersion, "the completed task's current updatedAt").toBeTruthy();
  expect((await admin.api.post(`/api/tasks/${done}/complete`, { expectedUpdatedAt: doneVersion })).status).toBe(200);
  await admin.page.goto(`/projects/${p.id}?task=${done}`);
  await expect(admin.page.getByRole("button", { name: "Convert to deal" })).toHaveCount(0);
  expect((await admin.api.post(`/api/tasks/${done}/convert`, body)).status).toBe(409);

  expect((await admin.api.patch(`/api/projects/${p.id}/members/${member.user.id}`, { role: "EDITOR" })).status).toBe(200);
  const heldTitle = zz("awaiting task");
  const held = await newTask(admin, p.id, { title: heldTitle, dueDate: ymd(3), assigneeId: member.user.id });
  // The approver endpoint is versioned too: name the version the screen is showing.
  const heldVersion = (await admin.api.get(`/api/tasks/${held}`)).json.task.updatedAt as string;
  expect(heldVersion, "the held task's current updatedAt").toBeTruthy();
  expect((await admin.api.put(`/api/tasks/${held}/approver`, { approverId: admin.user.id, expectedUpdatedAt: heldVersion })).status).toBe(200);
  expect((await member.api.post(`/api/tasks/${held}/send-for-approval`, {})).status).toBe(200);
  await admin.page.goto(`/projects/${p.id}?task=${held}`);
  await expect(admin.page.getByRole("button", { name: "Convert to deal" })).toHaveCount(0);
  expect((await admin.api.post(`/api/tasks/${held}/convert`, body)).status).toBe(409);

  const trashed = await newTask(admin, p.id, { title: zz("trashed task"), dueDate: ymd(3) });
  expect((await admin.api.del(`/api/tasks/${trashed}`)).status).toBe(204);
  await admin.page.goto(`/projects/${p.id}?task=${trashed}`);
  await expect(admin.page.getByRole("button", { name: "Convert to deal" })).toHaveCount(0);
  expect((await admin.api.post(`/api/tasks/${trashed}/convert`, body)).status).toBe(404);

  const late = await newTask(admin, p.id, { title: zz("archived task"), dueDate: ymd(3) });
  expect((await admin.api.post(`/api/projects/${p.id}/archive`)).status).toBeLessThan(300);
  await admin.page.goto(`/projects/${p.id}?task=${late}`);
  await expect(admin.page.getByRole("button", { name: "Convert to deal" })).toHaveCount(0);
  expect((await admin.api.post(`/api/tasks/${late}/convert`, body)).status).toBe(409);
});

test("APL-2538 > AC6: conversion clears the Idea flag and is written to the action log and the audit log", async ({ admin, later }) => {
  const p = await newProject(admin, later, { label: "convert log" });
  const title = zz("flagged idea");
  const taskId = await newTask(admin, p.id, { title, dueDate: ymd(4) });
  expect((await admin.api.post(`/api/tasks/${taskId}/idea`, { isIdea: true })).status).toBe(200);
  const org = await createOrg(admin, later, "log buyer");
  const pipes = await pipelines(admin.api);
  const r = await admin.api.post(`/api/tasks/${taskId}/convert`, await gate(admin, org.id, pipes.pro.id, { name: zz("logged deal") }));
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const dealId = r.json.deal.id as string;
  later(() => admin.api.post(`/api/projects/${dealId}/archive`));
  expect((await getTask(admin, taskId)).isIdea).toBe(false);
  expect((await activity(admin, p.id)).some((row) => row.what.includes("to the deal") && row.what.includes(title))).toBe(true);
  expect((await activity(admin, dealId)).some((row) => row.what === `converted "${title}" to this deal`)).toBe(true);
  expect((await audit(admin, "DEAL_CONVERTED", admin.user.id)).some((row) => row.target === `Task "${title}"`)).toBe(true);
});
