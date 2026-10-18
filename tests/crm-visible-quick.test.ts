// SHO-BUG-11: a concierge quick action asked from a deal's screen must not name a deal that CRM_VISIBLE hides.
// The shared server runs with the default `all`, so the quick-action route's own POST handler is called in this process
// (same database, real session cookie) with process.env.CRM_VISIBLE flipped; `crmMode()` reads it at call time.
// Only the Next request APIs the route needs (cookies, connection) are stubbed.
import { afterEach, describe, expect, it, vi } from "vitest";
import { account, admin, istDate, superAdmin, task, type Account } from "./helpers";
import { actor, db, say, script, useFakeModel } from "./concierge-helpers";
import { fakeCallCount, type ModelRequest } from "../src/lib/model";
import { QUICK_ACTIONS } from "../src/lib/concierge/reads";
import { sendMessage } from "../src/lib/concierge/engine";

const jar = vi.hoisted(() => ({ cookie: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const [k, v] = jar.cookie.split("=");
      return k === name ? { name, value: v } : undefined;
    },
  }),
}));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), connection: async () => {} }));

const { POST } = await import("../src/app/api/concierge/quick/[id]/route");

/** Headers the handler chooses. Transport headers such as date are not on this response. */
function headersThatMatter(res: Response) {
  const lines: string[] = [];
  res.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (k === "content-type" || k.startsWith("x-")) lines.push(`${k}: ${value}`);
  });
  return lines.sort().join("\n");
}

