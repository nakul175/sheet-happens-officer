// SHO-BUG-11 over the network: POST /api/concierge/quick/:id with a hidden deal's projectId, on real servers started
// with CRM_VISIBLE=admins and CRM_VISIBLE=off (the shared test server runs `all`). Each is a `next start` of the existing
// production build, on its own port, with this process's environment; sessions live in the database, so the cookies the
// shared server issued work on both. CI builds before testing; a local run under `next dev` skips this file unless built.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { account, admin, istDate, superAdmin, task, type Account } from "./helpers";
import { db } from "./concierge-helpers";
import { QUICK_ACTIONS } from "../src/lib/concierge/reads";

const built = existsSync(".next/BUILD_ID");
if (!built && process.env.CI) throw new Error("CI must run `npm run build` before these tests");
const PORTS = { admins: 3191, off: 3192 } as const;
type Mode = keyof typeof PORTS;
const servers: ChildProcess[] = [];

async function startServer(mode: Mode) {
  const port = PORTS[mode];
  const child = spawn("npx", ["next", "start", "-p", String(port)], { env: { ...process.env, CRM_VISIBLE: mode }, stdio: "ignore", detached: true });
  servers.push(child);
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://localhost:${port}/api/health`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`next start with CRM_VISIBLE=${mode} did not come up on ${port}`);
}

/** POST /api/concierge/quick/:id over HTTP to the server running `mode`, signed in as `who`. */
async function quick(mode: Mode, who: Account, id: string, projectId: string) {
  const res = await fetch(`http://localhost:${PORTS[mode]}/api/concierge/quick/${encodeURIComponent(id)}`, {
    method: "POST", headers: { "content-type": "application/json", cookie: who.c.cookie }, body: JSON.stringify({ projectId }),
  });
  const body = await res.text();
  return { status: res.status, body, json: res.headers.get("content-type")?.includes("json") ? JSON.parse(body) : null };
}

const storedSince = async (userId: string, since: Date) => JSON.stringify(await db.chatMessage.findMany({ where: { userId, createdAt: { gte: since } } }));

describe.skipIf(!built)("POST /api/concierge/quick/:id with a hidden deal, over HTTP (SHO-BUG-11)", () => {
  beforeAll(async () => { await Promise.all([startServer("admins"), startServer("off")]); }, 60_000);
  // npx runs next as its own child: stop the whole process group, or the port stays taken.
  afterAll(() => { for (const s of servers) try { process.kill(-s.pid!); } catch { /* already gone */ } });

  it("never names the hidden deal to an Editor or a Viewer (admins, off) or to an Admin (off); an Admin under admins still sees it", async () => {
    const sa = await superAdmin();
    const ad = await admin(sa, "qhadmin");
    const lead = await account("qhlead");
    const ed = await account("qhed");
    const viewer = await account("qhviewer");
    const out = await account("qhout");
    const tag = `qhtag${Date.now()}`;
    const dealName = `Quiet deal ${tag}`;
    const pipe = (await lead.c.get("/api/deals/pipelines")).json.pipelines.find((p: { key: string }) => p.key === "DEAL_PROACTIVE");
    const orgId = (await lead.c.post("/api/orgs", { name: `Org ${tag}` })).json.organisation.id;
    const made = await lead.c.post("/api/deals", { name: dealName, organisationId: orgId, pipelineId: pipe.id, leaderId: lead.id, whyPursue: "fit", nextStep: { title: "First step", dueDate: istDate(3) } });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    const dealId = made.json.deal.id as string;
    // Editor and Admin hold deal work; the Viewer (a second non-admin role) is a member who holds none.
    for (const [who, role] of [[ed, "EDITOR"], [ad, "EDITOR"], [viewer, "VIEWER"]] as const) {
      expect((await lead.c.post(`/api/projects/${dealId}/members`, { userId: who.id, role })).status).toBe(201);
    }
    await task(ed, dealId, { title: `Soon step ${tag}`, dueDate: istDate(2) });
    await task(ad, dealId, { title: `Admin step ${tag}`, dueDate: istDate(2) });

    const hidden = async (mode: Mode, who: Account) => {
      const since = new Date();
      for (const { id, label } of QUICK_ACTIONS) {
        const r = await quick(mode, who, id, dealId);
        expect(r.status, `${mode} ${id}: ${r.body}`).toBe(200);
        expect(r.json.messages.map((m: { role: string; text: string }) => [m.role, m.text])).toEqual([["USER", label], ["ASSISTANT", "I can't find that."]]);
        expect(r.body).not.toContain(dealName);
        expect(r.body).not.toContain(tag);
      }
      const stored = await storedSince(who.id, since);
      expect(stored).toContain("I can't find that."); // the exchanges were stored...
      expect(stored).not.toContain(dealName); // ...without the deal's name or its task titles
      expect(stored).not.toContain(tag);
    };

    await hidden("admins", ed);
    await hidden("admins", viewer);
    await hidden("off", ed);
    await hidden("off", viewer);
    await hidden("off", ad);

    // Visible: an Admin under admins gets today's answer, named and listed.
    const seen = await quick("admins", ad, "due-week", dealId);
    expect(seen.status).toBe(200);
    expect(seen.json.messages[0].text).toBe(`Due this week in ${dealName}`);
    expect(seen.json.messages[1].text).toContain(`Admin step ${tag}`);
    // Outside the deal is still "not found" in both modes, without the name.
    for (const mode of ["admins", "off"] as const) {
      const o = await quick(mode, out, "due-week", dealId);
      expect(o.status).toBe(404);
      expect(o.body).not.toContain(dealName);
    }
  });
});
