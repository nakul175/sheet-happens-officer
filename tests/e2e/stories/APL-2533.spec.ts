// SHO-US-11.2 Contacts under an organisation (APL-2533).
// One test per acceptance criterion. ZZ-TEST organisations, contacts, deals and the throwaway person
// are archived or deactivated afterwards. The plain Member is the second person.
// There is no tests/e2e/jim-gate.ts. CRM_VISIBLE is read from the live /api/orgs answer, never a hard skip.
// The file skips only when SHO_QA_PASS is unset. Credentials come from the environment. workers is 1 in playwright.config.ts. Traces stay off.
import { expect, zz, RUN } from "../support";
import { ghost, newProject, newTask, ymd, type Who } from "../helpers/migration-2731";
import { raw } from "../helpers/jim-http";
import type { Page } from "@playwright/test";
import { test, PASS, passwordOk } from "./qa";

// SHO-2758: the approved contact table already supplies semantic rows; no markup or styling change is needed.
const contactRow = (page: Page, name: string) => page.getByRole("region", { name: "Organisation contacts", exact: true })
  .getByRole("row").filter({ has: page.getByText(name, { exact: true }) });

/** Idempotent API cleanup, including the case that explicitly archived its organisation. */
async function removeContact(admin: Who, id: string, orgId: string) {
  const loaded = await admin.api.get(`/api/contacts/${id}`);
  if (loaded.status === 404) return;
  expect(loaded.status).toBe(200);
  const org = await admin.api.get(`/api/orgs/${orgId}`);
  expect(org.status).toBe(200);
  const archived = org.json.organisation.archived;
  if (archived) expect((await admin.api.post(`/api/orgs/${orgId}/archive`, { archive: false })).status).toBe(200);
  try { expect((await admin.api.del(`/api/contacts/${id}`)).status).toBe(204); }
  finally { if (archived) expect((await admin.api.post(`/api/orgs/${orgId}/archive`, { archive: true })).status).toBe(200); }
}

type Later = (fn: () => Promise<unknown>) => void;
type Known = { id: string; name: string; active: boolean };
type Contact = {
  id: string; name: string; role: string | null; email: string | null; phone: string | null;
  canEdit: boolean; knownBy: Known[]; lastSpoke: string | null;
};

test.beforeAll(() => {
  test.skip(!PASS, "Set SHO_QA_PASS (the password for nakul17+ aliases).");
  if (!passwordOk(PASS)) throw new Error("SHO_QA_PASS must be at least 8 characters with a letter and a number.");
});

test.beforeEach(async ({ admin }) => {
  const r = await admin.api.get("/api/orgs");

  expect(r.status).toBe(200);
});

async function memberCrm(member: Who) {
  const r = await member.api.get("/api/orgs");

  expect(r.status).toBe(200);
}

async function makeOrg(who: Who, later: Later, label: string) {
  const name = zz(label);
  const r = await who.api.post("/api/orgs", { name });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = r.json.organisation.id as string;
  later(async () => {
    const current = await who.api.get(`/api/orgs/${id}`);
    expect(current.status).toBe(200);
    if (!current.json.organisation.archived) expect((await who.api.post(`/api/orgs/${id}/archive`, { archive: true })).status).toBe(200);
  });
  return { id, name };
}

const contactsOf = async (who: Who, orgId: string) =>
  (await who.api.get(`/api/orgs/${orgId}/contacts`)).json.contacts as Contact[];

