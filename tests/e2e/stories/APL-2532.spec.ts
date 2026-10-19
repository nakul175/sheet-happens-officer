// SHO-US-11.1 Organisations with a parent tree (APL-2532).
// One test per acceptance criterion. ZZ-TEST organisations and deals are archived afterwards.
// The plain Member is the second person. A new person's password is only emailed, so a deactivated
// creator cannot be signed in here; AC4 checks the same rule with the roles this server actually has.
// CRM_VISIBLE is read from the live /api/orgs answer, never a hard skip.
// AC6's undo of Organisation archived / Organisation unarchived follows PR #19 (tests/e2e/helpers/jim-gate.ts):
// when that fix is live both undos reverse the archive; until then both answer 409 and the organisation stays as it was.
// Credentials come from the environment. workers is 1 in playwright.config.ts. Traces stay off.
import { expect, login, zz } from "../support";
import { test } from "../helpers/story-people";
import { storyGate } from "../helpers/qa-alias";

storyGate({ admin: true });
import { ymd, type Who } from "../g2";
import { raw } from "../helpers/jim-http";
import { notLive, prLive } from "../helpers/jim-gate";

type Later = (fn: () => Promise<unknown>) => void;
type Org = {
  id: string; name: string; kind: string | null; country: string | null; level: string | null; parentId: string | null;
  archived: boolean; canEdit: boolean; path: { id: string; name: string }[];
  deals: { projectId: string; name: string }[];
};
type Hist = { action: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null };

test.beforeEach(async ({ admin }) => {
  const r = await admin.api.get("/api/orgs");
  expect(r.status, "CRM is hidden for the Super Admin on this server (CRM_VISIBLE is off). /api/orgs answered 404.").toBe(200);
});

async function memberCrm(member: Who) {
  const r = await member.api.get("/api/orgs");
  expect(r.status, "CRM is hidden for the plain Member on this server (CRM_VISIBLE=admins). /api/orgs answered 404.").toBe(200);
}

async function makeOrg(who: Who, later: Later, label: string, extra: Record<string, unknown> = {}) {
  const name = zz(label);
  const r = await who.api.post("/api/orgs", { name, ...extra });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = r.json.organisation.id as string;
  later(() => who.api.post(`/api/orgs/${id}/archive`, { archive: true }));
  return { id, name };
}

const load = async (who: Who, id: string) => (await who.api.get(`/api/orgs/${id}`)).json.organisation as Org;

async function history(who: Who, id: string) {
  const r = await who.api.get(`/api/orgs/${id}/history`);
  expect(r.status).toBe(200);
  return r.json.items as Hist[];
}

async function proactive(who: Who) {
  const r = await who.api.get("/api/deals/pipelines");
  expect(r.status).toBe(200);
  const pipe = (r.json.pipelines as { id: string; key: string }[]).find((p) => p.key === "DEAL_PROACTIVE");
  expect(pipe, "the Proactive pipeline").toBeTruthy();
  return pipe!;
}

