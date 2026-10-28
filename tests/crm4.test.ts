// CRM slice 4: contacts (11.2), notes (11.3), task links (11.4), organisation page data (11.5), Undo for CRM records.
import { describe, expect, it } from "vitest";
import { account, admin, istDate, project, superAdmin, task, type Account } from "./helpers";

let seq = 0;
const newOrg = async (a: Account, extra: Record<string, unknown> = {}) => (await a.c.post("/api/orgs", { force: true, name: `Org4 ${Date.now()}-${seq++}`, ...extra })).json.organisation.id as string;
const contact = async (a: Account, org: string, name = `Person ${seq++}`, extra: Record<string, unknown> = {}) => {
  const r = await a.c.post(`/api/orgs/${org}/contacts`, { name, ...extra });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.contact.id as string;
};
async function deal(a: Account, org: string, members: { who: Account; role: string }[] = []) {
  const pr = (await a.c.get("/api/deals/pipelines")).json.pipelines[0];
  const r = await a.c.post("/api/deals", { name: `D4 ${Date.now()}-${seq++}`, organisationId: org, pipelineId: pr.id, leaderId: a.id, whyPursue: "fit", nextStep: { title: "n", dueDate: istDate(3) } });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  for (const m of members) expect((await a.c.post(`/api/projects/${r.json.deal.id}/members`, { userId: m.who.id, role: m.role })).status).toBe(201);
  return r.json.deal.id as string;
}
const undo = (a: Account, res: { headers: Headers }) => a.c.post(`/api/actions/${res.headers.get("x-undo-id")}/undo`);

describe("contacts (11.2)", () => {
  it("lets any Member add and see contacts, defaults Known by to the creator, and refuses bad input", async () => {
    const a = await account("ca");
    const outsider = await account("cout"); // in no project
    const org = await newOrg(a);
    const id = await contact(a, org, "Asha Rao", { role: "Director", email: "asha@example.org", phone: "+91 99999" });
    const list = (await outsider.c.get(`/api/orgs/${org}/contacts`)).json.contacts;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id, name: "Asha Rao", role: "Director", knownBy: [{ id: a.id, name: "Ca", active: true }], lastSpoke: null });
    expect((await a.c.post(`/api/orgs/${org}/contacts`, { name: " " })).status).toBe(400);
    expect((await a.c.post(`/api/orgs/${org}/contacts`, { name: "X", email: "not-an-email" })).status).toBe(400);
    expect((await a.c.post(`/api/orgs/${org}/contacts`, { name: "X", knownBy: ["nobody"] })).status).toBe(400);
  });

  it("lets only the creator and Admins edit or remove, and undoes", async () => {
    const sa = await superAdmin();
    const ad = await admin(sa);
    const a = await account("cc");
    const other = await account("cother");
    const org = await newOrg(a);
    const id = await contact(a, org, "Ravi");
    expect((await other.c.patch(`/api/contacts/${id}`, { role: "x" })).status).toBe(403);
    expect((await other.c.del(`/api/contacts/${id}`)).status).toBe(403);
    const ed = await a.c.patch(`/api/contacts/${id}`, { role: "CEO", knownBy: [a.id, other.id] });
    expect(ed.status).toBe(200);
    expect(ed.headers.get("x-undo-label")).toBe("Contact edited");
    expect((await a.c.get(`/api/orgs/${org}/contacts`)).json.contacts[0].knownBy).toHaveLength(2);
    expect((await undo(a, ed)).status).toBe(200);
    const back = (await a.c.get(`/api/orgs/${org}/contacts`)).json.contacts[0];
    expect(back.role).toBeNull();
    expect(back.knownBy).toHaveLength(1);
    const rm = await ad.c.del(`/api/contacts/${id}`);
    expect(rm.status).toBe(204);
    expect((await a.c.get(`/api/orgs/${org}/contacts`)).json.contacts).toHaveLength(0);
    expect((await undo(ad, rm)).status).toBe(200);
    expect((await a.c.get(`/api/orgs/${org}/contacts`)).json.contacts).toHaveLength(1);
  });

  it("refuses new contacts on an archived organisation and hides removed contacts from search", async () => {
    const a = await account("carch");
    const org = await newOrg(a);
    const id = await contact(a, org, `Findme${Date.now()}`);
    const name = (await a.c.get(`/api/orgs/${org}/contacts`)).json.contacts[0].name as string;
    expect((await a.c.get(`/api/search?q=${name}`)).json.contacts.map((c: { id: string }) => c.id)).toContain(id);
    await a.c.del(`/api/contacts/${id}`);
    expect((await a.c.get(`/api/search?q=${name}`)).json.contacts).toHaveLength(0);
    await a.c.post(`/api/orgs/${org}/archive`, { archive: true });
    expect((await a.c.post(`/api/orgs/${org}/contacts`, { name: "Late" })).status).toBe(409);
  });
});