/** The same date text the contact row renders for Last spoke. */
const spokeLabel = (page: Page, iso: string) => page.evaluate(
  (d) => new Date(`${d}T00:00:00+05:30`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" }),
  iso,
);

async function proactive(who: Who) {
  const r = await who.api.get("/api/deals/pipelines");
  expect(r.status).toBe(200);
  const pipe = (r.json.pipelines as { id: string; key: string }[]).find((p) => p.key === "DEAL_PROACTIVE");
  expect(pipe, "the Proactive pipeline").toBeTruthy();
  return pipe!;
}

test("qa:TC missing AC1: a name saves a contact, role email and phone are optional, any Member adds, only the creator and an Admin edit or remove, and an archived organisation refuses a new contact", async ({ admin, member, later }) => {
  test.setTimeout(180_000);
  await memberCrm(member);
  const org = await makeOrg(admin, later, "contacts org");

  await member.page.goto(`/accounts/${org.id}?tab=contacts`);
  await member.page.getByRole("button", { name: "+ Contact" }).click();
  const dlg = member.page.getByRole("dialog", { name: "New contact" });
  await expect(dlg.getByRole("button", { name: "Save" })).toBeDisabled();
  const bareName = zz("bare contact");
  await dlg.getByRole("textbox", { name: "Name", exact: true }).fill(bareName);
  await dlg.getByRole("button", { name: "Save" }).click();
  await expect(dlg).toHaveCount(0);
  const bareRow = contactRow(member.page, bareName);
  await expect(bareRow).toBeVisible();
  await expect(bareRow).toContainText("No email");
  await expect(bareRow).toContainText("No phone");
  const bare = (await contactsOf(member, org.id)).find((c) => c.name === bareName)!;
  expect(bare).toMatchObject({ role: null, email: null, phone: null, canEdit: true });
  later(() => removeContact(admin, bare.id, org.id));

  const fullName = zz("full contact");
  const email = `zz-full-${RUN}@example.invalid`;
  const made = await member.api.post(`/api/orgs/${org.id}/contacts`, { name: fullName, role: "Director", email, phone: "+91 99999" });
  expect(made.status).toBe(201);
  const fullId = made.json.contact.id as string;
  later(() => removeContact(admin, fullId, org.id));
  await member.page.reload();
  const fullRow = contactRow(member.page, fullName);
  await expect(fullRow).toContainText("Director");
  await expect(fullRow).toContainText(email);
  await expect(fullRow).toContainText("+91 99999");
  const badEmail = await member.api.post(`/api/orgs/${org.id}/contacts`, { name: zz("bad email"), email: "not-an-email" });
  expect(badEmail.status).toBe(400);
  const blank = await member.api.post(`/api/orgs/${org.id}/contacts`, { name: " " });
  expect(blank.status).toBe(400);

  const byAdminName = zz("admin contact");
  const byAdmin = await admin.api.post(`/api/orgs/${org.id}/contacts`, { name: byAdminName });
  expect(byAdmin.status).toBe(201);
  const adminContact = byAdmin.json.contact.id as string;
  later(() => removeContact(admin, adminContact, org.id));
  const refusedEdit = await member.api.patch(`/api/contacts/${adminContact}`, { role: "Hijack" });
  expect(refusedEdit.status).toBe(403);
  expect(refusedEdit.json.error).toContain("Only the person who added this contact, or an Admin");
  expect((await member.api.del(`/api/contacts/${adminContact}`)).status).toBe(403);
  expect((await contactsOf(admin, org.id)).some((c) => c.id === adminContact)).toBe(true);
  await member.page.reload();
  const adminRow = contactRow(member.page, byAdminName);
  await expect(adminRow.getByRole("button", { name: /^Edit / })).toHaveCount(0);
  await expect(adminRow.getByRole("button", { name: /^Remove / })).toHaveCount(0);

  expect((await admin.api.patch(`/api/contacts/${fullId}`, { role: "Advisor" })).status, "an Admin who did not create it may edit").toBe(200);
  expect((await contactsOf(member, org.id)).find((c) => c.id === fullId)?.role).toBe("Advisor");
  await member.page.reload();
  await fullRow.getByRole("button", { name: /^Edit / }).click();
  const edit = member.page.getByRole("dialog", { name: "Edit contact" });
  await edit.getByLabel("Role").fill("Trustee");
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit).toHaveCount(0);
  expect((await contactsOf(admin, org.id)).find((c) => c.id === fullId)?.role).toBe("Trustee");

  await fullRow.getByRole("button", { name: /^Remove / }).click();
  const confirm = member.page.getByRole("dialog", { name: "Remove contact?" });
  await confirm.getByRole("button", { name: "Remove" }).click();
  await expect(contactRow(member.page, fullName)).toHaveCount(0);
  expect((await contactsOf(admin, org.id)).some((c) => c.id === fullId)).toBe(false);

  expect((await admin.api.post(`/api/orgs/${org.id}/archive`, { archive: true })).status).toBe(200);
  await member.page.reload();
  await expect(member.page.getByText("This organisation is archived.")).toBeVisible();
  await expect(member.page.getByRole("button", { name: "+ Contact" })).toHaveCount(0);
  const late = await member.api.post(`/api/orgs/${org.id}/contacts`, { name: zz("too late") });
  expect(late.status).toBe(409);
  expect(late.json.error).toContain("archived");
  await expect(contactRow(member.page, bareName)).toBeVisible();
});

