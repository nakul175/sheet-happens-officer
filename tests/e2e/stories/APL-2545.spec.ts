// SHO-US-13.2 Flag a task as an idea (APL-2545).
// One test per acceptance criterion. ZZ-TEST projects, tasks, organisations and the converted deal are archived afterwards.
// The plain Member is the Viewer for AC4. The undo label is the public mark of the task.idea_changed row.
import { test, expect, zz } from "../support";
import { getTask, newProject, newTask, ymd, type Who } from "../g2";

type Later = (fn: () => Promise<unknown>) => void;

async function ideaProject(admin: Who, later: Later, label: string) {
  const p = await newProject(admin, later, { label });
  const title = zz(label);
  const id = await newTask(admin, p.id, { title, dueDate: ymd(3), assigneeId: admin.user.id });
  return { projectId: p.id, id, title };
}

test("AC1: an Editor turns Idea on and the chip shows in the project list, the board, Home and Search", async ({ admin, later }) => {
  test.setTimeout(180_000);
  const t = await ideaProject(admin, later, "idea chip");
  await admin.page.goto(`/projects/${t.projectId}?task=${t.id}`);
  // The row's "Select \"…idea…\"" checkbox also matches a loose "Idea" name. The flag lives on the task panel.
  await admin.page.getByRole("dialog", { name: "Task" }).getByRole("checkbox", { name: "Idea", exact: true }).check();
  await expect.poll(async () => (await getTask(admin, t.id)).isIdea).toBe(true);
  await admin.page.keyboard.press("Escape");
  await expect(admin.page.locator(".item", { hasText: t.title }).locator(".chip", { hasText: "Idea" })).toBeVisible();
  await admin.page.getByRole("tab", { name: "Board" }).click();
  await expect(admin.page.locator(".bcard", { hasText: t.title }).locator(".chip", { hasText: "Idea" })).toBeVisible();

  await admin.page.goto("/");
  await expect(admin.page.locator(".item", { hasText: t.title }).locator(".chip", { hasText: "Idea" })).toBeVisible();

  await admin.page.goto("/search");
  await admin.page.getByLabel("Search").fill(t.title);
  const row = admin.page.locator(".item", { hasText: t.title });
  await expect(row).toBeVisible();
  await expect(row.locator(".chip", { hasText: "Idea" })).toBeVisible();
});

test("AC2: converting the task to a deal clears the Idea flag", async ({ admin, later }) => {
  test.setTimeout(120_000);
  const t = await ideaProject(admin, later, "idea convert");
  expect((await admin.api.post(`/api/tasks/${t.id}/idea`, { isIdea: true })).status).toBe(200);
  const org = await admin.api.post("/api/orgs", { name: zz("org convert") });
  expect(org.status).toBe(201);
  const orgId = org.json.organisation.id as string;
  later(() => admin.api.post(`/api/orgs/${orgId}/archive`, { archive: true }));
  const pro = ((await admin.api.get("/api/deals/pipelines")).json.pipelines as { id: string; key: string }[]).find((p) => p.key === "DEAL_PROACTIVE")!;
  const converted = await admin.api.post(`/api/tasks/${t.id}/convert`, {
    organisationId: orgId, pipelineId: pro.id, whyPursue: "ZZ-TEST fit", leaderId: admin.user.id,
  });
  expect(converted.status, JSON.stringify(converted.json)).toBe(201);
  const dealId = converted.json.deal.id as string;
  later(() => admin.api.post(`/api/projects/${dealId}/archive`));
  expect((await getTask(admin, t.id)).isIdea).toBe(false);
  await admin.page.goto(`/projects/${dealId}`);
  await expect(admin.page.locator(".item", { hasText: t.title })).toBeVisible();
  await expect(admin.page.locator(".item", { hasText: t.title }).locator(".chip", { hasText: "Idea" })).toHaveCount(0);
});

test("AC3: Search can be filtered to ideas only", async ({ admin, later }) => {
  test.setTimeout(120_000);
  const p = await newProject(admin, later, { label: "idea search" });
  const token = `ZZ-TEST-IDEA${Date.now().toString(36)}`;
  const ideaTitle = `${token} ${zz("idea")}`;
  const plainTitle = `${token} ${zz("plain")}`;
  const idea = await newTask(admin, p.id, { title: ideaTitle, assigneeId: admin.user.id });
  await newTask(admin, p.id, { title: plainTitle, assigneeId: admin.user.id });
  expect((await admin.api.post(`/api/tasks/${idea}/idea`, { isIdea: true })).status).toBe(200);

  const only = (await admin.api.get(`/api/search?q=${encodeURIComponent(token)}&idea=true`)).json.tasks as { title: string; isIdea: boolean }[];
  expect(only.map((t) => t.title)).toEqual([ideaTitle]);
  expect(only[0].isIdea).toBe(true);

  await admin.page.goto("/search");
  await admin.page.getByLabel("Search").fill(token);
  await expect(admin.page.getByText(ideaTitle)).toBeVisible();
  await expect(admin.page.getByText(plainTitle)).toBeVisible();
  await admin.page.getByRole("checkbox", { name: "Ideas only" }).check();
  await expect(admin.page.getByText(plainTitle)).toHaveCount(0);
  await expect(admin.page.getByText(ideaTitle)).toBeVisible();
  await expect(admin.page.locator(".item", { hasText: ideaTitle }).locator(".chip", { hasText: "Idea" })).toBeVisible();
});

test("AC4: a Viewer cannot change the Idea flag, and the server refuses", async ({ admin, member, later }) => {
  test.setTimeout(120_000);
  const t = await ideaProject(admin, later, "idea viewer");
  expect((await admin.api.post(`/api/tasks/${t.id}/idea`, { isIdea: true })).status).toBe(200);
  expect((await admin.api.post(`/api/projects/${t.projectId}/members`, { userId: member.user.id, role: "VIEWER" })).status).toBe(201);
  const refused = await member.api.post(`/api/tasks/${t.id}/idea`, { isIdea: false });
  expect(refused.status).toBe(403);
  expect((await getTask(admin, t.id)).isIdea).toBe(true);

  await member.page.goto(`/projects/${t.projectId}?task=${t.id}`);
  await expect(member.page.getByRole("dialog")).toBeVisible();
  await expect(member.page.getByRole("checkbox", { name: "Idea" })).toHaveCount(0);
  await expect(member.page.getByRole("button", { name: "Convert to deal" })).toHaveCount(0);
});

test("AC5: the change is logged with before and after, labelled Idea flag changed, and it can be undone", async ({ admin, later }) => {
  const t = await ideaProject(admin, later, "idea undo");
  expect((await getTask(admin, t.id)).isIdea).toBe(false);
  const res = await admin.page.request.post(`/api/tasks/${t.id}/idea`, { data: { isIdea: true } });
  expect(res.status()).toBe(200);
  expect(res.headers()["x-undo-label"]).toBe("Idea flag changed");
  const undo = res.headers()["x-undo-id"];
  expect(undo, "the row is undoable").toBeTruthy();
  expect((await getTask(admin, t.id)).isIdea).toBe(true);

  const activity = (await admin.api.get(`/api/projects/${t.projectId}/activity`)).json.items as { what: string }[];
  expect(activity.some((i) => i.what === `marked "${t.title}" as an idea`)).toBe(true);

  expect((await admin.api.post(`/api/actions/${undo}/undo`, { anyway: false })).status).toBe(200);
  // Undo restores the previous flag. It logs an "undo" row; the "took the idea mark off" sentence is only written by a later unflag.
  expect((await getTask(admin, t.id)).isIdea, "undo puts the flag back to its previous value").toBe(false);
});
