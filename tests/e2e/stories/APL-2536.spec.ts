// SHO-US-11.5 Organisation page and Accounts list (Linear APL-2536).
// One test per acceptance criterion. Sign-in is login("ADMIN") / login("MEMBER") via the fixtures.
// Organisations, deals, contacts, notes and tasks are ZZ-TEST and archived or deleted afterwards.
// The seeded pipelines have no Not started stage; AC4 records that and still checks Active and Paused.
import { test, expect, zz } from "../support";
import { newProject, newTask, ymd } from "../g2";
import { pipelines } from "../helpers/deal-board";
import { createDeal, createOrg, dealBody, noSideways, orgPage, projectOf } from "../helpers/claude-a";

test("APL-2536 > AC1: the organisation page shows open deals, contacts, notes, the highlighted tree and tasks linked here", async ({ admin, later }) => {
  const parent = await createOrg(admin, later, "tree parent");
  const leaf = await createOrg(admin, later, "tree leaf", { parentId: parent.id, kind: "Ministry" });
  const pipes = await pipelines(admin.api);
  const deal = await createDeal(admin, later, dealBody({ name: zz("tree deal"), organisationId: leaf.id, pipelineId: pipes.pro.id, leaderId: admin.user.id }));
  const contact = await admin.api.post(`/api/orgs/${leaf.id}/contacts`, { name: zz("tree contact") });
  expect(contact.status, JSON.stringify(contact.json)).toBe(201);
  const contactId = contact.json.contact.id as string;
  later(() => admin.api.del(`/api/contacts/${contactId}`));
  const noteText = zz("tree note");
  const note = await admin.api.post(`/api/orgs/${leaf.id}/notes`, { kind: "CALL", date: ymd(0), text: noteText, contactIds: [contactId] });
  expect(note.status, JSON.stringify(note.json)).toBe(201);
  later(() => admin.api.del(`/api/notes/${note.json.note.id}`));
  const project = await newProject(admin, later, { label: "tree tasks" });
  const taskTitle = zz("tree task");
  const taskId = await newTask(admin, project.id, { dueDate: "2031-03-20", title: taskTitle });
  expect((await admin.api.post(`/api/tasks/${taskId}/links`, { organisationId: leaf.id })).status).toBe(201);

  const org = await orgPage(admin.api, leaf.id);
  expect(org.deals.map((d: { projectId: string }) => d.projectId)).toContain(deal.id);
  expect(org.contacts.map((c: { id: string }) => c.id)).toContain(contactId);
  expect(org.notes.map((n: { text: string }) => n.text)).toContain(noteText);
  expect(org.tasks.map((t: { id: string }) => t.id)).toContain(taskId);
  expect(org.tree.id).toBe(parent.id);
  expect(JSON.stringify(org.tree)).toContain(leaf.id);

  await admin.page.goto(`/accounts/${leaf.id}`);
  await expect(admin.page.getByRole("heading", { name: leaf.name })).toBeVisible();
  await expect(admin.page.locator("aside").getByRole("link", { name: "Accounts" })).toHaveAttribute("aria-current", "page");
  await expect(admin.page.getByRole("link", { name: deal.name })).toBeVisible();
  await expect(admin.page.getByText(zz("tree contact")).first()).toBeVisible();
  await expect(admin.page.getByText("Known by").first()).toBeVisible();
  await expect(admin.page.getByText("Last spoke").first()).toBeVisible();
  await expect(admin.page.getByText(noteText).first()).toBeVisible();
  await expect(admin.page.getByRole("link", { name: taskTitle })).toBeVisible();
  await expect(admin.page.locator("[aria-current=page]").filter({ hasText: leaf.name })).toBeVisible();
  // The parent is also the breadcrumb link, so an unscoped link role resolves to two nodes (strict-mode violation).
  // The tree is the list item that holds the parent link and the highlighted leaf; scope the parent link to it.
  const tree = admin.page.getByRole("listitem")
    .filter({ has: admin.page.getByRole("link", { name: parent.name, exact: true }) })
    .filter({ hasText: leaf.name });
  await expect(tree.getByRole("link", { name: parent.name, exact: true })).toHaveAttribute("href", `/accounts/${parent.id}`);
  await expect(admin.page.getByText("Organisation tree")).toBeVisible();
});