test("qa:TC missing AC2: a contact is not a user and cannot be an assignee, collaborator, approver or project member", async ({ admin, later }) => {
  test.setTimeout(120_000);
  const org = await makeOrg(admin, later, "not a user");
  const name = zz("not a user contact");
  const email = `zz-not-user-${RUN}@example.invalid`;
  const made = await admin.api.post(`/api/orgs/${org.id}/contacts`, { name, email, role: "Liaison" });
  expect(made.status).toBe(201);
  const contactId = made.json.contact.id as string;
  later(() => removeContact(admin, contactId, org.id));
  expect((await admin.api.get(`/api/contacts/${contactId}`)).status).toBe(200);

  const people = (await admin.api.get("/api/team")).json.people as { id: string; email?: string }[];
  expect(people.some((p) => p.id === contactId)).toBe(false);
  expect(people.some((p) => p.email === email)).toBe(false);
  expect((await admin.api.get(`/api/team/${contactId}`)).status).toBe(404);

  await admin.page.goto("/team");
  await expect(admin.page.getByRole("main").getByRole("link", { name: admin.user.name, exact: true })).toBeVisible();
  await expect(admin.page.getByText(name)).toHaveCount(0);
  await expect(admin.page.getByText(email)).toHaveCount(0);

  const worker = await ghost(admin, later, "worker");
  const project = await newProject(admin, later, { label: "contact roles" });
  expect((await admin.api.post(`/api/projects/${project.id}/members`, { userId: worker.id, role: "EDITOR" })).status).toBe(201);
  const taskId = await newTask(admin, project.id, { title: zz("held by the worker"), assigneeId: worker.id });

  // Task writes carry the task's current updatedAt (src/lib/schemas.ts), so the refusal is about the contact, not the version.
  const version = async () => (await admin.api.get(`/api/tasks/${taskId}`)).json.task.updatedAt as string;
  const asAssignee = await admin.api.post(`/api/tasks/${taskId}/assign`, { assigneeId: contactId, expectedUpdatedAt: await version() });
  expect(asAssignee.status).toBe(400);
  expect(asAssignee.json.error).toContain("assignee");
  const asCollaborator = await admin.api.post(`/api/tasks/${taskId}/collaborators`, { userId: contactId });
  expect(asCollaborator.status).toBe(400);
  expect(asCollaborator.json.error).toContain("member");
  const asApprover = await admin.api.put(`/api/tasks/${taskId}/approver`, { approverId: contactId, expectedUpdatedAt: await version() });
  expect(asApprover.status).toBe(400);
  expect(asApprover.json.error).toContain("approver");
  const asMember = await admin.api.post(`/api/projects/${project.id}/members`, { userId: contactId, role: "EDITOR" });
  expect(asMember.status).toBe(400);
  expect(asMember.json.error).toContain("active person");
  const onCreate = await admin.api.post(`/api/projects/${project.id}/tasks`, { title: zz("refused assignee"), dueDate: ymd(3), assigneeId: contactId });
  expect(onCreate.status).toBe(400);
  expect(onCreate.json.error).toContain("assignee");
  const task = (await admin.api.get(`/api/tasks/${taskId}`)).json.task as { assignee: { id: string }; collaborators: { id: string }[]; approver: { id: string } | null };
  expect(task.assignee.id).toBe(worker.id);
  expect(task.collaborators).toHaveLength(0);
  expect(task.approver).toBeNull();

  await admin.page.goto(`/projects/${project.id}?task=${taskId}`);
  const dialog = admin.page.getByRole("dialog", { name: "Task" });
  await expect(dialog.getByLabel("Assignee")).toBeVisible();
  const optionValues = async (label: string) => {
    const picker = dialog.getByLabel(label, { exact: true });
    await expect(picker).toBeVisible();
    return picker.getByRole("option").evaluateAll((opts) => opts.map((o) => (o as HTMLOptionElement).value));
  };
  expect(await optionValues("Assignee")).not.toContain(contactId);
  expect(await optionValues("Add a collaborator")).not.toContain(contactId);
  expect(await optionValues("Approver")).not.toContain(contactId);
  await expect(dialog.getByText(name)).toHaveCount(0);
});

