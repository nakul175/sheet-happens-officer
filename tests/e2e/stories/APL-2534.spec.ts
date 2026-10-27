// SHO-US-11.3 Notes on organisations and deals (APL-2534).
// Pam left no qa:TC id. Each title says qa:TC missing. The annotation is qa:TC with description missing. An AC number is not a TC id.
// One test per acceptance criterion. ZZ-TEST organisations, contacts, notes and deals are archived or removed afterwards.
// The plain Member is the person who is not on the deal until a test adds them.
// There is no tests/e2e/jim-gate.ts. CRM_VISIBLE is read from the live /api/orgs answer, never a hard skip.
// A note cannot be aged 30 days from a browser session, so AC3 undoes a new row. workers is 1. Traces stay off.
import { expect, test, zz } from "../support";
import { gateFile } from "../helpers/qa-alias";
import { noteRow, rowAround, statusText } from "../helpers/locate";

gateFile();
import { newProject, ymd, type Who } from "../g2";
import { raw } from "../helpers/jim-http";
import type { Page } from "@playwright/test";

type Later = (fn: () => Promise<unknown>) => void;
type Note = { id: string; text: string; date: string; canDelete: boolean };

test.beforeEach(async ({ admin }) => {
  const r = await admin.api.get("/api/orgs");
  expect(r.status, "CRM is hidden for the Super Admin on this server (CRM_VISIBLE is off). /api/orgs answered 404.").toBe(200);
});
async function memberCrm(member: Who) {
  const r = await member.api.get("/api/orgs");
  expect(r.status, "CRM is hidden for the plain Member on this server (CRM_VISIBLE=admins). /api/orgs answered 404.").toBe(200);
}

async function makeOrg(who: Who, later: Later, label: string) {
  const name = zz(label);
  const r = await who.api.post("/api/orgs", { name });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = r.json.organisation.id as string;
  later(() => who.api.post(`/api/orgs/${id}/archive`, { archive: true }));
  return { id, name };
}

async function proactive(who: Who) {
  const r = await who.api.get("/api/deals/pipelines");
  expect(r.status).toBe(200);
  const pipe = (r.json.pipelines as { id: string; key: string }[]).find((p) => p.key === "DEAL_PROACTIVE");
  expect(pipe, "the Proactive pipeline").toBeTruthy();
  return pipe!;
}

async function makeDeal(who: Who, later: Later, orgId: string, label: string) {
  const pipe = await proactive(who);
  const name = zz(label);
  const r = await who.api.post("/api/deals", {
    name, organisationId: orgId, pipelineId: pipe.id, leaderId: who.user.id, whyPursue: "ZZ-TEST fit",
    nextStep: { title: zz(`step ${label}`), dueDate: ymd(7) },
  });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = r.json.deal.id as string;
  later(() => who.api.post(`/api/projects/${id}/archive`));
  return { id, name };
}

const notesOf = async (who: Who, orgId: string) => (await who.api.get(`/api/orgs/${orgId}/notes`)).json.notes as Note[];