test("APL-2536 > AC2: deals, notes and linked tasks follow membership, and deals are a plain table", async ({ admin, member, later }) => {
  const org = await createOrg(admin, later, "filtered org");
  const pipes = await pipelines(admin.api);
  const deal = await createDeal(admin, later, dealBody({ name: zz("hidden deal"), organisationId: org.id, pipelineId: pipes.pro.id, leaderId: admin.user.id }));
  const dealNote = zz("deal only note");
  const orgNote = zz("org wide note");
  const n1 = await admin.api.post(`/api/orgs/${org.id}/notes`, { kind: "MEETING", date: ymd(0), text: dealNote, projectId: deal.id });
  const n2 = await admin.api.post(`/api/orgs/${org.id}/notes`, { kind: "OTHER", date: ymd(0), text: orgNote });
  expect(n1.status, JSON.stringify(n1.json)).toBe(201);
  expect(n2.status, JSON.stringify(n2.json)).toBe(201);
  later(() => admin.api.del(`/api/notes/${n1.json.note.id}`));
  later(() => admin.api.del(`/api/notes/${n2.json.note.id}`));
  const project = await newProject(admin, later, { label: "hidden tasks" });
  const taskTitle = zz("hidden linked task");
  const taskId = await newTask(admin, project.id, { dueDate: "2031-03-20", title: taskTitle });
  expect((await admin.api.post(`/api/tasks/${taskId}/links`, { organisationId: org.id })).status).toBe(201);

  const hidden = await orgPage(member.api, org.id);
  expect(hidden.deals.some((d: { projectId: string }) => d.projectId === deal.id)).toBe(false);
  expect(hidden.notes.map((n: { text: string }) => n.text)).toContain(orgNote);
  expect(hidden.notes.map((n: { text: string }) => n.text)).not.toContain(dealNote);
  expect(hidden.tasks.some((t: { id: string }) => t.id === taskId)).toBe(false);
  const all = await orgPage(admin.api, org.id);
  expect(all.deals.some((d: { projectId: string }) => d.projectId === deal.id)).toBe(true);
  expect(all.notes.map((n: { text: string }) => n.text)).toEqual(expect.arrayContaining([dealNote, orgNote]));
  expect(all.tasks.some((t: { id: string }) => t.id === taskId)).toBe(true);

  await member.page.goto(`/accounts/${org.id}`);
  await expect(member.page.getByRole("link", { name: deal.name })).toHaveCount(0);
  await expect(member.page.getByText(dealNote)).toHaveCount(0);
  await expect(member.page.getByText(taskTitle)).toHaveCount(0);

  expect((await admin.api.post(`/api/projects/${deal.id}/members`, { userId: member.user.id, role: "VIEWER" })).status).toBe(201);
  expect((await admin.api.post(`/api/projects/${project.id}/members`, { userId: member.user.id, role: "VIEWER" })).status).toBe(201);
  const shown = await orgPage(member.api, org.id);
  expect(shown.deals.some((d: { projectId: string }) => d.projectId === deal.id)).toBe(true);
  expect(shown.notes.map((n: { text: string }) => n.text)).toContain(dealNote);
  expect(shown.tasks.some((t: { id: string }) => t.id === taskId)).toBe(true);

  await admin.page.goto(`/accounts/${org.id}`);
  await expect(admin.page.locator("table.tbl", { hasText: deal.name })).toBeVisible();
  await expect(admin.page.locator(".dboard")).toHaveCount(0);
  await expect(admin.page.locator(".dcard")).toHaveCount(0);
});

test("APL-2536 > AC3: + Deal opens the new-deal form with the organisation filled in", async ({ admin, later }) => {
  const org = await createOrg(admin, later, "plus deal");
  await admin.page.goto(`/accounts/${org.id}`);
  await admin.page.getByRole("link", { name: "+ Deal" }).click();
  await expect(admin.page).toHaveURL(new RegExp(`/deals/new\\?org=${org.id}$`));
  await expect(admin.page.getByRole("heading", { name: "New deal" })).toBeVisible();
  await expect(admin.page.getByLabel("Organisation (buyer)")).toHaveValue(org.id);
});

