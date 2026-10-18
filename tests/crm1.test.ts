// Integration tests for CRM slice 1: types, pipelines, organisations, deals, stages (SHO-US-10.1 to 10.4, 11.1, 12.1, 12.3).
// Server must run with SUPER_ADMIN_EMAILS=root.test@aplyd.com and the same EMAIL_OUTBOX_DIR.
import { describe, expect, it } from "vitest";
import { account, admin, istDate, project, superAdmin, task, type Account, withVersion } from "./helpers";

let seq = 0;
async function pipelines(a: Account) {
  const r = await a.c.get("/api/deals/pipelines");
  expect(r.status).toBe(200);
  const proactive = r.json.pipelines.find((p: { key: string }) => p.key === "DEAL_PROACTIVE");
  const bid = r.json.pipelines.find((p: { key: string }) => p.key === "DEAL_BID");
  return { proactive, bid };
}
async function org(a: Account, name = `Org ${Date.now()}-${seq++}`, extra: Record<string, unknown> = {}) {
  const r = await a.c.post("/api/orgs", { name, ...extra });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.organisation.id as string;
}
async function deal(creator: Account, leader: Account, o: { orgId?: string; bid?: boolean; extra?: Record<string, unknown> } = {}) {
  const p = await pipelines(creator);
  const orgId = o.orgId ?? (await org(creator));
  const body = {
    name: `Deal ${Date.now()}-${seq++}`, organisationId: orgId, pipelineId: (o.bid ? p.bid : p.proactive).id, leaderId: leader.id,
    whyPursue: "Strong fit", nextStep: { title: "Call the buyer", dueDate: istDate(3) },
    ...(o.bid ? { submissionDeadline: istDate(20) } : {}), ...o.extra,
  };
  const r = await creator.c.post("/api/deals", body);
  return { r, body, pipes: p, orgId };
}

describe("types and pipelines (10.1, 10.2)", () => {
  it("seeds Deal pipelines with the agreed stages", async () => {
    const m = await account("pipe");
    const { proactive, bid } = await pipelines(m);
    expect(proactive.stages.map((s: { name: string }) => s.name)).toEqual(["Lead", "Conversation", "Concept note", "Proposal", "Negotiation", "On hold", "Won", "Lost"]);
    expect(bid.stages.map((s: { name: string }) => s.name)).toEqual(["Identified", "Go/No-go", "Preparing", "Submitted", "Awaiting result", "Won", "Lost"]);
    const cat = (p: { stages: { name: string; category: string }[] }, n: string) => p.stages.find((s) => s.name === n)!.category;
    expect(cat(proactive, "On hold")).toBe("PAUSED");
    expect(cat(proactive, "Won")).toBe("DONE");
    expect(cat(bid, "Lost")).toBe("LOST");
  });

  it("makes a plain project type Project, and lists it", async () => {
    const m = await account("plain");
    const p = await project(m, m);
    const g = await m.c.get(`/api/projects/${p.id}`);
    expect(g.json.project.type).toBe("PROJECT");
    expect(g.json.project.deal).toBeNull();
    expect((await m.c.get("/api/projects")).json.projects.some((x: { id: string }) => x.id === p.id)).toBe(true);
  });
});

describe("organisations (11.1)", () => {
  it("lets any Member create one, warns on a duplicate under the same parent, and keeps it visible to everyone", async () => {
    const a = await account("orga");
    const newcomer = await account("newcomer"); // in no project
    const name = `Ministry ${Date.now()}`;
    const id = await org(a, name);
    const dup = await a.c.post("/api/orgs", { name: name.toUpperCase() });
    expect(dup.status).toBe(409);
    expect(dup.json.needsConfirm).toBe("duplicate");
    expect((await a.c.post("/api/orgs", { name: name.toUpperCase(), force: true })).status).toBe(201);
    // Decision of 17 Oct 2026: every signed-in Member sees all organisations, even in no project.
    const seen = await newcomer.c.get("/api/orgs");
    expect(seen.json.organisations.some((o: { id: string }) => o.id === id)).toBe(true);
    expect((await newcomer.c.get(`/api/orgs/${id}`)).status).toBe(200);
  });

  it("shows the full path and refuses a cycle", async () => {
    const a = await account("tree");
    const g = await org(a, `Gov ${Date.now()}`);
    const m = await org(a, `Ministry ${Date.now()}`, { parentId: g });
    const b = await org(a, `Board ${Date.now()}`, { parentId: m });
    const got = await a.c.get(`/api/orgs/${b}`);
    expect(got.json.organisation.path.map((x: { id: string }) => x.id)).toEqual([g, m, b]);
    expect((await a.c.patch(`/api/orgs/${g}`, { parentId: b })).status).toBe(400);
    expect((await a.c.patch(`/api/orgs/${g}`, { parentId: g })).status).toBe(400);
  });

  it("lets only the creator and Admins edit or archive", async () => {
    const sa = await superAdmin();
    const ad = await admin(sa);
    const a = await account("creator");
    const other = await account("other");
    const id = await org(a);
    expect((await other.c.patch(`/api/orgs/${id}`, { name: "Hijack" })).status).toBe(403);
    expect((await other.c.post(`/api/orgs/${id}/archive`, { archive: true })).status).toBe(403);
    expect((await a.c.patch(`/api/orgs/${id}`, { country: "Rwanda" })).status).toBe(200);
    expect((await ad.c.post(`/api/orgs/${id}/archive`, { archive: true })).status).toBe(200);
    expect((await ad.c.patch(`/api/orgs/${id}`, { country: "India" })).status).toBe(409); // archived
  });

  it("shows organisation History to Admins only", async () => {
    const sa = await superAdmin();
    const ad = await admin(sa);
    const a = await account("histo");
    const id = await org(a);
    await a.c.patch(`/api/orgs/${id}`, { country: "Kenya" });
    expect((await a.c.get(`/api/orgs/${id}/history`)).status).toBe(404);
    const h = await ad.c.get(`/api/orgs/${id}/history`);
    expect(h.status).toBe(200);
    expect(h.json.items.map((x: { action: string }) => x.action)).toContain("organisation.updated");
  });
});