describe("notes (11.3)", () => {
  it("lists organisation notes newest first and adds Last spoke from the newest visible note", async () => {
    const a = await account("na");
    const org = await newOrg(a);
    const c = await contact(a, org, "Meera");
    await a.c.post(`/api/orgs/${org}/notes`, { kind: "CALL", date: istDate(-5), text: "Older call", contactIds: [c] });
    await a.c.post(`/api/orgs/${org}/notes`, { kind: "MEETING", date: istDate(-1), text: "Newer meeting", contactIds: [c] });
    const notes = (await a.c.get(`/api/orgs/${org}/notes`)).json.notes;
    expect(notes.map((n: { text: string }) => n.text)).toEqual(["Newer meeting", "Older call"]);
    expect((await a.c.get(`/api/orgs/${org}/contacts`)).json.contacts[0].lastSpoke).toBe(istDate(-1));
    expect((await a.c.post(`/api/orgs/${org}/notes`, { kind: "CALL", date: istDate(0), text: " " })).status).toBe(400);
    expect((await a.c.post(`/api/orgs/${org}/notes`, { kind: "CALL", date: "nope", text: "x" })).status).toBe(400);
  });

  it("shows a deal note only to deal members and Admins, never counts it in Last spoke for others", async () => {
    const sa = await superAdmin();
    const ad = await admin(sa);
    const lead = await account("nlead");
    const member = await account("nmember");
    const stranger = await account("nstranger");
    const org = await newOrg(lead);
    const c = await contact(lead, org, "Sam");
    const d = await deal(lead, org, [{ who: member, role: "VIEWER" }]);
    await lead.c.post(`/api/orgs/${org}/notes`, { kind: "MEETING", date: istDate(-2), text: "Public note", contactIds: [c] });
    await lead.c.post(`/api/orgs/${org}/notes`, { kind: "CALL", date: istDate(-1), text: "Deal-only note", projectId: d, contactIds: [c] });
    const texts = async (a: Account) => ((await a.c.get(`/api/orgs/${org}/notes`)).json.notes as { text: string }[]).map((n) => n.text);
    expect(await texts(lead)).toEqual(["Deal-only note", "Public note"]);
    expect(await texts(member)).toEqual(["Deal-only note", "Public note"]);
    expect(await texts(ad)).toContain("Deal-only note");
    expect(await texts(stranger)).toEqual(["Public note"]);
    const last = async (a: Account) => (await a.c.get(`/api/orgs/${org}/contacts`)).json.contacts[0].lastSpoke;
    expect(await last(lead)).toBe(istDate(-1));
    expect(await last(stranger)).toBe(istDate(-2));
    // The deal page lists its own notes, to members only.
    expect(((await member.c.get(`/api/projects/${d}/notes`)).json.notes as unknown[]).length).toBe(1);
    expect((await stranger.c.get(`/api/projects/${d}/notes`)).status).toBe(404);
    // A stranger cannot attach a note to the deal.
    expect((await stranger.c.post(`/api/orgs/${org}/notes`, { kind: "CALL", date: istDate(0), text: "sneaky", projectId: d })).status).toBe(404);
  });

  it("refuses a deal of another organisation, a plain project, and contacts of another organisation", async () => {
    const a = await account("nbad");
    const org = await newOrg(a);
    const other = await newOrg(a);
    const d = await deal(a, other);
    const p = await project(a, a);
    const stranger = await contact(a, other, "Elsewhere");
    const post = (extra: Record<string, unknown>) => a.c.post(`/api/orgs/${org}/notes`, { kind: "OTHER", date: istDate(0), text: "x", ...extra });
    expect((await post({ projectId: d })).status).toBe(400);
    expect((await post({ projectId: p.id })).status).toBe(400);
    expect((await post({ contactIds: [stranger] })).status).toBe(400);
  });

  it("deletes by author, deal Leader or Admin, with Undo and no Trash", async () => {
    const lead = await account("dlead4");
    const author = await account("dauthor4");
    const other = await account("dother4");
    const org = await newOrg(lead);
    const d = await deal(lead, org, [{ who: author, role: "EDITOR" }, { who: other, role: "EDITOR" }]);
    const mk = async () => (await author.c.post(`/api/orgs/${org}/notes`, { kind: "CALL", date: istDate(0), text: "n", projectId: d })).json.note.id as string;
    const n1 = await mk();
    expect((await other.c.del(`/api/notes/${n1}`)).status).toBe(403);
    const del = await author.c.del(`/api/notes/${n1}`);
    expect(del.status).toBe(204);
    expect(del.headers.get("x-undo-label")).toBe("Note deleted");
    expect((await lead.c.get(`/api/orgs/${org}/notes`)).json.notes).toHaveLength(0);
    expect((await undo(author, del)).status).toBe(200);
    expect((await lead.c.get(`/api/orgs/${org}/notes`)).json.notes).toHaveLength(1);
    // The deal's Leader may delete someone else's note.
    expect((await lead.c.del(`/api/notes/${n1}`)).status).toBe(204);
  });
});

