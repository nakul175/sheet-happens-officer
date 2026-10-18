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

/** POST /api/concierge/quick/[id] as `who`, through the route handler. Returns the status, the raw body and the parsed JSON. */
async function quick(who: Account, id: string, projectId?: string) {
  jar.cookie = who.c.cookie;
  const req = new Request(`http://localhost/api/concierge/quick/${id}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(projectId ? { projectId } : {}),
  });
  const res = await POST(req, { params: Promise.resolve({ id }) });
  const body = await res.text();
  return { status: res.status, body, json: JSON.parse(body) };
}

async function withMode(mode: string, fn: () => Promise<void>) {
  const prev = process.env.CRM_VISIBLE;
  process.env.CRM_VISIBLE = mode;
  try { await fn(); } finally { if (prev === undefined) delete process.env.CRM_VISIBLE; else process.env.CRM_VISIBLE = prev; }
}

/** Everything the person's chat holds, as stored. */
const storedChat = async (userId: string) => JSON.stringify(await db.chatMessage.findMany({ where: { userId } }));

describe("CRM_VISIBLE and concierge quick actions (SHO-BUG-11)", () => {
  useFakeModel();
  afterEach(() => { jar.cookie = ""; });

  it("a hidden deal's projectId yields \"I can't find that.\" and its name reaches neither the response, the chat nor the model", async () => {
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
      for (const { id, label } of QUICK_ACTIONS) {
        const before = await storedChat(who.id);
        const r = await quick(who, id, dealId);
        expect(r.status, r.body).toBe(200);
        expect(r.json.messages.map((m: { role: string; text: string }) => [m.role, m.text])).toEqual([["USER", label], ["ASSISTANT", "I can't find that."]]);
        expect(r.json.messages[1].links).toBeUndefined();
        expect(r.body).not.toContain(dealName);
        expect(r.body).not.toContain(tag);
        const after = await storedChat(who.id);
        expect(after.length).toBeGreaterThan(before.length); // the exchange was stored...
        expect(after).not.toContain(dealName); // ...without the deal's name or any of its task titles
        expect(after).not.toContain(tag);
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
      for (const { id, label } of QUICK_ACTIONS) {
        const r = await quick(ad, id, dealId);
        expect(r.json.messages.map((m: { text: string }) => m.text)).toEqual([label, "I can't find that."]);
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
});