test("qa:TC missing AC3: Known by lists one or more active members, defaults to the creator, keeps a deactivated member greyed with their name, and refuses adding a deactivated person", async ({ admin, later }) => {
  test.setTimeout(180_000);
  const org = await makeOrg(admin, later, "known by");
  const person = await ghost(admin, later, "known");
  const personName = `ZZ-TEST known ${RUN}`;

  await admin.page.goto(`/accounts/${org.id}?tab=contacts`);
  await admin.page.getByRole("button", { name: "+ Contact" }).click();
  const dlg = admin.page.getByRole("dialog", { name: "New contact" });
  await expect(dlg.getByRole("checkbox", { name: admin.user.name, exact: true })).toBeChecked();
  const name = zz("default known");
  // A Known-by surname can contain "name", so the label match is not only the Name field.
  await dlg.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await dlg.getByRole("checkbox", { name: admin.user.name, exact: true }).setChecked(false);
  await expect(dlg.getByRole("button", { name: "Save" })).toBeDisabled();
  await dlg.getByRole("checkbox", { name: admin.user.name, exact: true }).setChecked(true);
  await dlg.getByRole("checkbox", { name: personName, exact: true }).setChecked(true);
  await dlg.getByRole("button", { name: "Save" }).click();
  await expect(dlg).toHaveCount(0);

  const saved = (await contactsOf(admin, org.id)).find((c) => c.name === name)!;
  expect(saved.knownBy.map((k) => k.id).sort()).toEqual([admin.user.id, person.id].sort());
  expect(saved.knownBy.every((k) => k.active)).toBe(true);
  later(() => removeContact(admin, saved.id, org.id));
  const row = contactRow(admin.page, name);
  await expect(row.getByRole("cell").filter({ hasText: personName })).toBeVisible();
  await expect(row.getByRole("cell").filter({ hasText: personName }).getByText("· inactive", { exact: true })).toHaveCount(0);

  const omitted = await admin.api.post(`/api/orgs/${org.id}/contacts`, { name: zz("creator only") });
  expect(omitted.status).toBe(201);
  later(() => removeContact(admin, omitted.json.contact.id, org.id));
  const alone = (await contactsOf(admin, org.id)).find((c) => c.id === omitted.json.contact.id)!;
  expect(alone.knownBy).toEqual([{ id: admin.user.id, name: admin.user.name, active: true }]);

  expect((await admin.api.post(`/api/team/${person.id}/deactivate`, { reassign: "leaders" })).status).toBe(200);
  await admin.page.reload();
  const known = contactRow(admin.page, name).getByRole("cell").filter({ hasText: personName });
  await expect(known).toContainText(personName);
  const inactive = known.getByText("· inactive", { exact: true });
  await expect(inactive).toBeVisible();
  await expect(inactive).toHaveCSS("color", "rgb(94, 102, 115)");
  expect((await contactsOf(admin, org.id)).find(c => c.id === saved.id)?.knownBy.find(k => k.id === person.id)?.active).toBe(false);

  const again = await admin.api.patch(`/api/contacts/${saved.id}`, { knownBy: [admin.user.id, person.id] });
  expect(again.status).toBe(400);
  expect(again.json.error).toContain("active members");
  const fresh = await admin.api.post(`/api/orgs/${org.id}/contacts`, { name: zz("refused known"), knownBy: [person.id] });
  expect(fresh.status).toBe(400);

  await contactRow(admin.page, name).getByRole("button", { name: /^Edit / }).click();
  const edit = admin.page.getByRole("dialog", { name: "Edit contact" });
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit.getByRole("alert")).toContainText("Choose active members");
  expect((await contactsOf(admin, org.id)).find((c) => c.id === saved.id)?.knownBy.map((k) => k.id).sort()).toEqual([admin.user.id, person.id].sort());
});