describe("create a deal (12.1)", () => {
  it("creates a deal in the first stage with the Leader, Buyer, Sections and a dated next step", async () => {
    const creator = await account("dcreator");
    const leader = await account("dleader");
    const { r, body } = await deal(creator, leader);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const id = r.json.deal.id as string;
    const g = (await leader.c.get(`/api/projects/${id}`)).json.project;
    expect(g.type).toBe("DEAL");
    expect(g.deal.stage.name).toBe("Lead");
    expect(g.deal.organisation.id).toBe(body.organisationId);
    expect(g.deal.nextStep.title).toBe("Call the buyer");
    expect(g.deal.nextStep.dueDate).toBe(istDate(3));
    expect(g.sections.map((s: { name: string }) => s.name)).toEqual(["To do", "In progress", "Done"]);
    expect(g.members.find((m: { role: string }) => m.role === "LEADER").userId).toBe(leader.id);
    // The creator is an Editor when someone else leads.
    expect((await creator.c.get(`/api/projects/${id}`)).json.project.role).toBe("EDITOR");
    // Value is empty, never zero.
    expect(g.deal.details.value).toBeNull();
  });

  it("logs the first next step as a created task and tells the Leader they hold it (SHO-BUG-5)", async () => {
    const creator = await account("fcreator");
    const leader = await account("fleader");
    const { r } = await deal(creator, leader);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const id = r.json.deal.id as string;
    expect(r.headers.get("x-undo-id")).toBeNull(); // creating a deal offers no Undo toast, not even for its first step
    const items = (await leader.c.get(`/api/projects/${id}/activity`)).json.items as { what: string }[];
    expect(items.filter((i) => i.what === 'added "Call the buyer" to To do')).toHaveLength(1); // the task.created row (SHO-US-14.14 wording)
    expect(items.some((i) => i.what.startsWith("created the deal"))).toBe(true);
    const step = (await leader.c.get(`/api/projects/${id}`)).json.project.deal.nextStep;
    const notes = (await leader.c.get("/api/notifications")).json.items as { text: string; href: string }[];
    expect(notes.find((n) => n.text === 'Fcreator assigned you "Call the buyer".')?.href).toBe(`/tasks/${step.id}`);
    // When the creator leads, nobody is told about their own step.
    const solo = await account("fsolo");
    expect((await deal(solo, solo)).r.status).toBe(201);
    expect(((await solo.c.get("/api/notifications")).json.items as { text: string }[]).some((n) => /assigned you/.test(n.text))).toBe(false);
  });

  it("hides deals from the Projects list but shows them in Deals", async () => {
    const m = await account("dlist");
    const { r } = await deal(m, m);
    const id = r.json.deal.id as string;
    expect((await m.c.get("/api/projects")).json.projects.some((x: { id: string }) => x.id === id)).toBe(false);
    expect((await m.c.get("/api/deals")).json.deals.some((x: { id: string }) => x.id === id)).toBe(true);
    const found = await m.c.get(`/api/search?q=${encodeURIComponent(r.json.deal.name.slice(0, 8))}`);
    expect(found.json.projects.find((x: { id: string }) => x.id === id)?.type).toBe("DEAL");
  });

  it("refuses missing facts and a Bid with no deadline", async () => {
    const m = await account("dbad");
    const p = await pipelines(m);
    const orgId = await org(m);
    const base = { name: `Base ${Date.now()}`, organisationId: orgId, pipelineId: p.proactive.id, leaderId: m.id, whyPursue: "why", nextStep: { title: "t", dueDate: istDate(1) } };
    expect((await m.c.post("/api/deals", { ...base, organisationId: "" })).status).toBe(400);
    expect((await m.c.post("/api/deals", { ...base, organisationId: "nope" })).status).toBe(400);
    expect((await m.c.post("/api/deals", { ...base, whyPursue: " " })).status).toBe(400);
    expect((await m.c.post("/api/deals", { ...base, nextStep: { title: "t" } })).status).toBe(400);
    expect((await m.c.post("/api/deals", { ...base, pipelineId: p.bid.id })).status).toBe(400); // Bid needs a deadline
    expect((await m.c.post("/api/deals", { ...base, name: "bid-a", pipelineId: p.bid.id, submissionDeadline: istDate(9) })).status).toBe(201);
    expect((await m.c.post("/api/deals", { ...base, value: 0, currency: "INR" })).status).toBe(400); // zero is not a value
    expect((await m.c.post("/api/deals", { ...base, value: 500 })).status).toBe(400); // currency needed
    expect((await m.c.post("/api/deals", { ...base, name: "usd-a", value: 500, currency: "USD" })).status).toBe(201);
  });

  it("warns on the same name under the same organisation and lets the member continue", async () => {
    const m = await account("ddup");
    const orgId = await org(m);
    const first = await deal(m, m, { orgId, extra: { name: "Same name" } });
    expect(first.r.status).toBe(201);
    const second = await deal(m, m, { orgId, extra: { name: "same NAME" } });
    expect(second.r.status).toBe(409);
    expect(second.r.json.needsConfirm).toBe("duplicate");
    const forced = await deal(m, m, { orgId, extra: { name: "same NAME", force: true } });
    expect(forced.r.status).toBe(201);
  });
});

