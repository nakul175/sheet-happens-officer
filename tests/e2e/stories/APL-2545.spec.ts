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
  return { projectId: p.id, id, title, project: p.name };
}

test("AC1: an Editor turns Idea on and the chip shows in the project list, the board, Home and Search", async ({ admin, later }) => {
  test.setTimeout(180_000);
  const t = await ideaProject(admin, later, "idea chip");
  await admin.page.goto(`/projects/${t.projectId}?task=${t.id}`);
  // The row's "Select \"…idea…\"" checkbox also matches a loose "Idea" name. The flag lives on the task panel.
  // Controlled checkbox: checked follows task.isIdea, which updates only after POST /api/tasks/:id/idea and a reload.
  // locator.check() requires the DOM to flip during that click, so click and wait for the checked state instead.
  const idea = admin.page.getByRole("dialog", { name: "Task" }).getByRole("checkbox", { name: "Idea", exact: true });
  await idea.click();
  await expect(idea).toBeChecked();
  await expect.poll(async () => (await getTask(admin, t.id)).isIdea).toBe(true);
  await admin.page.keyboard.press("Escape");
  await expect(admin.page.locator(".item", { hasText: t.title }).locator(".chip", { hasText: "Idea" })).toBeVisible();
  await admin.page.getByRole("tab", { name: "Board" }).click();
  await expect(admin.page.locator(".bcard", { hasText: t.title }).locator(".chip", { hasText: "Idea" })).toBeVisible();

  await admin.page.goto("/");
  await expect(admin.page.locator(".item", { hasText: t.title }).locator(".chip", { hasText: "Idea" })).toBeVisible();

  await admin.page.goto("/search");
  await admin.page.getByLabel("Search").fill(t.title);
  // The project and the task share this name, so both results show it. The project result's whole name is that text.
  const project = admin.page.getByRole("link", { name: t.project, exact: true });
  await expect(project).toHaveAttribute("href", `/projects/${t.projectId}`);
  await expect(project.getByText("Idea", { exact: true })).toHaveCount(0);
  // Scope by result type before the title: only a task result carries the "<project> · <assignee>" line, so the project
  // result is never a candidate even though its whole name is the title (SHO-2924: the old .item filter matched both).
  const task = admin.page
    .getByRole("link")
    .filter({ hasText: `${t.project} · ${admin.user.name}` })
    .filter({ has: admin.page.getByText(t.title, { exact: true }) });
  await expect(task).toHaveAttribute("href", `/projects/${t.projectId}?task=${t.id}`);
  await expect(task.getByText("Idea", { exact: true })).toBeVisible();
});

// SHO-2924: the AC1 locators must each select exactly one Search result. This replays the two rows the Search screen
// renders for a project and a task that carry the same name (src/app/(app)/SearchView.tsx:54-78: a project result is
// <a class="item"><div class="t"><b>name</b></div>, a task result adds <small>project · assignee</small> and the Idea
// chip), so the ambiguity behind the ticket is exercised without a server: the ticket's .item filter matches both rows,
// which is the strict-mode violation the AC rules out.
test("AC1 (SHO-2924): the Search locators select one result each when the project and the task share a name", async ({ anon }) => {
  const name = zz("idea chip shared name");
  const assignee = "W24 Admin";
  // The rows SearchView.tsx renders for that name, in the order the API returns them: Projects, then Tasks.
  await anon.setContent(`<main><div class="grp">Projects</div><div class="list">
    <a class="item" href="/projects/p1"><div class="t"><b>${name}</b></div></a>
  </div><div class="grp">Tasks</div><div class="list">
    <a class="item" href="/projects/p1?task=t1"><div class="t"><b>${name}</b><small>${name} · ${assignee}</small></div><span class="chip gold">Idea</span></a>
  </div></main>`);

  // The precondition of the bug: filtering by the shared name alone is two rows, not one (the old `.item` locator).
  await expect(anon.locator(".item", { hasText: name }), "the name alone matches the project and the task").toHaveCount(2);

  // The project result: the link whose whole name is that text. One row, no Idea chip.
  const project = anon.getByRole("link", { name, exact: true });
  await expect(project, "the project result is not ambiguous").toHaveCount(1);
  await expect(project).toHaveAttribute("href", "/projects/p1");
  await expect(project.getByText("Idea", { exact: true })).toHaveCount(0);

  // The task result, the same chain AC1 uses: role first, then the type line, then the exact title. One row, Idea chip.
  const task = anon
    .getByRole("link")
    .filter({ hasText: `${name} · ${assignee}` })
    .filter({ has: anon.getByText(name, { exact: true }) });
  await expect(task, "the task result is not ambiguous").toHaveCount(1);
  await expect(task).toHaveAttribute("href", "/projects/p1?task=t1");
  await expect(task.getByText("Idea", { exact: true })).toBeVisible();
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
  const idea = await newTask(admin, p.id, { dueDate: "2031-03-20", title: ideaTitle, assigneeId: admin.user.id });
  await newTask(admin, p.id, { dueDate: "2031-03-20", title: plainTitle, assigneeId: admin.user.id });
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