describe("task links (11.4)", () => {
  it("links an organisation or contact, shows it on the task, lists the task on their pages by membership, and removing leaves the task", async () => {
    const lead = await account("llead");
    const viewer = await account("lview");
    const outsider = await account("lout");
    const p = await project(lead, lead, [{ who: viewer, role: "VIEWER" }]);
    const org = await newOrg(lead);
    const c = await contact(lead, org, "Linked");
    const t = await task(lead, p.id, { title: "Follow up with Linked" });
    const l1 = await lead.c.post(`/api/tasks/${t}/links`, { organisationId: org });
    const l2 = await lead.c.post(`/api/tasks/${t}/links`, { contactId: c });
    expect(l1.status).toBe(201);
    expect(l2.status).toBe(201);
    expect((await lead.c.post(`/api/tasks/${t}/links`, { organisationId: org })).status).toBe(409);
    expect((await lead.c.post(`/api/tasks/${t}/links`, {})).status).toBe(400);
    expect((await lead.c.post(`/api/tasks/${t}/links`, { organisationId: org, contactId: c })).status).toBe(400);
    expect((await viewer.c.post(`/api/tasks/${t}/links`, { organisationId: org })).status).toBe(403);
    const shown = (await viewer.c.get(`/api/tasks/${t}`)).json.task.links;
    expect(shown).toHaveLength(2);
    const titles = async (a: Account) => ((await a.c.get(`/api/orgs/${org}`)).json.organisation.tasks as { title: string }[]).map((x) => x.title);
    expect(await titles(lead)).toEqual(["Follow up with Linked"]);
    expect(await titles(viewer)).toEqual(["Follow up with Linked"]);
    expect(await titles(outsider)).toEqual([]); // AC4: not a member of that project
    expect(((await lead.c.get(`/api/contacts/${c}`)).json.contact.tasks as unknown[]).length).toBe(1);
    expect(((await outsider.c.get(`/api/contacts/${c}`)).json.contact.tasks as unknown[]).length).toBe(0);
    // Removing a link leaves the task.
    const rm = await lead.c.del(`/api/tasks/${t}/links/${l1.json.link.id}`);
    expect(rm.status).toBe(204);
    expect((await lead.c.get(`/api/tasks/${t}`)).json.task.links).toHaveLength(1);
    expect((await undo(lead, rm)).status).toBe(200);
    expect((await lead.c.get(`/api/tasks/${t}`)).json.task.links).toHaveLength(2);
  });

  it("leaves Trash and archived projects out of the lists", async () => {
    const lead = await account("ltrash");
    const p = await project(lead, lead);
    const p2 = await project(lead, lead);
    const org = await newOrg(lead);
    const t1 = await task(lead, p.id, { title: "To trash" });
    const t2 = await task(lead, p2.id, { title: "In archived" });
    await lead.c.post(`/api/tasks/${t1}/links`, { organisationId: org });
    await lead.c.post(`/api/tasks/${t2}/links`, { organisationId: org });
    const n = async () => ((await lead.c.get(`/api/orgs/${org}`)).json.organisation.tasks as unknown[]).length;
    expect(await n()).toBe(2);
    await lead.c.del(`/api/tasks/${t1}`);
    expect(await n()).toBe(1);
    await lead.c.post(`/api/projects/${p2.id}/archive`);
    expect(await n()).toBe(0);
  });
});