test("qa:TC missing AC4: Last spoke is the date of the newest note on that contact the viewer may see, and a hidden deal note is never counted", async ({ admin, member, later }) => {
  test.setTimeout(180_000);
  await memberCrm(member);
  const org = await makeOrg(admin, later, "spoke org");
  const name = zz("spoke contact");
  const made = await admin.api.post(`/api/orgs/${org.id}/contacts`, { name });
  expect(made.status).toBe(201);
  const contactId = made.json.contact.id as string;
  later(() => removeContact(admin, contactId, org.id));
  expect((await contactsOf(member, org.id)).find((c) => c.id === contactId)?.lastSpoke).toBeNull();
  await member.page.goto(`/accounts/${org.id}?tab=contacts`);
  const row = () => contactRow(member.page, name);
  await expect(row().getByRole("cell", { name: "Never", exact: true })).toBeVisible();

  const older = ymd(-6);
  const newer = ymd(-1);
  const publicText = zz("public call");
  const hiddenText = zz("deal only call");
  expect((await admin.api.post(`/api/orgs/${org.id}/notes`, { kind: "CALL", date: older, text: publicText, contactIds: [contactId] })).status).toBe(201);
  expect((await contactsOf(member, org.id)).find((c) => c.id === contactId)?.lastSpoke).toBe(older);
  await member.page.reload();
  await expect(row()).toContainText(await spokeLabel(member.page, older));

  const pipe = await proactive(admin);
  const deal = await admin.api.post("/api/deals", {
    name: zz("spoke deal"), organisationId: org.id, pipelineId: pipe.id, leaderId: admin.user.id, whyPursue: "ZZ-TEST fit",
    nextStep: { title: zz("step"), dueDate: ymd(4) },
  });
  expect(deal.status, JSON.stringify(deal.json)).toBe(201);
  const dealId = deal.json.deal.id as string;
  later(() => admin.api.post(`/api/projects/${dealId}/archive`));
  expect((await admin.api.post(`/api/orgs/${org.id}/notes`, { kind: "MEETING", date: newer, text: hiddenText, projectId: dealId, contactIds: [contactId] })).status).toBe(201);

  expect((await contactsOf(admin, org.id)).find((c) => c.id === contactId)?.lastSpoke).toBe(newer);
  expect((await contactsOf(member, org.id)).find((c) => c.id === contactId)?.lastSpoke).toBe(older);
  await member.page.reload();
  await expect(row()).toContainText(await spokeLabel(member.page, older));
  await expect(member.page.getByText(hiddenText)).toHaveCount(0);
  await admin.page.goto(`/accounts/${org.id}?tab=contacts`);
  const adminRow = contactRow(admin.page, name);
  await expect(adminRow).toContainText(await spokeLabel(admin.page, newer));
  await admin.page.getByRole("link", { name: /^Notes \d+/ }).click();
  await expect(admin.page.getByText(hiddenText)).toBeVisible();

  expect((await admin.api.post(`/api/projects/${dealId}/members`, { userId: member.user.id, role: "VIEWER" })).status).toBe(201);
  expect((await contactsOf(member, org.id)).find((c) => c.id === contactId)?.lastSpoke).toBe(newer);
  await member.page.reload();
  await expect(row()).toContainText(await spokeLabel(member.page, newer));
  await member.page.getByRole("link", { name: /^Notes \d+/ }).click();
  await expect(member.page.getByText(hiddenText)).toBeVisible();
});