test("APL-2536 > AC4: Accounts is searchable by name, filterable by kind, and counts open deals the viewer can see", async ({ admin, later }) => {
  test.setTimeout(180_000);
  const pipes = await pipelines(admin.api);
  const kind = zz("Ministry");
  const otherKind = zz("Company");
  const active = await createOrg(admin, later, "open active", { kind });
  const pausedOrg = await createOrg(admin, later, "open paused", { kind });
  const wonOrg = await createOrg(admin, later, "open won", { kind });
  const funder = await createOrg(admin, later, "open funder", { kind });
  const other = await createOrg(admin, later, "other kind", { kind: otherKind });
  const hold = pipes.pro.stages.find((s) => s.name === "On hold")!;
  const won = pipes.pro.stages.find((s) => s.name === "Won")!;
  const notStarted = [...pipes.pro.stages, ...pipes.bid.stages].find((s) => s.category === "NOT_STARTED");
  if (!notStarted) {
    test.info().annotations.push({ type: "limit", description: "No seeded stage has category NOT_STARTED, so Not started is not exercised. Active (Lead) and Paused (On hold) are." });
  }

  const lead = await createDeal(admin, later, dealBody({ name: zz("counted lead"), organisationId: active.id, pipelineId: pipes.pro.id, leaderId: admin.user.id }));
  const paused = await createDeal(admin, later, dealBody({ name: zz("counted paused"), organisationId: pausedOrg.id, pipelineId: pipes.pro.id, leaderId: admin.user.id, step: zz("pause step") }));
  expect((await admin.api.post(`/api/projects/${paused.id}/stage`, { stageId: hold.id, reason: "ZZ-TEST pause" })).status).toBe(200);
  const closed = await createDeal(admin, later, dealBody({ name: zz("counted won"), organisationId: wonOrg.id, pipelineId: pipes.pro.id, leaderId: admin.user.id, step: zz("won step") }));
  const stepId = (await projectOf(admin, closed.id)).deal.nextStep.id as string;
  // The complete endpoint is versioned: send the step's current updatedAt, as the app does.
  const stepVersion = (await admin.api.get(`/api/tasks/${stepId}`)).json.task.updatedAt as string;
  expect(stepVersion, "the step's current updatedAt").toBeTruthy();
  expect((await admin.api.post(`/api/tasks/${stepId}/complete`, { expectedUpdatedAt: stepVersion })).status).toBe(200);
  expect((await admin.api.post(`/api/projects/${closed.id}/stage`, { stageId: won.id })).status).toBe(200);
  expect((await admin.api.post(`/api/projects/${lead.id}/parties`, { organisationId: funder.id, role: "FUNDER" })).status).toBe(201);

  // zz("open") is "ZZ-TEST open <RUN>", which never contains-matches "ZZ-TEST open active <RUN>".
  // Ask for each organisation by its own name.
  const count = async (org: { id: string; name: string }) => {
    const rows = (await admin.api.get(`/api/orgs?q=${encodeURIComponent(org.name)}`)).json.organisations as { id: string; openDeals: number }[];
    return rows.find((row) => row.id === org.id)?.openDeals;
  };
  expect(await count(active), "a Lead deal counts").toBe(1);
  expect(await count(pausedOrg), "On hold still counts as open").toBe(1);
  expect(await count(wonOrg), "Won is not an open deal").toBe(0);
  expect(await count(funder), "a Funder role counts").toBe(1);

  const found = (await admin.api.get(`/api/orgs?q=${encodeURIComponent(active.name)}`)).json.organisations as { id: string }[];
  expect(found.map((row) => row.id)).toContain(active.id);
  expect(found.map((row) => row.id)).not.toContain(other.id);
  const byKind = (await admin.api.get(`/api/orgs?kind=${encodeURIComponent(kind)}`)).json.organisations as { id: string }[];
  expect(byKind.map((row) => row.id)).toContain(active.id);
  expect(byKind.map((row) => row.id)).not.toContain(other.id);

  await admin.page.goto("/accounts");
  await admin.page.getByLabel("Search organisations").fill(active.name);
  await expect(admin.page.getByRole("link", { name: active.name })).toBeVisible();
  await expect(admin.page.getByRole("link", { name: other.name })).toHaveCount(0);
  await expect(admin.page.locator("tr", { hasText: active.name }).locator("td").nth(4)).toHaveText("1");
  await admin.page.getByLabel("Search organisations").fill("");
  await admin.page.getByLabel("Kind").selectOption(kind);
  await expect(admin.page.getByRole("link", { name: active.name })).toBeVisible();
  await expect(admin.page.getByRole("link", { name: other.name })).toHaveCount(0);
});

test("APL-2536 > AC5: at 390px the organisation page and the Accounts list do not scroll sideways", async ({ admin, later }) => {
  const org = await createOrg(admin, later, "narrow org", { kind: "Ministry" });
  await admin.page.setViewportSize({ width: 390, height: 844 });
  await admin.page.goto(`/accounts/${org.id}`);
  await expect(admin.page.getByRole("heading", { name: org.name })).toBeVisible();
  await noSideways(admin.page);
  await admin.page.goto("/accounts");
  await expect(admin.page.getByRole("heading", { name: "Accounts" })).toBeVisible();
  await admin.page.getByLabel("Search organisations").fill(org.name);
  await expect(admin.page.getByRole("link", { name: org.name })).toBeVisible();
  await noSideways(admin.page);
});

test("APL-2536 > AC5: layout guard allows a bounded scroller and rejects document overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent('<style>body{margin:0}</style><div style="width:300px;overflow-x:auto"><div style="width:600px;height:50px">Wide table</div></div>');
  await noSideways(page);
  await page.setContent('<style>body{margin:0}</style><div style="width:600px;height:50px">Overflowing page</div>');
  await expect(noSideways(page)).rejects.toThrow("the page scrolls sideways");
});