describe("organisation page and Undo for CRM records (11.5)", () => {
  it("returns the whole tree from the root, contacts, notes and deals in one call", async () => {
    const a = await account("tree4");
    const root = await newOrg(a);
    const mid = await newOrg(a, { parentId: root });
    const leaf = await newOrg(a, { parentId: mid });
    await contact(a, leaf, "Leafy");
    const d = await deal(a, leaf);
    const got = (await a.c.get(`/api/orgs/${leaf}`)).json.organisation;
    expect(got.tree.id).toBe(root);
    expect(got.tree.children[0].id).toBe(mid);
    expect(got.tree.children[0].children[0].id).toBe(leaf);
    expect(got.contacts).toHaveLength(1);
    expect(got.deals.map((x: { projectId: string }) => x.projectId)).toEqual([d]);
    expect(Array.isArray(got.notes)).toBe(true);
  });

  it("finds organisations and contacts in Search", async () => {
    const a = await account("srch");
    const tag = `Quokka${Date.now()}`;
    const org = await newOrg(a, { kind: "Ministry" });
    await a.c.patch(`/api/orgs/${org}`, { name: `${tag} Ministry` });
    const c = await contact(a, org, `${tag} Contact`);
    const r = (await a.c.get(`/api/search?q=${tag}`)).json;
    expect(r.organisations.map((x: { id: string }) => x.id)).toEqual([org]);
    expect(r.contacts.map((x: { id: string }) => x.id)).toEqual([c]);
  });

  it("undoes organisation changes (create archives, edit restores)", async () => {
    const a = await account("orgundo");
    const made = await a.c.post("/api/orgs", { force: true, name: `Undo me ${Date.now()}` });
    expect(made.headers.get("x-undo-label")).toBe("Organisation added");
    const id = made.json.organisation.id as string;
    const ed = await a.c.patch(`/api/orgs/${id}`, { country: "Kenya" });
    expect(ed.status).toBe(200);
    expect((await undo(a, ed)).status).toBe(200);
    expect((await a.c.get(`/api/orgs/${id}`)).json.organisation.country).toBeNull();
    expect((await undo(a, made)).status).toBe(200);
    expect((await a.c.get(`/api/orgs/${id}`)).json.organisation.archived).toBe(true);
    // Someone else cannot undo it; the same action cannot be undone twice.
    const other = await account("orgother");
    const again = await a.c.post(`/api/actions/${made.headers.get("x-undo-id")}/undo`);
    expect(again.status).toBe(409);
    expect((await other.c.post(`/api/actions/${made.headers.get("x-undo-id")}/undo`)).status).toBe(403);
  });
});