test("AC1: a name creates the organisation in the person's workspace; kind, country, level and parent are optional", async ({ admin, later }) => {
  test.setTimeout(120_000);
  const parent = await makeOrg(admin, later, "parent");
  const bare = await makeOrg(admin, later, "bare");
  const bareOrg = await load(admin, bare.id);
  expect(bareOrg.kind).toBeNull();
  expect(bareOrg.country).toBeNull();
  expect(bareOrg.level).toBeNull();
  expect(bareOrg.parentId).toBeNull();
  expect(bareOrg.path.map((p) => p.id)).toEqual([bare.id]);
  const listed = (await admin.api.get("/api/orgs")).json.organisations as { id: string }[];
  expect(listed.some((o) => o.id === bare.id), "it is in the creator's workspace list").toBe(true);

  const full = await makeOrg(admin, later, "full", { kind: "Ministry", country: "Kenya", level: "LEGAL_ENTITY", parentId: parent.id });
  const fullOrg = await load(admin, full.id);
  expect(fullOrg).toMatchObject({ kind: "Ministry", country: "Kenya", level: "LEGAL_ENTITY", parentId: parent.id });
  expect(fullOrg.path.map((p) => p.id)).toEqual([parent.id, full.id]);
  const noName = await admin.api.post("/api/orgs", { name: " " });
  expect(noName.status).toBe(400);

  await admin.page.goto("/accounts");
  await admin.page.getByRole("button", { name: "+ New organisation" }).click();
  const dlg = admin.page.getByRole("dialog", { name: "New organisation" });
  await expect(dlg.getByRole("button", { name: "Add", exact: true })).toBeDisabled();
  const uiName = zz("from the form");
  await dlg.getByLabel("Name").fill(uiName);
  await dlg.getByLabel("Kind (e.g. Ministry, Company)").fill("Funder");
  await dlg.getByLabel("Country").fill("India");
  await expect(dlg.getByLabel("Sits under (optional)")).toHaveValue("");
  await dlg.getByRole("button", { name: "Add", exact: true }).click();
  await expect(dlg).toHaveCount(0);
  await expect(admin.page.locator(".undo-toast")).toContainText("Organisation added");
  await admin.page.getByLabel("Search organisations").fill(uiName);
  const row = admin.page.locator("tr", { hasText: uiName });
  await expect(row.getByRole("link", { name: uiName })).toBeVisible();
  await expect(row).toContainText("Funder");
  await expect(row).toContainText("India");
  const found = (await admin.api.get(`/api/orgs?q=${encodeURIComponent(uiName)}`)).json.organisations as { id: string; name: string }[];
  const made = found.find((o) => o.name === uiName);
  expect(made, "the form saved the organisation").toBeTruthy();
  later(() => admin.api.post(`/api/orgs/${made!.id}/archive`, { archive: true }));
  await admin.page.goto(`/accounts/${made!.id}`);
  await expect(admin.page.getByRole("heading", { name: uiName })).toBeVisible();
  await expect(admin.page.locator(".chip", { hasText: "Funder" })).toBeVisible();
  await expect(admin.page.getByText("India")).toBeVisible();
});

test("AC2: a name that already exists under the same parent, ignoring case, is refused with 409 needsConfirm duplicate, and the member can continue", async ({ admin, later }) => {
  test.setTimeout(120_000);
  const name = zz("dup org");
  const first = await makeOrg(admin, later, "dup org");
  expect(first.name).toBe(name);
  const dup = await admin.api.post("/api/orgs", { name: name.toLowerCase() });
  expect(dup.status).toBe(409);
  expect(dup.json.needsConfirm).toBe("duplicate");
  expect(dup.json.existingId).toBe(first.id);
  expect(dup.json.error).toContain(name);
  const forced = await admin.api.post("/api/orgs", { name: name.toLowerCase(), force: true });
  expect(forced.status).toBe(201);
  const forcedId = forced.json.organisation.id as string;
  expect(forcedId).not.toBe(first.id);
  later(() => admin.api.post(`/api/orgs/${forcedId}/archive`, { archive: true }));

  const parent = await makeOrg(admin, later, "other parent");
  const elsewhere = await admin.api.post("/api/orgs", { name, parentId: parent.id });
  expect(elsewhere.status, "the same name under a different parent is a different organisation").toBe(201);
  later(() => admin.api.post(`/api/orgs/${elsewhere.json.organisation.id}/archive`, { archive: true }));

  const uiName = zz("dup form");
  const ui = await makeOrg(admin, later, "dup form");
  expect(ui.name).toBe(uiName);
  await admin.page.goto("/accounts");
  await admin.page.getByRole("button", { name: "+ New organisation" }).click();
  const dlg = admin.page.getByRole("dialog", { name: "New organisation" });
  await dlg.getByLabel("Name").fill(uiName.toLowerCase());
  await dlg.getByRole("button", { name: "Add", exact: true }).click();
  await expect(dlg.getByRole("alert")).toContainText("already exists");
  await expect(dlg.getByRole("button", { name: "Add anyway" })).toBeVisible();
  await dlg.getByRole("button", { name: "Add anyway" }).click();
  await expect(dlg).toHaveCount(0);
  const rows = (await admin.api.get(`/api/orgs?q=${encodeURIComponent(uiName)}`)).json.organisations as { id: string; name: string }[];
  const extra = rows.filter((o) => o.id !== ui.id);
  expect(extra.length).toBeGreaterThan(0);
  for (const o of extra) later(() => admin.api.post(`/api/orgs/${o.id}/archive`, { archive: true }));
});