const spokeLabel = (page: Page, iso: string) => page.evaluate(
  (d) => new Date(`${d}T00:00:00+05:30`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" }),
  iso,
);

// qa:TC missing
test("AC1: a saved note appears on the organisation timeline, newest first qa:TC missing", async ({ admin, later }) => {
  test.setTimeout(120_000);
  const org = await makeOrg(admin, later, "timeline");
  const newer = zz("newer meeting");
  const older = zz("older call");
  await admin.page.goto(`/accounts/${org.id}`);
  await expect(admin.page.getByRole("heading", { name: org.name })).toBeVisible();
  await expect(admin.page.getByRole("button", { name: "Add note" })).toBeDisabled();
  await admin.page.getByLabel("Kind").selectOption("MEETING");
  await admin.page.getByLabel("Date").fill(ymd(-1));
  await admin.page.getByLabel("Note").fill(newer);
  await admin.page.getByRole("button", { name: "Add note" }).click();
  await expect(noteRow(admin.page, newer)).toBeVisible();
  await expect(noteRow(admin.page, newer).getByText("Meeting", { exact: true })).toBeVisible();
  await expect(statusText(admin.page, "Note added")).toBeVisible();

  const old = await admin.api.post(`/api/orgs/${org.id}/notes`, { kind: "CALL", date: ymd(-8), text: older });
  expect(old.status).toBe(201);
  const blank = await admin.api.post(`/api/orgs/${org.id}/notes`, { kind: "CALL", date: ymd(0), text: " " });
  expect(blank.status).toBe(400);
  const badDate = await admin.api.post(`/api/orgs/${org.id}/notes`, { kind: "CALL", date: "nope", text: older });
  expect(badDate.status).toBe(400);

  const texts = (await notesOf(admin, org.id)).map((n) => n.text);
  expect(texts).toEqual([newer, older]);
  await admin.page.reload();
  const y = async (text: string) => (await noteRow(admin.page, text).boundingBox())!.y;
  expect(await y(newer)).toBeLessThan(await y(older));
  await expect(noteRow(admin.page, older).getByText("Call", { exact: true })).toBeVisible();
});
// qa:TC missing
test("AC2: a deal note appears on the deal page for deal members and Admins only, a note with no deal is visible with the organisation, and the deal and contacts must belong to this organisation qa:TC missing", async ({ admin, member, later }) => {
  test.setTimeout(180_000);
  await memberCrm(member);
  const org = await makeOrg(admin, later, "note org");
  const other = await makeOrg(admin, later, "other org");
  const contactName = zz("same org contact");
  const contact = await admin.api.post(`/api/orgs/${org.id}/contacts`, { name: contactName });
  expect(contact.status).toBe(201);
  const contactId = contact.json.contact.id as string;
  later(() => admin.api.del(`/api/contacts/${contactId}`));
  const foreignName = zz("other org contact");
  const foreign = await admin.api.post(`/api/orgs/${other.id}/contacts`, { name: foreignName });
  expect(foreign.status).toBe(201);
  later(() => admin.api.del(`/api/contacts/${foreign.json.contact.id}`));
  const deal = await makeDeal(admin, later, org.id, "note deal");
  const otherDeal = await makeDeal(admin, later, other.id, "other deal");
  const plain = await newProject(admin, later, { label: "plain project" });

  const post = (extra: Record<string, unknown>) => admin.api.post(`/api/orgs/${org.id}/notes`, { kind: "OTHER", date: ymd(0), text: zz("refused"), ...extra });
  const wrongDeal = await post({ projectId: otherDeal.id });
  expect(wrongDeal.status).toBe(400);
  expect(wrongDeal.json.error).toContain("does not involve this organisation");
  const wrongProject = await post({ projectId: plain.id });
  expect(wrongProject.status).toBe(400);
  expect(wrongProject.json.error).toContain("only be linked to a deal");
  const wrongContact = await post({ contactIds: [foreign.json.contact.id] });
  expect(wrongContact.status).toBe(400);
  expect(wrongContact.json.error).toContain("contacts of this organisation");
  const sneak = await member.api.post(`/api/orgs/${org.id}/notes`, { kind: "CALL", date: ymd(0), text: zz("sneaky"), projectId: deal.id });
  expect(sneak.status).toBe(404);

  const publicText = zz("public note");
  expect((await admin.api.post(`/api/orgs/${org.id}/notes`, { kind: "CALL", date: ymd(-9), text: publicText, contactIds: [contactId] })).status).toBe(201);

  const newest = zz("newest deal note");
  const olderTexts: string[] = [];
  for (let i = 1; i <= 5; i++) {
    const text = zz(`deal note ${i}`);
    olderTexts.push(text);
    expect((await admin.api.post(`/api/orgs/${org.id}/notes`, { kind: "CALL", date: ymd(-i), text, projectId: deal.id })).status).toBe(201);
  }
  await admin.page.goto(`/accounts/${org.id}`);
  await admin.page.getByLabel("Kind").selectOption("MEETING");
  await admin.page.getByLabel("Date").fill(ymd(0));
  await admin.page.getByLabel("Deal", { exact: true }).selectOption({ label: deal.name });
  await admin.page.getByRole("checkbox", { name: contactName, exact: true }).check();
  await admin.page.getByLabel("Note").fill(newest);
  await admin.page.getByRole("button", { name: "Add note" }).click();
  const onOrg = noteRow(admin.page, newest);
  await expect(onOrg).toBeVisible();
  await expect(onOrg).toContainText(`With ${contactName}`);
  await expect(onOrg.getByRole("link", { name: deal.name })).toBeVisible();

  const dealNotes = (await admin.api.get(`/api/projects/${deal.id}/notes`)).json.notes as { text: string }[];
  expect(dealNotes.map((n) => n.text)).toEqual([newest, ...olderTexts]);
  await admin.page.goto(`/projects/${deal.id}`);
  const addNote = admin.page.getByRole("link", { name: "Add a note on the organisation page" });
  await expect(addNote).toHaveAttribute("href", `/accounts/${org.id}`);
  await expect(admin.page.getByRole("button", { name: "Add note" })).toHaveCount(0);
  const noteText = (text: string) => admin.page.getByRole("main").getByText(text, { exact: true });
  await expect(noteText(newest)).toBeVisible();
  await expect(admin.page.getByRole("main").getByText(`with ${contactName}`)).toBeVisible();
  for (const text of olderTexts.slice(0, 4)) await expect(noteText(text)).toBeVisible();
  await expect(noteText(olderTexts[4])).toHaveCount(0);
  await expect(noteText(publicText)).toHaveCount(0);
  const newestY = (await noteText(newest).boundingBox())!.y;
  const secondY = (await noteText(olderTexts[0]).boundingBox())!.y;
  expect(newestY).toBeLessThan(secondY);

  expect((await member.api.get(`/api/projects/${deal.id}`)).status).toBe(404);
  expect((await member.api.get(`/api/projects/${deal.id}/notes`)).status).toBe(404);
  const memberTexts = (await notesOf(member, org.id)).map((n) => n.text);
  expect(memberTexts).toEqual([publicText]);
  await member.page.goto(`/accounts/${org.id}`);
  await expect(noteRow(member.page, publicText)).toBeVisible();
  await expect(member.page.getByText(newest, { exact: true })).toHaveCount(0);
  await admin.page.goto(`/accounts/${org.id}`);
  await expect(noteRow(admin.page, newest)).toBeVisible();
  await expect(noteRow(admin.page, publicText)).toBeVisible();

  expect((await admin.api.post(`/api/projects/${deal.id}/members`, { userId: member.user.id, role: "VIEWER" })).status).toBe(201);
  expect((await notesOf(member, org.id)).map((n) => n.text)).toContain(newest);
  expect((await member.api.get(`/api/projects/${deal.id}/notes`)).status).toBe(200);
  await member.page.goto(`/projects/${deal.id}`);
  await expect(member.page.getByText(newest, { exact: true })).toBeVisible();
  await member.page.goto(`/accounts/${org.id}`);
  await expect(noteRow(member.page, newest)).toBeVisible();
  await expect(noteRow(member.page, publicText)).toBeVisible();
});

// qa:TC missing
test("AC3: the author, the deal's Leader or an Admin deletes a note, Note deleted can be undone, and there is no Trash for notes qa:TC missing", async ({ admin, member, later }) => {
  test.setTimeout(180_000);
  await memberCrm(member);
  const org = await makeOrg(admin, later, "delete notes");
  const deal = await makeDeal(admin, later, org.id, "delete deal");
  const adminText = zz("admin note");
  const adminNote = await admin.api.post(`/api/orgs/${org.id}/notes`, { kind: "CALL", date: ymd(-1), text: adminText, projectId: deal.id });
  expect(adminNote.status).toBe(201);
  const adminNoteId = adminNote.json.note.id as string;

  expect((await member.api.del(`/api/notes/${adminNoteId}`)).status, "not a deal member, so the note is not found").toBe(404);
  expect((await admin.api.post(`/api/projects/${deal.id}/members`, { userId: member.user.id, role: "EDITOR" })).status).toBe(201);
  const refused = await member.api.del(`/api/notes/${adminNoteId}`);
  expect(refused.status).toBe(403);
  expect(refused.json.error).toContain("Only the author, the deal's Leader or an Admin");
  expect((await notesOf(admin, org.id)).some((n) => n.id === adminNoteId)).toBe(true);
  await member.page.goto(`/accounts/${org.id}`);
  await expect(noteRow(member.page, adminText).getByRole("button", { name: "Delete" })).toHaveCount(0);
  await expect(member.page.getByRole("link", { name: "Trash" })).toHaveCount(0);

  const ownText = zz("member note");
  const own = await raw(member, "POST", `/api/orgs/${org.id}/notes`, { kind: "MEETING", date: ymd(0), text: ownText, projectId: deal.id });
  expect(own.status).toBe(201);
  expect(own.headers["x-undo-label"]).toBe("Note added");
  const ownId = own.json.note.id as string;
  await member.page.reload();
  await expect(noteRow(member.page, ownText).getByRole("button", { name: "Delete" })).toBeVisible();
  const removed = await raw(member, "DELETE", `/api/notes/${ownId}`);
  expect(removed.status).toBe(204);
  expect(removed.headers["x-undo-label"]).toBe("Note deleted");
  expect((await notesOf(admin, org.id)).some((n) => n.id === ownId)).toBe(false);
  const trash = (await admin.api.get(`/api/projects/${deal.id}/trash`)).json.items as { title: string }[];
  expect(trash.some((t) => t.title.includes(ownText))).toBe(false);
  await admin.page.goto(`/projects/${deal.id}/trash`);
  await expect(admin.page.getByRole("heading", { name: "Trash" })).toBeVisible();
  await expect(admin.page.getByText("Trash is empty.").or(admin.page.getByRole("table"))).toBeVisible();
  await expect(admin.page.getByRole("cell", { name: ownText })).toHaveCount(0);
  const notMine = await admin.api.post(`/api/actions/${removed.headers["x-undo-id"]}/undo`, { anyway: false });
  // The Super Admin may undo someone else's row. A plain Member may not, checked on the Admin's delete below.
  expect(notMine.status).toBe(200);
  expect((await notesOf(member, org.id)).some((n) => n.id === ownId)).toBe(true);

  await member.page.goto(`/accounts/${org.id}`);
  await noteRow(member.page, ownText).getByRole("button", { name: "Delete" }).click();
  await expect(member.page.getByText(ownText, { exact: true })).toHaveCount(0);
  await expect(statusText(member.page, "Note deleted")).toBeVisible();
  await statusText(member.page, "Note deleted").getByRole("button", { name: "Undo" }).click();
  await expect(noteRow(member.page, ownText)).toBeVisible();

  expect((await admin.api.post(`/api/projects/${deal.id}/leader`, { newLeaderId: member.user.id, previousRole: "EDITOR" })).status).toBe(200);
  const leaderText = zz("leader may delete");
  const leaderNote = await admin.api.post(`/api/orgs/${org.id}/notes`, { kind: "OTHER", date: ymd(-2), text: leaderText, projectId: deal.id });
  expect(leaderNote.status).toBe(201);
  const byLeader = await raw(member, "DELETE", `/api/notes/${leaderNote.json.note.id}`);
  expect(byLeader.status, "the deal's Leader deletes another person's note").toBe(204);
  expect(byLeader.headers["x-undo-label"]).toBe("Note deleted");
  expect((await member.api.post(`/api/actions/${byLeader.headers["x-undo-id"]}/undo`, { anyway: false })).status).toBe(200);

  const adminDeletes = zz("admin deletes");
  const third = await member.api.post(`/api/orgs/${org.id}/notes`, { kind: "CALL", date: ymd(-3), text: adminDeletes, projectId: deal.id });
  expect(third.status).toBe(201);
  const byAdmin = await raw(admin, "DELETE", `/api/notes/${third.json.note.id}`);
  expect(byAdmin.status).toBe(204);
  expect(byAdmin.headers["x-undo-label"]).toBe("Note deleted");
  const memberUndo = await member.api.post(`/api/actions/${byAdmin.headers["x-undo-id"]}/undo`, { anyway: false });
  expect(memberUndo.status).toBe(403);
  expect(memberUndo.json.error).toContain("your own actions");
  expect((await notesOf(admin, org.id)).some((n) => n.text === adminDeletes)).toBe(false);
  expect((await admin.api.post(`/api/actions/${byAdmin.headers["x-undo-id"]}/undo`, { anyway: false })).status).toBe(200);
  expect((await notesOf(member, org.id)).some((n) => n.text === adminDeletes)).toBe(true);
  await admin.page.goto(`/accounts/${org.id}`);
  await expect(admin.page.getByRole("link", { name: "Trash" })).toHaveCount(0);
});

// qa:TC missing
test("AC4: a note on a deal the viewer cannot see is never shown on the organisation page and never counted in Last spoke qa:TC missing", async ({ admin, member, later }) => {
  test.setTimeout(180_000);
  await memberCrm(member);
  const org = await makeOrg(admin, later, "hidden note");
  const contactName = zz("hidden contact");
  const contact = await admin.api.post(`/api/orgs/${org.id}/contacts`, { name: contactName });
  expect(contact.status).toBe(201);
  const contactId = contact.json.contact.id as string;
  later(() => admin.api.del(`/api/contacts/${contactId}`));
  const deal = await makeDeal(admin, later, org.id, "hidden deal");
  const older = ymd(-6);
  const newer = ymd(-1);
  const publicText = zz("visible call");
  const hiddenText = zz("hidden deal note");
  expect((await admin.api.post(`/api/orgs/${org.id}/notes`, { kind: "CALL", date: older, text: publicText, contactIds: [contactId] })).status).toBe(201);
  expect((await admin.api.post(`/api/orgs/${org.id}/notes`, { kind: "MEETING", date: newer, text: hiddenText, projectId: deal.id, contactIds: [contactId] })).status).toBe(201);

  const last = async (who: Who) => (await who.api.get(`/api/orgs/${org.id}/contacts`)).json.contacts.find((c: { id: string }) => c.id === contactId).lastSpoke as string | null;
  expect(await last(admin)).toBe(newer);
  expect(await last(member)).toBe(older);
  expect((await notesOf(member, org.id)).map((n) => n.text)).toEqual([publicText]);
  expect((await notesOf(admin, org.id)).map((n) => n.text)).toEqual([hiddenText, publicText]);

  await member.page.goto(`/accounts/${org.id}`);
  await expect(noteRow(member.page, publicText)).toBeVisible();
  await expect(member.page.getByText(hiddenText, { exact: true })).toHaveCount(0);
  const memberRow = rowAround(member.page, contactName);
  await expect(memberRow).toContainText(`Last spoke: ${await spokeLabel(member.page, older)}`);
  await admin.page.goto(`/accounts/${org.id}`);
  await expect(noteRow(admin.page, hiddenText)).toBeVisible();
  const adminRow = rowAround(admin.page, contactName);
  await expect(adminRow).toContainText(`Last spoke: ${await spokeLabel(admin.page, newer)}`);

  expect((await admin.api.post(`/api/projects/${deal.id}/members`, { userId: member.user.id, role: "VIEWER" })).status).toBe(201);
  expect(await last(member)).toBe(newer);
  expect((await notesOf(member, org.id)).map((n) => n.text)).toContain(hiddenText);
  await member.page.reload();
  await expect(noteRow(member.page, hiddenText)).toBeVisible();
  await expect(memberRow).toContainText(`Last spoke: ${await spokeLabel(member.page, newer)}`);
});
