// APL-2659: a quick action on an archived project, or on a deal CRM_VISIBLE hides from a Member,
// is the same Project not found as a project they are not in. The name is not stored in the chat.
// These call src/lib directly (same database as the server) and flip CRM_VISIBLE in this process.
import { describe, expect, it } from "vitest";
import { account, admin, istDate, project, superAdmin, task } from "./helpers";
import { actor, db } from "./concierge-helpers";
import { quickAction } from "../src/lib/concierge/engine";
import type { Actor } from "../src/lib/access";

async function withMode(mode: string, fn: () => Promise<void>) {
  const prev = process.env.CRM_VISIBLE;
  process.env.CRM_VISIBLE = mode;
  try { await fn(); } finally { if (prev === undefined) delete process.env.CRM_VISIBLE; else process.env.CRM_VISIBLE = prev; }
}

const chatIds = async (userId: string) =>
  (await db.chatMessage.findMany({ where: { userId }, orderBy: { id: "asc" }, select: { id: true } })).map((row) => row.id);

const storedChat = async (userId: string) => JSON.stringify(await db.chatMessage.findMany({ where: { userId } }));

/** The error quickAction throws, or null when it answers. */
async function refused(user: Actor, projectId: string) {
  try {
    await quickAction(user, "due-week", new Date(), projectId);
    return null;
  } catch (err) {
    const e = err as { status?: number; message?: string };
    return { status: e.status, message: e.message };
  }
}

describe("quickAnswer visibility (APL-2659)", () => {
  it("qa:TC missing: an archived project is the same Project not found as a missing project, and the name is not stored", async () => {
    const lead = await account("archqa");
    const member = await account("archqamem");
    const outsider = await account("archqaout");
    const mine = await project(lead, lead, [{ who: member }]);
    const hidden = await project(outsider, outsider);
    const named = await member.c.get(`/api/projects/${mine.id}`);
    expect(named.status).toBe(200);
    const name = named.json.project.name as string;
    expect((await lead.c.post(`/api/projects/${mine.id}/archive`)).status).toBe(200);

    const before = await chatIds(member.id);
    const archived = await refused(actor(member), mine.id);
    const missing = await refused(actor(member), hidden.id);
    expect(archived).toEqual({ status: 404, message: "Project not found" });
    expect(archived).toEqual(missing);
    expect(JSON.stringify(archived)).not.toContain(name);
    expect(await chatIds(member.id)).toEqual(before);
    expect(await storedChat(member.id)).not.toContain(name);

    // A live project the same person belongs to still answers, and that answer may name it.
    const live = await project(lead, member);
    const liveName = (await member.c.get(`/api/projects/${live.id}`)).json.project.name as string;
    const answered = await quickAction(actor(member), "due-week", new Date(), live.id);
    expect(answered.messages[0].text).toBe(`Due this week in ${liveName}`);
    expect(await storedChat(member.id)).toContain(liveName);
    expect(await storedChat(member.id)).not.toContain(name);
  });

  it("qa:TC missing: under CRM admins a Member's deal quick action is the same Project not found, and the name is not stored", async () => {
    const sa = await superAdmin();
    const ad = await admin(sa, "dealqad");
    const lead = await account("dealqalead");
    const member = await account("dealqamem");
    const outsider = await account("dealqaout");
    const tag = `dealqa${Date.now()}`;
    const dealName = `Hush deal ${tag}`;
    const pipe = (await lead.c.get("/api/deals/pipelines")).json.pipelines.find((p: { key: string }) => p.key === "DEAL_PROACTIVE");
    const orgId = (await lead.c.post("/api/orgs", { name: `Org ${tag}` })).json.organisation.id as string;
    const made = await lead.c.post("/api/deals", {
      name: dealName, organisationId: orgId, pipelineId: pipe.id, leaderId: lead.id, whyPursue: "fit",
      nextStep: { title: `Step ${tag}`, dueDate: istDate(3) },
    });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    const dealId = made.json.deal.id as string;
    expect((await lead.c.post(`/api/projects/${dealId}/members`, { userId: member.id, role: "EDITOR" })).status).toBe(201);
    expect((await lead.c.post(`/api/projects/${dealId}/members`, { userId: ad.id, role: "EDITOR" })).status).toBe(201);
    await task(member, dealId, { title: `Soon step ${tag}`, dueDate: istDate(2) });
    const other = await project(outsider, outsider);

    await withMode("admins", async () => {
      const before = await chatIds(member.id);
      const hiddenDeal = await refused(actor(member), dealId);
      const missing = await refused(actor(member), other.id);
      expect(hiddenDeal).toEqual({ status: 404, message: "Project not found" });
      expect(hiddenDeal).toEqual(missing);
      expect(JSON.stringify(hiddenDeal)).not.toContain(dealName);
      expect(JSON.stringify(hiddenDeal)).not.toContain(tag);
      expect(await chatIds(member.id)).toEqual(before);
      const stored = await storedChat(member.id);
      expect(stored).not.toContain(dealName);
      expect(stored).not.toContain(tag);

      const seen = await quickAction(actor(ad, "ADMIN"), "due-week", new Date(), dealId);
      expect(seen.messages[0].text).toBe(`Due this week in ${dealName}`);
    });

    await withMode("all", async () => {
      const open = await quickAction(actor(member), "due-week", new Date(), dealId);
      expect(open.messages[0].text).toBe(`Due this week in ${dealName}`);
      expect(open.messages[1].text).toContain(`Soon step ${tag}`);
    });
  });
});