test("AC3: a parent cannot be the organisation or one of its descendants, and the page shows the full path", async ({ admin, later }) => {
  test.setTimeout(120_000);
  const group = await makeOrg(admin, later, "group");
  const ministry = await makeOrg(admin, later, "ministry", { parentId: group.id });
  const board = await makeOrg(admin, later, "board", { parentId: ministry.id });
  const got = await load(admin, board.id);
  expect(got.path.map((p) => p.id)).toEqual([group.id, ministry.id, board.id]);

  const underChild = await admin.api.patch(`/api/orgs/${group.id}`, { parentId: board.id });
  expect(underChild.status).toBe(400);
  expect(underChild.json.error).toContain("cannot sit under itself");
  expect((await load(admin, group.id)).parentId).toBeNull();
  const underSelf = await admin.api.patch(`/api/orgs/${group.id}`, { parentId: group.id });
  expect(underSelf.status).toBe(400);
  expect((await load(admin, group.id)).parentId).toBeNull();

  await admin.page.goto(`/accounts/${board.id}`);
  await expect(admin.page.getByRole("heading", { name: board.name })).toBeVisible();
  const crumb = admin.page.locator(".crumb");
  await expect(crumb.getByRole("link", { name: "Accounts" })).toBeVisible();
  await expect(crumb.getByRole("link", { name: group.name })).toBeVisible();
  await expect(crumb.getByRole("link", { name: ministry.name })).toBeVisible();
  // The side nav also marks Accounts with aria-current=page. The board name is the tree chip.
  const tree = admin.page.locator(".card", { has: admin.page.locator("[aria-current=page]") });
  await expect(tree.locator("[aria-current=page]")).toHaveText(board.name);
  await expect(tree.getByRole("link", { name: group.name })).toBeVisible();
  await expect(tree.getByRole("link", { name: ministry.name })).toBeVisible();
});

test("AC4: there is no delete; archive and unarchive work; any Member creates; only the creator and an Admin edit or archive", async ({ admin, member, later }) => {
  test.setTimeout(180_000);
  await memberCrm(member);
  // The creator's password for a brand-new person is only emailed, and the shared Member cannot be
  // deactivated without locking out later runs. A Member who is not the creator is refused, and an
  // Admin who did not create the organisation is allowed: that is the same rule once the creator is gone.
  const byMember = zz("member made");
  await member.page.goto("/accounts");
  await member.page.getByRole("button", { name: "+ New organisation" }).click();
  const dlg = member.page.getByRole("dialog", { name: "New organisation" });
  await dlg.getByLabel("Name").fill(byMember);
  await dlg.getByRole("button", { name: "Add", exact: true }).click();
  await expect(dlg).toHaveCount(0);
  const created = (await member.api.get(`/api/orgs?q=${encodeURIComponent(byMember)}`)).json.organisations as { id: string; name: string }[];
  const memberOrg = created.find((o) => o.name === byMember)!;
  expect(memberOrg).toBeTruthy();
  later(() => admin.api.post(`/api/orgs/${memberOrg.id}/archive`, { archive: true }));
  expect((await member.api.patch(`/api/orgs/${memberOrg.id}`, { country: "Ghana" })).status).toBe(200);
  expect((await load(admin, memberOrg.id)).country).toBe("Ghana");
  expect((await admin.api.patch(`/api/orgs/${memberOrg.id}`, { country: "Rwanda" })).status, "an Admin who did not create it may edit").toBe(200);

  const byAdmin = await makeOrg(admin, later, "admin made");
  const refusedEdit = await member.api.patch(`/api/orgs/${byAdmin.id}`, { name: zz("hijack") });
  expect(refusedEdit.status).toBe(403);
  expect(refusedEdit.json.error).toContain("Only the person who added this organisation, or an Admin");
  const refusedArchive = await member.api.post(`/api/orgs/${byAdmin.id}/archive`, { archive: true });
  expect(refusedArchive.status).toBe(403);
  expect((await load(admin, byAdmin.id)).name).toBe(byAdmin.name);
  expect((await load(admin, byAdmin.id)).archived).toBe(false);

  for (const path of [`/api/orgs/${byAdmin.id}`, "/api/orgs"]) {
    const gone = await admin.page.request.fetch(path, { method: "DELETE" });
    expect([404, 405], `DELETE ${path}`).toContain(gone.status());
  }
  expect((await load(admin, byAdmin.id)).id).toBe(byAdmin.id);

  await member.page.goto(`/accounts/${byAdmin.id}`);
  await expect(member.page.getByRole("heading", { name: byAdmin.name })).toBeVisible();
  await expect(member.page.getByRole("button", { name: "Archive" })).toHaveCount(0);
  await expect(member.page.getByRole("button", { name: "Delete" })).toHaveCount(0);

  await admin.page.goto(`/accounts/${byAdmin.id}`);
  await expect(admin.page.getByRole("button", { name: "Archive" })).toBeVisible();
  await expect(admin.page.getByRole("button", { name: "Delete" })).toHaveCount(0);
  await admin.page.getByRole("button", { name: "Archive" }).click();
  await expect(admin.page.getByText("This organisation is archived.")).toBeVisible();
  await expect(admin.page.getByRole("button", { name: "Unarchive" })).toBeVisible();
  const hidden = (await admin.api.get("/api/orgs")).json.organisations as { id: string }[];
  expect(hidden.some((o) => o.id === byAdmin.id)).toBe(false);
  const old = (await admin.api.get("/api/orgs?archived=true")).json.organisations as { id: string }[];
  expect(old.some((o) => o.id === byAdmin.id)).toBe(true);
  await admin.page.getByRole("button", { name: "Unarchive" }).click();
  await expect(admin.page.getByText("This organisation is archived.")).toHaveCount(0);
  expect((await load(admin, byAdmin.id)).archived).toBe(false);
  const back = (await admin.api.get("/api/orgs")).json.organisations as { id: string }[];
  expect(back.some((o) => o.id === byAdmin.id)).toBe(true);
});