describe("deal visibility follows membership (3.2)", () => {
  it("shows a deal only to its members and to Admins", async () => {
    const sa = await superAdmin();
    const ad = await admin(sa);
    const lead = await account("vlead");
    const stranger = await account("vstranger");
    const { r } = await deal(lead, lead);
    const id = r.json.deal.id as string;
    expect((await stranger.c.get(`/api/projects/${id}`)).status).toBe(404);
    expect((await stranger.c.get("/api/deals")).json.deals.some((x: { id: string }) => x.id === id)).toBe(false);
    expect((await ad.c.get(`/api/projects/${id}`)).status).toBe(200);
    expect((await ad.c.get("/api/deals")).json.deals.some((x: { id: string }) => x.id === id)).toBe(true);
  });
});

describe("stages (10.3)", () => {
  it("moves a stage, notifies the Leader, logs it and can be undone", async () => {
    const lead = await account("slead");
    const ed = await account("sed");
    const { r, pipes } = await deal(lead, lead);
    const id = r.json.deal.id as string;
    await lead.c.post(`/api/projects/${id}/members`, { userId: ed.id, role: "EDITOR" });
    const proposal = pipes.proactive.stages.find((s: { name: string }) => s.name === "Proposal").id;
    const mv = await ed.c.post(`/api/projects/${id}/stage`, { stageId: proposal });
    expect(mv.status, JSON.stringify(mv.json)).toBe(200);
    expect(mv.headers.get("x-undo-label")).toBe("Stage changed");
    expect((await lead.c.get(`/api/projects/${id}`)).json.project.deal.stage.name).toBe("Proposal");
    const notes = (await lead.c.get("/api/notifications")).json.items as { text: string }[];
    expect(notes.some((n) => /Proposal/.test(n.text))).toBe(true);
    const undo = await ed.c.post(`/api/actions/${mv.headers.get("x-undo-id")}/undo`, {});
    expect(undo.status, JSON.stringify(undo.json)).toBe(200);
    expect((await lead.c.get(`/api/projects/${id}`)).json.project.deal.stage.name).toBe("Lead");
  });

  it("refuses Viewers, other pipelines' stages, and archived deals", async () => {
    const lead = await account("rlead");
    const viewer = await account("rviewer");
    const { r, pipes } = await deal(lead, lead);
    const id = r.json.deal.id as string;
    await lead.c.post(`/api/projects/${id}/members`, { userId: viewer.id, role: "VIEWER" });
    const conv = pipes.proactive.stages[1].id;
    expect((await viewer.c.post(`/api/projects/${id}/stage`, { stageId: conv })).status).toBe(403);
    expect((await lead.c.post(`/api/projects/${id}/stage`, { stageId: pipes.bid.stages[1].id })).status).toBe(400);
    expect((await lead.c.post(`/api/projects/${id}/archive`, {})).status).toBe(200);
    expect((await lead.c.post(`/api/projects/${id}/stage`, { stageId: conv })).status).toBe(409);
  });

  it("requires a reason for On hold and Lost", async () => {
    const lead = await account("reason");
    const { r, pipes } = await deal(lead, lead);
    const id = r.json.deal.id as string;
    const hold = pipes.proactive.stages.find((s: { name: string }) => s.name === "On hold").id;
    const noReason = await lead.c.post(`/api/projects/${id}/stage`, { stageId: hold });
    expect(noReason.status).toBe(400);
    expect(noReason.json.needsReason).toBe(true);
    expect((await lead.c.post(`/api/projects/${id}/stage`, { stageId: hold, reason: "Budget freeze" })).status).toBe(200);
    expect((await lead.c.get(`/api/projects/${id}`)).json.project.deal.stageReason).toBe("Budget freeze");
  });

  it("blocks Won and Lost while any task is open, then allows it, and never archives or closes tasks", async () => {
    const lead = await account("wonlead");
    const { r, pipes } = await deal(lead, lead);
    const id = r.json.deal.id as string;
    const won = pipes.proactive.stages.find((s: { name: string }) => s.name === "Won").id;
    const blocked = await lead.c.post(`/api/projects/${id}/stage`, { stageId: won });
    expect(blocked.status).toBe(409);
    expect(blocked.json.openTasks).toBe(1); // the first next step
    expect(blocked.json.tasks[0].title).toBe("Call the buyer");
    // Close the only open task, then it passes.
    const p = (await lead.c.get(`/api/projects/${id}`)).json.project;
    expect((await lead.c.post(`/api/tasks/${blocked.json.tasks[0].id}/complete`, await withVersion(lead, blocked.json.tasks[0].id))).status).toBe(200);
    expect((await lead.c.post(`/api/projects/${id}/stage`, { stageId: won })).status).toBe(200);
    const after = (await lead.c.get(`/api/projects/${id}`)).json.project;
    expect(after.deal.stage.name).toBe("Won");
    expect(after.archived).toBe(false);
    expect(p.openTasks).toBe(1);
  });

  it("names the deal in the audit log when it is created and when it is closed (SHO-BUG-4)", async () => {
    const sa = await superAdmin();
    const lead = await account("audlead");
    const { r, body, pipes } = await deal(lead, lead);
    const id = r.json.deal.id as string;
    const step = (await lead.c.get(`/api/projects/${id}`)).json.project.deal.nextStep.id;
    expect((await lead.c.post(`/api/tasks/${step}/complete`, await withVersion(lead, step))).status).toBe(200);
    expect((await lead.c.post(`/api/projects/${id}/stage`, { stageId: pipes.proactive.stages.find((s: { name: string }) => s.name === "Won").id })).status).toBe(200);
    const target = async (event: string) => ((await sa.c.get(`/api/audit?event=${event}&person=${lead.id}`)).json.items as { target: string | null }[])[0]?.target;
    expect(await target("DEAL_CLOSED")).toBe(`Deal "${body.name}"`);
    expect(await target("DEAL_CREATED")).toBe(`Deal "${body.name}"`);
  });

  it("makes no stage change possible on a plain project", async () => {
    const m = await account("noproj");
    const p = await project(m, m);
    const { proactive } = await pipelines(m);
    expect((await m.c.post(`/api/projects/${p.id}/stage`, { stageId: proactive.stages[1].id })).status).toBe(400);
  });
});

describe("deal details (12.3)", () => {
  it("edits details, keeps unknown value empty, and undoes", async () => {
    const lead = await account("detlead");
    const { r } = await deal(lead, lead);
    const id = r.json.deal.id as string;
    const e = await lead.c.patch(`/api/projects/${id}/deal`, { value: 250000, currency: "INR", probability: 40 });
    expect(e.status, JSON.stringify(e.json)).toBe(200);
    const d = (await lead.c.get(`/api/projects/${id}`)).json.project.deal.details;
    expect(d.value).toBe(250000);
    expect(d.currency).toBe("INR");
    expect(d.probability).toBe(40);
    expect((await lead.c.patch(`/api/projects/${id}/deal`, { probability: 101 })).status).toBe(400);
    expect((await lead.c.patch(`/api/projects/${id}/deal`, { value: null })).status).toBe(200);
    expect((await lead.c.get(`/api/projects/${id}`)).json.project.deal.details.value).toBeNull();
    const viewer = await account("detviewer");
    await lead.c.post(`/api/projects/${id}/members`, { userId: viewer.id, role: "VIEWER" });
    expect((await viewer.c.patch(`/api/projects/${id}/deal`, { need: "x" })).status).toBe(403);
  });
});
