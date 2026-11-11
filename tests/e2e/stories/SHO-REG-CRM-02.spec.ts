import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { test, local2691 } from "../helpers/2691-admin";
import { newProject, newTask, postTaskCurrent } from "../helpers/migration-2731";
import { account, PW } from "../local-api";
import { archiveProject, expect, signInAs, zz } from "./qa";

test("SHO-REG-CRM-02 keeps contact in its organisation across edit, link removal and Undo", async ({ admin, later, browser }) => {
  if (!local2691) throw new Error("Contact audit requires the guarded local test database.");
  test.setTimeout(180_000);
  const fixture = randomUUID();
  const evidenceDir = "test-results/contact-organisation-browser";
  const owned: string[] = [];
  let dealIdForCleanup: string | null = null;
  let contactIdForCleanup: string | null = null;
  let observerIdForCleanup: string | null = null;
  let memberContactIdForCleanup: string | null = null;
  later(async () => {
    for (const id of owned) {
      const response = await admin.api.get(`/api/orgs/${id}`);
      expect(response.status).toBe(200);
      expect(response.json.organisation.archived).toBe(true);
    }
    expect(dealIdForCleanup).toBeTruthy();
    expect(contactIdForCleanup).toBeTruthy();
    expect(observerIdForCleanup).toBeTruthy();
    expect(memberContactIdForCleanup).toBeTruthy();
    const dealAfter = await admin.api.get(`/api/projects/${dealIdForCleanup}`);
    expect(dealAfter.status).toBe(200);
    expect(dealAfter.json.project.archived).toBe(true);
    expect((await admin.api.get(`/api/contacts/${contactIdForCleanup}`)).status).toBe(404);
    expect((await admin.api.get(`/api/contacts/${memberContactIdForCleanup}`)).status).toBe(404);
    const observerAfter = await admin.api.get(`/api/team/${observerIdForCleanup}`);
    expect(observerAfter.status).toBe(200);
    expect(observerAfter.json.person.status).toBe("DEACTIVATED");
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(`${evidenceDir}/cleanup.json`, JSON.stringify({ fixture, owned, organisationsArchived: true, dealId: dealIdForCleanup, dealArchived: true, contactId: contactIdForCleanup, contactRemoved: true, observerId: observerIdForCleanup, observerDeactivated: true, cleanup: true }, null, 2));
  });
  async function makeOrg(label: string) {
    const created = await admin.api.post("/api/orgs", { name: zz(label) });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const id = created.json.organisation.id as string;
    owned.push(id);
    later(async () => {
      const loaded = await admin.api.get(`/api/orgs/${id}`);
      expect(loaded.status).toBe(200);
      if (!loaded.json.organisation.archived)
        expect((await admin.api.post(`/api/orgs/${id}/archive`, { archive: true })).status).toBe(200);
    });
    return id;
  }

  const orgId = await makeOrg("contact original organisation");
  const sentinelId = await makeOrg("contact foreign sentinel");
  const sentinelBefore = (await admin.api.get(`/api/orgs/${sentinelId}`)).json.organisation;
  const sentinelHash = createHash("sha256").update(JSON.stringify(sentinelBefore)).digest("hex");
  const project = await newProject(admin, later, { label: "contact linked project" });
  const taskId = await newTask(admin, project.id, { title: zz("contact linked task") });
  const pipelines = await admin.api.get("/api/deals/pipelines");
  expect(pipelines.status).toBe(200);
  const pipeline = (pipelines.json.pipelines as { id: string; key: string }[]).find(row => row.key === "DEAL_PROACTIVE");
  expect(pipeline).toBeDefined();
  const deal = await admin.api.post("/api/deals", { name: zz("contact linked deal"), organisationId: orgId, pipelineId: pipeline!.id, leaderId: admin.user.id, whyPursue: "ZZ-TEST contact link", nextStep: { title: zz("deal first step"), dueDate: new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10) } });
  expect(deal.status, JSON.stringify(deal.json)).toBe(201);
  const dealId = deal.json.deal.id as string;
  dealIdForCleanup = dealId;
  later(async () => archiveProject(admin.api, dealId, admin.user.id));
  const dealTaskId = await newTask(admin, dealId, { title: zz("contact linked deal task") });
  const name = zz("contact fixed organisation");
  const page = admin.page;
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(`/accounts/${orgId}?tab=contacts`);
  await page.getByRole("button", { name: "+ Contact" }).click();
  const create = page.getByRole("dialog", { name: "New contact" });
  await create.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await create.getByRole("textbox", { name: "Role" }).fill("Liaison");
  await create.getByRole("button", { name: "Save" }).click();
  await expect(create).toHaveCount(0);
  const list = await admin.api.get(`/api/orgs/${orgId}/contacts`);
  expect(list.status).toBe(200);
  const contact = (list.json.contacts as { id: string; name: string }[]).find((row) => row.name === name);
  expect(contact).toBeDefined();
  const contactId = contact!.id;
  contactIdForCleanup = contactId;
  later(async () => {
    const loaded = await admin.api.get(`/api/contacts/${contactId}`);
    if (loaded.status === 200) expect((await admin.api.del(`/api/contacts/${contactId}`)).status).toBe(204);
    else expect(loaded.status).toBe(404);
  });
  const observer = await account(zz("contact observer"), `nakul17+zz-crm-02-${fixture}@aplyd.com`);
  observerIdForCleanup = observer.id;
  later(async () => {
    expect((await admin.api.post(`/api/team/${observer.id}/deactivate`, { reassign: "leaders" })).status).toBe(200);
  });
  const beforeDenied = await admin.api.get(`/api/contacts/${contactId}`);
  expect(beforeDenied.status).toBe(200);
  const contactHash = createHash("sha256").update(JSON.stringify(beforeDenied.json.contact)).digest("hex");
  const observerList = await observer.c.get(`/api/orgs/${orgId}/contacts`);
  expect(observerList.status).toBe(200);
  expect(observerList.json.contacts).toEqual(expect.arrayContaining([expect.objectContaining({ id: contactId, canEdit: false })]));
  expect((await observer.c.patch(`/api/contacts/${contactId}`, { role: "unauthorised" })).status).toBe(403);
  expect((await observer.c.del(`/api/contacts/${contactId}`)).status).toBe(403);
  const deniedAfter = await admin.api.get(`/api/contacts/${contactId}`);
  expect(createHash("sha256").update(JSON.stringify(deniedAfter.json.contact)).digest("hex")).toBe(contactHash);
  const observerSession = await signInAs(browser, observer.email, PW);
  try {
    await observerSession.page.goto(`/accounts/${orgId}?tab=contacts`);
    const observerRow = observerSession.page.getByRole("region", { name: "Organisation contacts", exact: true })
      .getByRole("row").filter({ has: observerSession.page.getByText(name, { exact: true }) });
    await expect(observerRow).toBeVisible();
    await expect(observerRow.getByRole("button", { name: /^Edit / })).toHaveCount(0);
    await expect(observerRow.getByRole("button", { name: /^Remove / })).toHaveCount(0);
    const memberName = zz("contact member creator");
    const memberCreated = await observer.c.post(`/api/orgs/${orgId}/contacts`, { name: memberName, role: "Creator" });
    expect(memberCreated.status).toBe(201);
    const memberContactId = memberCreated.json.contact.id as string;
    memberContactIdForCleanup = memberContactId;
    later(async () => {
      const loaded = await admin.api.get(`/api/contacts/${memberContactId}`);
      if (loaded.status === 200) expect((await admin.api.del(`/api/contacts/${memberContactId}`)).status).toBe(204);
      else expect(loaded.status).toBe(404);
    });
    const adminEdit = await admin.api.patch(`/api/contacts/${memberContactId}`, { role: "Admin edited" });
    expect(adminEdit.status).toBe(200);
    await observerSession.page.reload();
    const memberRow = observerSession.page.getByRole("region", { name: "Organisation contacts", exact: true })
      .getByRole("row").filter({ has: observerSession.page.getByText(memberName, { exact: true }) });
    await memberRow.getByRole("button", { name: /^Edit / }).click();
    const memberEdit = observerSession.page.getByRole("dialog", { name: "Edit contact" });
    await memberEdit.getByRole("textbox", { name: "Role" }).fill("Member edited");
    await memberEdit.getByRole("button", { name: "Save" }).click();
    await expect(memberEdit).toHaveCount(0);
    expect((await admin.api.get(`/api/contacts/${memberContactId}`)).json.contact.role).toBe("Member edited");
    await memberRow.getByRole("button", { name: /^Edit / }).click();
    const staleEdit = observerSession.page.getByRole("dialog", { name: "Edit contact" });
    await staleEdit.getByRole("textbox", { name: "Role" }).fill("Stale role");
    expect((await admin.api.patch(`/api/contacts/${memberContactId}`, { role: "Current role" })).status).toBe(200);
    await staleEdit.getByRole("button", { name: "Save" }).click();
    await expect(staleEdit.getByRole("alert")).toContainText("changed while you were editing");
    expect((await admin.api.get(`/api/contacts/${memberContactId}`)).json.contact.role).toBe("Current role");
    await staleEdit.getByRole("button", { name: "Cancel" }).click();
    expect((await observer.c.get(`/api/orgs/${orgId}/history`)).status).toBe(404);
    const history = await admin.api.get(`/api/orgs/${orgId}/history`);
    expect(history.status).toBe(200);
    expect(history.json.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "contact.created", after: expect.objectContaining({ name: memberName, organisationId: orgId }) }),
      expect.objectContaining({ action: "contact.updated", after: expect.objectContaining({ role: "Current role" }) }),
    ]));
  } finally { await observerSession.ctx.close(); }
  const linked = await postTaskCurrent(admin, taskId, "links", { contactId });
  expect(linked.status).toBe(201);
  expect((await postTaskCurrent(admin, dealTaskId, "links", { contactId })).status).toBe(201);
  const linkedTask = await admin.api.get(`/api/tasks/${taskId}`);
  expect(linkedTask.status).toBe(200);
  expect(linkedTask.json.task.links).toEqual([expect.objectContaining({ contact: expect.objectContaining({ id: contactId, organisationId: orgId }) })]);
  expect((await admin.api.get(`/api/tasks/${dealTaskId}`)).json.task.links).toEqual([expect.objectContaining({ contact: expect.objectContaining({ id: contactId, organisationId: orgId }) })]);

  const row = page.getByRole("region", { name: "Organisation contacts", exact: true })
    .getByRole("row").filter({ has: page.getByText(name, { exact: true }) });
  await row.getByRole("button", { name: /^Edit / }).click();
  const edit = page.getByRole("dialog", { name: "Edit contact" });
  await edit.getByRole("textbox", { name: "Role" }).fill("Senior liaison");
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit).toHaveCount(0);
  const edited = await admin.api.get(`/api/contacts/${contactId}`);
  expect(edited.status).toBe(200);
  expect(edited.json.contact).toMatchObject({ organisationId: orgId, role: "Senior liaison" });
  expect(edited.json.contact.tasks.map((item: { id: string }) => item.id)).toEqual(expect.arrayContaining([taskId, dealTaskId]));
  const reassignment = await admin.api.patch(`/api/contacts/${contactId}`, { organisationId: sentinelId, role: "Senior liaison" });
  expect(reassignment.status).toBe(400);
  expect((await admin.api.get(`/api/contacts/${contactId}`)).json.contact.organisationId).toBe(orgId);
  expect((await admin.api.get(`/api/orgs/${sentinelId}/contacts`)).json.contacts).toHaveLength(0);
  mkdirSync(evidenceDir, { recursive: true });
  await page.screenshot({ path: `${evidenceDir}/edited.png`, fullPage: true });

  await row.getByRole("button", { name: /^Remove / }).click();
  const [deleted] = await Promise.all([
    page.waitForResponse((response) => response.url().endsWith(`/api/contacts/${contactId}`) && response.request().method() === "DELETE"),
    page.getByRole("dialog", { name: "Remove contact?" }).getByRole("button", { name: "Remove" }).click(),
  ]);
  expect(deleted.status()).toBe(204);
  const undoId = deleted.headers()["x-undo-id"];
  expect(undoId).toBeTruthy();
  await expect(row).toHaveCount(0);
  expect((await admin.api.get(`/api/contacts/${contactId}`)).status).toBe(404);
  expect((await admin.api.get(`/api/tasks/${taskId}`)).json.task.links).toHaveLength(0);
  expect((await admin.api.get(`/api/tasks/${dealTaskId}`)).json.task.links).toHaveLength(0);
  expect((await admin.api.get(`/api/orgs/${orgId}`)).json.organisation.tasks.map((item: { id: string }) => item.id)).not.toContain(taskId);

  expect((await admin.api.post(`/api/actions/${undoId}/undo`, {})).status).toBe(200);
  expect((await admin.api.post(`/api/actions/${undoId}/undo`, {})).status).toBe(409);
  const restored = await admin.api.get(`/api/contacts/${contactId}`);
  expect(restored.status).toBe(200);
  expect(restored.json.contact).toMatchObject({ organisationId: orgId, role: "Senior liaison" });
  expect(restored.json.contact.tasks.map((item: { id: string }) => item.id)).toEqual(expect.arrayContaining([taskId, dealTaskId]));
  expect((await admin.api.get(`/api/tasks/${taskId}`)).json.task.links).toEqual([expect.objectContaining({ contact: expect.objectContaining({ id: contactId, organisationId: orgId }) })]);
  expect((await admin.api.get(`/api/tasks/${dealTaskId}`)).json.task.links).toEqual([expect.objectContaining({ contact: expect.objectContaining({ id: contactId, organisationId: orgId }) })]);
  expect(createHash("sha256").update(JSON.stringify((await admin.api.get(`/api/orgs/${sentinelId}`)).json.organisation)).digest("hex")).toBe(sentinelHash);
  writeFileSync(`${evidenceDir}/verification.json`, JSON.stringify({ fixture, orgId, sentinelId, projectId: project.id, dealId, taskId, dealTaskId, contactId, mobileWidth: 390,
    originalOrganisationFixed: true, nonCreatorReadOnly: true, deniedWritesPreservedContact: true, memberCreatorEdit: true, adminNoncreatorEdit: true, staleFormConflict: true, historyAdminOnly: true, linkedTaskHiddenOnRemoval: true, linkedTaskRestoredOnUndo: true, dealTaskContactLinkHiddenOnRemovalAndRestoredOnUndo: true, replayRejected: true, sentinelPreserved: true }, null, 2));
});