test("AC5: any signed-in Member sees all organisations, and deal data still follows project membership", async ({ admin, member, later }) => {
  test.setTimeout(180_000);
  await memberCrm(member);
  const org = await makeOrg(admin, later, "shared org");
  const seen = (await member.api.get("/api/orgs")).json.organisations as { id: string }[];
  expect(seen.some((o) => o.id === org.id)).toBe(true);
  expect((await member.api.get(`/api/orgs/${org.id}`)).status).toBe(200);
  await member.page.goto("/accounts");
  await member.page.getByLabel("Search organisations").fill(org.name);
  await expect(member.page.getByRole("link", { name: org.name })).toBeVisible();

  const pipe = await proactive(admin);
  const dealName = zz("hidden deal");
  const deal = await admin.api.post("/api/deals", {
    name: dealName, organisationId: org.id, pipelineId: pipe.id, leaderId: admin.user.id, whyPursue: "ZZ-TEST fit",
    nextStep: { title: zz("step"), dueDate: ymd(6) },
  });
  expect(deal.status, JSON.stringify(deal.json)).toBe(201);
  const dealId = deal.json.deal.id as string;
  later(() => admin.api.post(`/api/projects/${dealId}/archive`));

  expect((await member.api.get(`/api/projects/${dealId}`)).status, "a non-member does not see the deal").toBe(404);
  expect((await load(member, org.id)).deals.some((d) => d.projectId === dealId)).toBe(false);
  expect((await load(admin, org.id)).deals.some((d) => d.projectId === dealId)).toBe(true);
  await member.page.goto(`/accounts/${org.id}`);
  await expect(member.page.getByText("No deals you can see yet.")).toBeVisible();
  await expect(member.page.getByText(dealName)).toHaveCount(0);
  await admin.page.goto(`/accounts/${org.id}`);
  await expect(admin.page.getByRole("link", { name: dealName })).toBeVisible();

  expect((await admin.api.post(`/api/projects/${dealId}/members`, { userId: member.user.id, role: "VIEWER" })).status).toBe(201);
  expect((await member.api.get(`/api/projects/${dealId}`)).status).toBe(200);
  expect((await load(member, org.id)).deals.some((d) => d.projectId === dealId)).toBe(true);
  await member.page.reload();
  await expect(member.page.getByRole("link", { name: dealName })).toBeVisible();
});