/** POST /api/concierge/quick/[id] as `who`, through the route handler. Returns the status, the headers that matter, the raw body and the parsed JSON. */
async function quick(who: Account, id: string, projectId?: string) {
  jar.cookie = who.c.cookie;
  const req = new Request(`http://localhost/api/concierge/quick/${id}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(projectId ? { projectId } : {}),
  });
  const res = await POST(req, { params: Promise.resolve({ id }) });
  const headers = headersThatMatter(res);
  const body = await res.text();
  return { status: res.status, headers, body, json: JSON.parse(body) };
}

async function withMode(mode: string, fn: () => Promise<void>) {
  const prev = process.env.CRM_VISIBLE;
  process.env.CRM_VISIBLE = mode;
  try { await fn(); } finally { if (prev === undefined) delete process.env.CRM_VISIBLE; else process.env.CRM_VISIBLE = prev; }
}

/** Everything the person's chat holds, as stored. */
const storedChat = async (userId: string) => JSON.stringify(await db.chatMessage.findMany({ where: { userId } }));

/** Rows written at or after `since`, without id and createdAt (the only fields the AC allows to differ). */
async function storedDelta(userId: string, since: Date) {
  const rows = await db.chatMessage.findMany({ where: { userId, createdAt: { gte: since } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  return rows.map((row) => ({ userId: row.userId, role: row.role, content: row.content }));
}

/** A deal the Member and an Admin both belong to, plus a plain project neither of them belongs to. */
async function hiddenDeal(label: string) {
  const sa = await superAdmin();
  const ad = await admin(sa, `${label}ad`);
  const lead = await account(`${label}lead`);
  const member = await account(`${label}ed`);
  const outsider = await account(`${label}out`);
  const tag = `${label}${Date.now()}`;
  const dealName = `Hush deal ${tag}`;
  const pipe = (await lead.c.get("/api/deals/pipelines")).json.pipelines.find((p: { key: string }) => p.key === "DEAL_PROACTIVE");
  const orgId = (await lead.c.post("/api/orgs", { name: `Org ${tag}` })).json.organisation.id;
  const made = await lead.c.post("/api/deals", { name: dealName, organisationId: orgId, pipelineId: pipe.id, leaderId: lead.id, whyPursue: "fit", nextStep: { title: "First step", dueDate: istDate(3) } });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  const dealId = made.json.deal.id as string;
  for (const who of [member, ad]) expect((await lead.c.post(`/api/projects/${dealId}/members`, { userId: who.id, role: "EDITOR" })).status).toBe(201);
  await task(member, dealId, { title: `Soon step ${tag}`, dueDate: istDate(2) });
  await task(ad, dealId, { title: `Admin step ${tag}`, dueDate: istDate(2) });
  const plain = await outsider.c.post("/api/projects", { name: `Plain ${tag}`, leaderId: outsider.id });
  expect(plain.status, JSON.stringify(plain.json)).toBe(201);
  return { ad, member, tag, dealName, dealId, otherId: plain.json.project.id as string };
}

describe("CRM_VISIBLE and concierge quick actions (SHO-BUG-11)", () => {
  useFakeModel();
  afterEach(() => { jar.cookie = ""; });

  it("a hidden deal's projectId is 404 Project not found, and its name reaches neither the response, the chat nor the model", async () => {
    const sa = await superAdmin();
    const ad = await admin(sa, "cqadmin");
    const lead = await account("cqlead");
    const ed = await account("cqed");
    const out = await account("cqout");
    const tag = `cqtag${Date.now()}`;
    const dealName = `Hush deal ${tag}`;
    // A deal led by `lead`, with the Member `ed` and the Admin `ad` both members holding work due this week and overdue.
    const pipe = (await lead.c.get("/api/deals/pipelines")).json.pipelines.find((p: { key: string }) => p.key === "DEAL_PROACTIVE");
    const orgId = (await lead.c.post("/api/orgs", { name: `Org ${tag}` })).json.organisation.id;
    const made = await lead.c.post("/api/deals", { name: dealName, organisationId: orgId, pipelineId: pipe.id, leaderId: lead.id, whyPursue: "fit", nextStep: { title: "First step", dueDate: istDate(3) } });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    const dealId = made.json.deal.id as string;
    for (const who of [ed, ad]) expect((await lead.c.post(`/api/projects/${dealId}/members`, { userId: who.id, role: "EDITOR" })).status).toBe(201);
    await task(ed, dealId, { title: `Soon step ${tag}`, dueDate: istDate(2) });
    await task(ed, dealId, { title: `Late step ${tag}`, dueDate: istDate(-2) });
    await task(ad, dealId, { title: `Admin step ${tag}`, dueDate: istDate(2) });
    script(() => { throw new Error("no model call expected"); });

    const hidden = async (who: Account) => {
      for (const { id } of QUICK_ACTIONS) {
        const before = await storedChat(who.id);
        const r = await quick(who, id, dealId);
        expect(r.status, r.body).toBe(404);
        expect(r.json.error).toBe("Project not found");
        expect(r.body).not.toContain(dealName);
        expect(r.body).not.toContain(tag);
        // A 404 is thrown before the chat is written, so the deal is not stored either.
        expect(await storedChat(who.id)).toBe(before);
      }
    };
    const visible = async (who: Account, title: string) => {
      const r = await quick(who, "due-week", dealId);
      expect(r.status, r.body).toBe(200);
      expect(r.json.messages[0].text).toBe(`Due this week in ${dealName}`);
      expect(r.json.messages[1].text).toContain(title);
    };

    await withMode("admins", async () => {
      await hidden(ed);
      await visible(ad, `Admin step ${tag}`); // AC3: an Admin still sees the deal as today
    });
    await withMode("off", async () => {
      await hidden(ed);
      // The Admin's chat already holds the deal from the visible answer above; check this mode's rows only.
      const since = new Date();
      for (const { id } of QUICK_ACTIONS) {
        const r = await quick(ad, id, dealId);
        expect(r.status, r.body).toBe(404);
        expect(r.json.error).toBe("Project not found");
        expect(r.body).not.toContain(dealName);
      }
      expect(JSON.stringify(await db.chatMessage.findMany({ where: { userId: ad.id, createdAt: { gte: since } } }))).not.toContain(dealName);
      // Someone outside the deal still gets "not found", as for any project they are not in.
      const o = await quick(out, "due-week", dealId);
      expect(o.status).toBe(404);
      expect(o.body).not.toContain(dealName);
    });
    expect(fakeCallCount()).toBe(0);

    // The next model turn carries the stored chat as history: the deal's name is not in anything the model is sent.
    await withMode("off", async () => {
      const seen: ModelRequest[] = [];
      script((r) => { seen.push(r); return [say("ok")]; });
      await sendMessage(actor(ed), "What did you just tell me?");
      expect(seen.length).toBe(1);
      expect(JSON.stringify(seen)).not.toContain(dealName);
      expect(JSON.stringify(seen)).not.toContain(tag);
    });

    // CRM_VISIBLE=all (the default): the Member's quick actions on their deal behave as before.
    script(() => { throw new Error("no model call expected"); });
    await visible(ed, `Soon step ${tag}`);
    const late = await quick(ed, "overdue", dealId);
    expect(late.json.messages.map((m: { text: string }) => m.text)).toEqual([`Overdue in ${dealName}`, expect.stringContaining(`Late step ${tag}`)]);
  });

  // qa:TC-APL2646-4346ccb6@v1 · ACa. Due this week on an archived project is the non-member refusal.
  // qa:TC-APL2646-e08272d4@v1 · ACa. The name is absent from the stored thread and from the next model request.
  it("ACa: an archived project a member belongs to is the same 404 as a project they cannot see, and the name never reaches the response, the thread, or the model", async () => {
    const lead = await account("acalead");
    const member = await account("acamem");
    const outsider = await account("acaout");
    const tag = `acatag${Date.now()}`;
    const name = `Vault project ${tag}`;
    const made = await lead.c.post("/api/projects", { name, leaderId: lead.id });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    const projectId = made.json.project.id as string;
    expect((await lead.c.post(`/api/projects/${projectId}/members`, { userId: member.id, role: "EDITOR" })).status).toBe(201);
    await task(member, projectId, { title: `Due step ${tag}`, dueDate: istDate(2) });
    // Still a member: the project page loads, including after it is archived.
    expect((await member.c.get(`/api/projects/${projectId}`)).status).toBe(200);
    expect((await lead.c.post(`/api/projects/${projectId}/archive`)).status).toBe(200);
    expect((await member.c.get(`/api/projects/${projectId}`)).json.project.archived).toBe(true);
    const plain = await outsider.c.post("/api/projects", { name: `Other ${tag}`, leaderId: outsider.id });
    expect(plain.status).toBe(201);
    const otherId = plain.json.project.id as string;

    script(() => { throw new Error("no model call expected"); });
    const reference = await quick(member, "due-week", otherId);
    expect(reference.status).toBe(404);
    expect(reference.json.error).toBe("Project not found");
    expect(reference.body).not.toContain(name);

    for (const mode of ["all", "admins"] as const) {
      await withMode(mode, async () => {
        const since = new Date();
        const r = await quick(member, "due-week", projectId);
        expect(r.status, r.body).toBe(reference.status);
        expect(r.headers).toBe(reference.headers);
        expect(r.body).toBe(reference.body);
        expect(r.body).not.toContain(name);
        expect(r.body).not.toContain(tag);
        expect(await storedDelta(member.id, since)).toEqual([]);
        const thread = await storedChat(member.id);
        expect(thread).not.toContain(name);
        expect(thread).not.toContain(tag);
      });
    }
    expect(fakeCallCount()).toBe(0);

    const seen: ModelRequest[] = [];
    script((r) => { seen.push(r); return [say("ok")]; });
    await sendMessage(actor(member), "What did you just tell me?");
    expect(seen.length).toBe(1);
    expect(JSON.stringify(seen)).not.toContain(name);
    expect(JSON.stringify(seen)).not.toContain(tag);
  });

  // qa:TC-APL2646-1311c0f3@v1 · ACb. Hidden deal and a project the caller is not in: same status, headers, and body.
  // qa:TC-APL2646-2010a576@v1 · ACb. The next model request does not name the deal, and CRM_VISIBLE=all still does.
  it("ACb: a hidden deal and a project the person is not in return the same status, headers, and body", async () => {
    const { ad, member, tag, dealName, dealId, otherId } = await hiddenDeal("acb");
    script(() => { throw new Error("no model call expected"); });

    const pair = async (who: Account, leftId: string, rightId: string) => {
      for (const { id } of QUICK_ACTIONS) {
        const leftSince = new Date();
        const left = await quick(who, id, leftId);
        const leftRows = await storedDelta(who.id, leftSince);
        const rightSince = new Date();
        const right = await quick(who, id, rightId);
        const rightRows = await storedDelta(who.id, rightSince);
        expect(left.status, `${id} ${left.body}`).toBe(404);
        expect(left.json.error).toBe("Project not found");
        expect(right.status).toBe(left.status);
        expect(right.headers).toBe(left.headers);
        expect(right.body).toBe(left.body);
        expect(left.body).not.toContain(dealName);
        expect(left.body).not.toContain(tag);
        expect(right.body).not.toContain(tag);
        expect(leftRows).toEqual(rightRows);
        expect(JSON.stringify(leftRows) + JSON.stringify(rightRows)).not.toContain(dealName);
      }
    };

    await withMode("admins", async () => {
      await pair(member, dealId, otherId);
      const seen: ModelRequest[] = [];
      script((r) => { seen.push(r); return [say("ok")]; });
      await sendMessage(actor(member), "What did you just tell me?");
      expect(JSON.stringify(seen)).not.toContain(dealName);
      expect(JSON.stringify(seen)).not.toContain(tag);
      script(() => { throw new Error("no model call expected"); });
    });

    await withMode("off", async () => {
      await pair(member, dealId, otherId);
      // An Admin can see a plain project they are not in, so the reference is a Member's non-member refusal.
      for (const { id } of QUICK_ACTIONS) {
        const refSince = new Date();
        const ref = await quick(member, id, otherId);
        const refRows = await storedDelta(member.id, refSince);
        const since = new Date();
        const r = await quick(ad, id, dealId);
        expect(r.status, r.body).toBe(ref.status);
        expect(r.headers).toBe(ref.headers);
        expect(r.body).toBe(ref.body);
        expect(r.body).not.toContain(dealName);
        expect(await storedDelta(ad.id, since)).toEqual(refRows);
        expect(await storedChat(ad.id)).not.toContain(dealName);
        expect(await storedChat(ad.id)).not.toContain(`Due this week in ${dealName}`);
      }
    });

    // Control: when the deal is visible, the answer names it, and that body is not the refusal.
    await withMode("all", async () => {
      const named = await quick(member, "due-week", dealId);
      const refused = await quick(member, "due-week", otherId);
      expect(named.status, named.body).toBe(200);
      expect(named.body).toContain(`Due this week in ${dealName}`);
      expect(refused.status).toBe(404);
      expect(named.body).not.toBe(refused.body);
    });
  });

  // qa:TC-APL2646-1e6ed728@v1 · ACc. APL-2609 AC4 on this branch, with no test.fail. PR #73 is not changed.
  it("ACc: under admins a deal member's due-week is the reference refusal, and the thread has no 'Due this week in <deal>'", async () => {
    const { member, dealName, dealId, otherId } = await hiddenDeal("acc");
    script(() => { throw new Error("no model call expected"); });
    await withMode("admins", async () => {
      const reference = await quick(member, "due-week", otherId);
      expect(reference.status).toBe(404);
      expect(reference.json.error).toBe("Project not found");
      const since = new Date();
      const r = await quick(member, "due-week", dealId);
      expect(r.status).toBe(reference.status);
      expect(r.headers).toBe(reference.headers);
      expect(r.body).toBe(reference.body);
      const stored = JSON.stringify(await db.chatMessage.findMany({ where: { userId: member.id, createdAt: { gte: since } } }));
      expect(stored).not.toContain(`Due this week in ${dealName}`);
      expect(stored).not.toContain(dealName);
    });
    expect(fakeCallCount()).toBe(0);
  });
});