test("qa:TC missing AC5: any signed-in Member sees all contacts, changes are logged with no project and shown in organisation History to Admins only, and undo uses the contact labels", async ({ admin, member, later }) => {
  test.setTimeout(180_000);
  await memberCrm(member);
  const org = await makeOrg(admin, later, "contact log");
  const name = zz("visible contact");
  const made = await raw(member, "POST", `/api/orgs/${org.id}/contacts`, { name, role: "Officer" });
  expect(made.status).toBe(201);
  expect(made.headers["x-undo-label"]).toBe("Contact added");
  const id = made.json.contact.id as string;
  later(() => removeContact(admin, id, org.id));
  expect((await contactsOf(admin, org.id)).some((c) => c.id === id)).toBe(true);
  await admin.page.goto(`/accounts/${org.id}?tab=contacts`);
  await expect(contactRow(admin.page, name)).toBeVisible();

  const denied = await member.api.get(`/api/orgs/${org.id}/history`);
  expect(denied.status).toBe(404);
  expect(denied.json.error).toBe("Page not found");
  // History only returns rows with no project, so these are the contact's action-log rows.
  let items = (await admin.api.get(`/api/orgs/${org.id}/history`)).json.items as { action: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null }[];
  const created = items.find((i) => i.action === "contact.created" && i.after?.name === name);
  expect(created?.before ?? null).toBeNull();
  expect(created?.after).toMatchObject({ name, organisationId: org.id });

  const edited = await raw(member, "PATCH", `/api/contacts/${id}`, { role: "Lead" });
  expect(edited.status).toBe(200);
  expect(edited.headers["x-undo-label"]).toBe("Contact edited");
  items = (await admin.api.get(`/api/orgs/${org.id}/history`)).json.items as typeof items;
  const editRow = items.find((i) => i.action === "contact.updated" && i.after?.role === "Lead");
  expect(editRow?.before).toMatchObject({ role: "Officer" });
  expect(editRow?.after).toMatchObject({ role: "Lead" });
  expect((await member.api.post(`/api/actions/${edited.headers["x-undo-id"]}/undo`, { anyway: false })).status).toBe(200);
  expect((await contactsOf(admin, org.id)).find((c) => c.id === id)?.role).toBe("Officer");

  const removed = await raw(admin, "DELETE", `/api/contacts/${id}`);
  expect(removed.status).toBe(204);
  expect(removed.headers["x-undo-label"]).toBe("Contact removed");
  expect((await contactsOf(member, org.id)).some((c) => c.id === id)).toBe(false);
  const stranger = await member.api.post(`/api/actions/${removed.headers["x-undo-id"]}/undo`, { anyway: false });
  expect(stranger.status).toBe(403);
  expect(stranger.json.error).toContain("your own actions");
  expect((await admin.api.post(`/api/actions/${removed.headers["x-undo-id"]}/undo`, { anyway: false })).status).toBe(200);
  expect((await contactsOf(member, org.id)).some((c) => c.id === id)).toBe(true);

  const createUndo = await member.api.post(`/api/actions/${made.headers["x-undo-id"]}/undo`, { anyway: false });
  expect(createUndo.status).toBe(200);
  expect((await contactsOf(admin, org.id)).some((c) => c.id === id), "undo of Contact added removes the contact").toBe(false);
  expect((await member.api.post(`/api/actions/${made.headers["x-undo-id"]}/undo`, { anyway: false })).status).toBe(409);

  const searchable = zz("search contact");
  const kept = await member.api.post(`/api/orgs/${org.id}/contacts`, { name: searchable });
  expect(kept.status).toBe(201);
  const keptId = kept.json.contact.id as string;
  later(() => removeContact(admin, keptId, org.id));
  const hit = (await member.api.get(`/api/search?q=${encodeURIComponent(searchable)}`)).json.contacts as { id: string }[];
  expect(hit.map((c) => c.id)).toContain(keptId);
  await member.page.goto("/search");
  await member.page.getByRole("searchbox", { name: "Search", exact: true }).fill(searchable);
  await expect(member.page.getByRole("heading", { name: "Contacts", exact: true })).toBeVisible();
  await expect(member.page.getByRole("link").filter({ hasText: searchable })).toBeVisible();

  expect((await member.api.del(`/api/contacts/${keptId}`)).status).toBe(204);
  const missed = (await admin.api.get(`/api/search?q=${encodeURIComponent(searchable)}`)).json.contacts as { id: string }[];
  expect(missed).toHaveLength(0);
  await member.page.reload();
  await member.page.getByRole("searchbox", { name: "Search", exact: true }).fill(searchable);
  await expect(member.page.getByRole("status").filter({ hasText: "Nothing matches" })).toContainText("Nothing matches");
  await expect(member.page.getByRole("link").filter({ hasText: searchable })).toHaveCount(0);

  await admin.page.goto(`/accounts/${org.id}?tab=contacts`);
  const more = admin.page.getByRole("main").getByText("More", { exact: true });
  await expect(more).toBeVisible();
  await more.click();
  const history = admin.page.getByRole("button", { name: "History", exact: true });
  await expect(history).toBeVisible();
  await history.click();
  // The History line is who · action · the clock time. Two rows can share a second, so the time
  // alone is not the name. The action in that line keeps created, updated and removed apart.
  const logged = (await admin.api.get(`/api/orgs/${org.id}/history`)).json.items as { id: string; at: string; who: string; action: string }[];
  // An edit and its undo can log the same who · action · second twice. Those rows are identical on
  // screen, so the check is that the page shows each logged line exactly as many times as the log has it.
  const lineOf = (i: { who: string; action: string; at: string }) =>
    admin.page.evaluate(
      ({ who, action, at }) => `${who} · ${action} · ${new Date(at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`,
      i,
    );
  const lines = await Promise.all(logged.map(lineOf));
  const expectRow = async (id: string | undefined, action: string) => {
    expect(id, "x-undo-id").toBeTruthy();
    const index = logged.findIndex((i) => i.id === id);
    expect(index, id).toBeGreaterThanOrEqual(0);
    expect(logged[index].action).toBe(action);
    const line = lines[index];
    await expect(admin.page.getByText(line, { exact: true })).toHaveCount(lines.filter((l) => l === line).length);
  };
  // Every logged line is on the page as many times as it is logged, so History shows the whole log.
  for (const line of new Set(lines)) await expect(admin.page.getByText(line, { exact: true })).toHaveCount(lines.filter((l) => l === line).length);
  await expectRow(made.headers["x-undo-id"], "contact.created");
  await expectRow(edited.headers["x-undo-id"], "contact.updated");
  await expectRow(removed.headers["x-undo-id"], "contact.removed");
});