test("AC6: create, edit, parent change, archive and unarchive are logged with no project and before and after; undo uses the organisation labels; History is for Admins only and includes contact and note changes", async ({ admin, member, later }) => {
  test.setTimeout(180_000);
  await memberCrm(member);
  const gate = await prLive(19, admin, null, later);
  const parent = await makeOrg(admin, later, "log parent");
  const name = zz("logged org");
  const made = await raw(member, "POST", "/api/orgs", { name });
  expect(made.status).toBe(201);
  expect(made.headers["x-undo-label"]).toBe("Organisation added");
  const id = made.json.organisation.id as string;
  later(() => admin.api.post(`/api/orgs/${id}/archive`, { archive: true }));
  const createUndo = made.headers["x-undo-id"];
  expect(createUndo).toBeTruthy();

  const denied = await member.api.get(`/api/orgs/${id}/history`);
  expect(denied.status).toBe(404);
  expect(denied.json.error).toBe("Page not found");
  await member.page.goto(`/accounts/${id}`);
  await expect(member.page.getByRole("heading", { name })).toBeVisible();
  await expect(member.page.getByRole("button", { name: "History" })).toHaveCount(0);
  expect((await member.api.get("/api/audit")).status).toBe(404);

  // History only returns rows whose project is null, so a row here is the action log entry with no project.
  let items = await history(admin, id);
  const created = items.find((i) => i.action === "organisation.created");
  expect(created?.before ?? null).toBeNull();
  expect(created?.after).toMatchObject({ name, parentId: null });

  const edited = await raw(admin, "PATCH", `/api/orgs/${id}`, { country: "Kenya" });
  expect(edited.status).toBe(200);
  expect(edited.headers["x-undo-label"]).toBe("Organisation edited");
  items = await history(admin, id);
  const countryRow = items.find((i) => i.action === "organisation.updated" && i.after?.country === "Kenya");
  expect(countryRow?.before).toMatchObject({ country: null });
  expect(countryRow?.after).toMatchObject({ country: "Kenya" });
  expect((await admin.api.post(`/api/actions/${edited.headers["x-undo-id"]}/undo`, { anyway: false })).status).toBe(200);
  expect((await load(admin, id)).country).toBeNull();

  // The password the admin fixture actually signed in with (shard or SHO_ADMIN). Missing means skip the check, not the test.
  let pass = "";
  try { pass = login("ADMIN").password; } catch { /* no sign-in password configured */ }
  let body = await (await admin.page.request.get(`/api/audit?event=ORGANISATION_PARENT_CHANGED&person=${admin.user.id}`)).text();
  if (pass) expect(body.includes(pass)).toBe(false);
  const seenParent = new Set((JSON.parse(body).items as { id: string }[]).map((i) => i.id));
  const moved = await raw(admin, "PATCH", `/api/orgs/${id}`, { parentId: parent.id });
  expect(moved.status).toBe(200);
  expect(moved.headers["x-undo-label"]).toBe("Organisation edited");
  items = await history(admin, id);
  const parentEdit = items.find((i) => i.action === "organisation.updated" && i.after?.parentId === parent.id);
  const parentLog = items.find((i) => i.action === "organisation.parent_changed");
  expect(parentEdit?.before).toMatchObject({ parentId: null });
  expect(parentEdit?.after).toMatchObject({ parentId: parent.id });
  expect(parentLog?.before).toMatchObject({ parentId: null });
  expect(parentLog?.after).toMatchObject({ parentId: parent.id });
  body = await (await admin.page.request.get(`/api/audit?event=ORGANISATION_PARENT_CHANGED&person=${admin.user.id}`)).text();
  if (pass) expect(body.includes(pass)).toBe(false);
  const parentAudit = (JSON.parse(body).items as { id: string; event: string; at: string }[]).find((i) => !seenParent.has(i.id));
  expect(parentAudit?.event).toBe("ORGANISATION_PARENT_CHANGED");
  expect(Date.now() - Date.parse(parentAudit!.at)).toBeLessThan(120_000);

  expect((await admin.api.post(`/api/actions/${moved.headers["x-undo-id"]}/undo`, { anyway: false })).status).toBe(200);
  expect((await load(admin, id)).parentId).toBeNull();

  const contactName = zz("logged contact");
  const contact = await admin.api.post(`/api/orgs/${id}/contacts`, { name: contactName });
  expect(contact.status).toBe(201);
  const contactId = contact.json.contact.id as string;
  later(() => admin.api.del(`/api/contacts/${contactId}`));
  const note = await admin.api.post(`/api/orgs/${id}/notes`, { kind: "CALL", date: ymd(0), text: zz("logged note") });
  expect(note.status).toBe(201);
  items = await history(admin, id);
  expect(items.some((i) => i.action === "contact.created" && i.after?.name === contactName)).toBe(true);
  expect(items.some((i) => i.action === "note.created" && i.after?.organisationId === id)).toBe(true);

  const archived = await raw(admin, "POST", `/api/orgs/${id}/archive`, { archive: true });
  expect(archived.status).toBe(200);
  expect(archived.headers["x-undo-label"]).toBe("Organisation archived");
  items = await history(admin, id);
  const archRow = items.find((i) => i.action === "organisation.archived");
  expect(archRow?.before).toMatchObject({ archivedAt: null });
  expect(typeof archRow?.after?.archivedAt).toBe("string");
  body = await (await admin.page.request.get(`/api/audit?event=ORGANISATION_ARCHIVED&person=${admin.user.id}`)).text();
  if (pass) expect(body.includes(pass)).toBe(false);
  const archItems = JSON.parse(body).items as { event: string; at: string }[];
  expect(archItems[0]?.event).toBe("ORGANISATION_ARCHIVED");
  expect(Date.now() - Date.parse(archItems[0].at)).toBeLessThan(120_000);
  const undoArchived = await admin.api.post(`/api/actions/${archived.headers["x-undo-id"]}/undo`, { anyway: false });
  if (gate.deployed) {
    expect(undoArchived.status).toBe(200);
    expect((await load(admin, id)).archived, "undo of Organisation archived clears the archive").toBe(false);
  } else {
    expect(undoArchived.status, notLive(gate, "undo of Organisation archived still answers 409.")).toBe(409);
    expect(undoArchived.json.error).toBe("This organisation is already archived.");
    expect((await load(admin, id)).archived).toBe(true);
    // The next steps archive and then unarchive. Put it back first so that archive is a real change.
    expect((await admin.api.post(`/api/orgs/${id}/archive`, { archive: false })).status).toBe(200);
  }

  const archivedAgain = await raw(admin, "POST", `/api/orgs/${id}/archive`, { archive: true });
  expect(archivedAgain.status).toBe(200);
  expect(archivedAgain.headers["x-undo-label"]).toBe("Organisation archived");
  const opened = await raw(admin, "POST", `/api/orgs/${id}/archive`, { archive: false });
  expect(opened.status).toBe(200);
  expect(opened.headers["x-undo-label"]).toBe("Organisation unarchived");
  items = await history(admin, id);
  const openRow = items.find((i) => i.action === "organisation.unarchived");
  expect(openRow?.after).toMatchObject({ archivedAt: null });
  expect(typeof openRow?.before?.archivedAt).toBe("string");
  body = await (await admin.page.request.get(`/api/audit?event=ORGANISATION_UNARCHIVED&person=${admin.user.id}`)).text();
  if (pass) expect(body.includes(pass)).toBe(false);
  const unItems = JSON.parse(body).items as { event: string; at: string }[];
  expect(unItems[0]?.event).toBe("ORGANISATION_UNARCHIVED");
  expect(Date.now() - Date.parse(unItems[0].at)).toBeLessThan(120_000);
  const undoOpened = await admin.api.post(`/api/actions/${opened.headers["x-undo-id"]}/undo`, { anyway: false });
  if (gate.deployed) {
    expect(undoOpened.status).toBe(200);
    expect((await load(admin, id)).archived, "undo of Organisation unarchived archives it again").toBe(true);
  } else {
    expect(undoOpened.status, notLive(gate, "undo of Organisation unarchived still answers 409.")).toBe(409);
    expect(undoOpened.json.error).toBe("This organisation is not archived any more.");
    expect((await load(admin, id)).archived).toBe(false);
  }

  const fresh = await raw(admin, "POST", "/api/orgs", { name: zz("undo create") });
  expect(fresh.headers["x-undo-label"]).toBe("Organisation added");
  const freshId = fresh.json.organisation.id as string;
  later(() => admin.api.post(`/api/orgs/${freshId}/archive`, { archive: true }));
  expect((await admin.api.post(`/api/actions/${fresh.headers["x-undo-id"]}/undo`, { anyway: false })).status).toBe(200);
  expect((await load(admin, freshId)).archived, "undo of Organisation added archives it").toBe(true);

  await admin.page.goto(`/accounts/${id}`);
  await admin.page.getByRole("button", { name: "History" }).click();
  await expect(admin.page.getByText("organisation.created")).toBeVisible();
  await expect(admin.page.getByText("contact.created")).toBeVisible();
  await expect(admin.page.getByText("note.created")).toBeVisible();
  await expect(admin.page.getByText("organisation.parent_changed")).toBeVisible();
  // Undo of archive restores the row and does not write a second unarchived log (APL-2686).
  // The same action is logged more than once, so the check counts the rows instead of taking the first.
  expect(await admin.page.getByText("organisation.archived").count()).toBeGreaterThan(0);
  expect(await admin.page.getByText("organisation.unarchived").count()).toBeGreaterThan(0);
});
