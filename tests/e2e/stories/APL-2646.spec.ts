// SHO-BUG-11 Concierge quick action can return the name of a hidden deal (APL-2646).
// The issue's four unnumbered acceptance criteria are AC1 to AC4, one test each.
// Quick actions do not call the model. CRM_VISIBLE is a server setting: when staging hides deals from a Member
// (admins), the hidden-deal checks run live. When it does not, the checks that staging can still make are run,
// and a response that contains the deal's name fails the test.
// Deals and organisations are ZZ-TEST and archived afterwards. Chats started empty are cleared.
import { test, expect } from "../support";

// One skip for the whole file. The password is SHO_QA_PASS and is never generated here.
test.skip(!process.env.SHO_QA_PASS, "Set SHO_QA_PASS (the shared password for the nakul17+ accounts).");
import { chatMessages, cleanChat, newDeal, QUICK, quickAction } from "../helpers/jim-http";
import { conciergeLive, crmModeLive, type CrmLive } from "../helpers/jim-gate";
import type { Who } from "../g2";

const chat = async (who: Who) => JSON.stringify(await chatMessages(who));

/** A hidden deal's name must not appear. A 404, "Project not found" or "I can't find that." is the safe answer. */
async function expectHidden(who: Who, deal: { id: string; name: string }) {
  for (const id of QUICK) {
    const r = await quickAction(who, id, deal.id);
    expect(r.body, r.body).not.toContain(deal.name);
    const text = `${r.json.messages?.at(-1)?.text ?? ""} ${r.json.error ?? ""}`;
    const safe = r.status === 404 || /I can't find that\.|Project not found|I found nothing\./.test(text);
    expect(safe, r.body).toBe(true);
  }
  expect(await chat(who)).not.toContain(deal.name);
}

async function ready(admin: Who, member: Who | null) {
  const c = await conciergeLive(admin);
  const mode: CrmLive = await crmModeLive(admin, member);
  return { c, mode };
}

test.describe("SHO-BUG-11 / APL-2646", () => {
  test("AC1: a hidden deal's projectId yields a refusal and its name never reaches the chat", { annotation: { type: "qa:TC", description: "missing" } }, async ({ admin, member, later }) => {
    await cleanChat(member, later);
    const { c, mode } = await ready(admin, member);
    expect(c.how.length).toBeGreaterThan(0);
    if (!c.live) {
      expect((await admin.api.get("/api/concierge/state")).json.disabled?.code).toBe("NOT_ENABLED");
      const r = await quickAction(member, "due-week", "zz-missing-deal");
      expect(r.body).not.toContain("ZZ-TEST");
      return;
    }
    if (mode === "off") {
      expect((await member.api.get("/api/deals")).status).toBe(404);
      const r = await quickAction(member, "due-week", "zz-missing-deal");
      expect(r.body).not.toMatch(/ZZ-TEST .*deal/);
      return;
    }
    if (mode !== "admins") {
      const deal = await newDeal(admin, later, "bug11 outsider");
      const r = await quickAction(member, "due-week", deal.id);
      expect(r.body, r.body).not.toContain(deal.name);
      expect(await chat(member)).not.toContain(deal.name);
      return;
    }
    const deal = await newDeal(admin, later, "bug11 hidden", [member]);
    expect((await member.api.get("/api/deals")).status, "the deal list is hidden from a Member under admins").toBe(404);
    await expectHidden(member, deal);
  });

  test("AC2: holds for CRM_VISIBLE=admins (Member) and CRM_VISIBLE=off (Member and Admin)", { annotation: { type: "qa:TC", description: "missing" } }, async ({ admin, member, later }) => {
    await cleanChat(member, later);
    await cleanChat(admin, later);
    const { c, mode } = await ready(admin, member);
    if (!c.live || mode === "off") {
      expect((await admin.api.get("/api/deals")).status).toBe(mode === "off" ? 404 : (await admin.api.get("/api/deals")).status);
      if (mode === "off") {
        expect((await member.api.get("/api/deals")).status).toBe(404);
        for (const who of [member, admin]) {
          const r = await quickAction(who, "due-week", "zz-off-deal");
          expect(r.body).not.toMatch(/ZZ-TEST .*deal/);
        }
      }
      return;
    }
    if (mode !== "admins") {
      test.info().annotations.push({ type: "mode", description: `Staging runs CRM_VISIBLE=${mode}. A deal is not hidden from a Member in this mode.` });
      const deal = await newDeal(admin, later, "bug11 all");
      const r = await quickAction(member, "due-week", deal.id);
      expect(r.body).not.toContain(deal.name);
      return;
    }
    const deal = await newDeal(admin, later, "bug11 admins", [member]);
    await expectHidden(member, deal);
    const offish = await quickAction(admin, "due-week", "zz-not-a-real-deal");
    expect(offish.body).not.toContain(deal.name);
  });

  test("AC3: when the deal is visible (an Admin under admins), quick actions behave as today and name it", { annotation: { type: "qa:TC", description: "missing" } }, async ({ admin, later }) => {
    await cleanChat(admin, later);
    const { c, mode } = await ready(admin, null);
    if (mode === "off") {
      expect((await admin.api.get("/api/deals")).status).toBe(404);
      return;
    }
    expect(c.how.length).toBeGreaterThan(0);
    const deal = await newDeal(admin, later, "bug11 visible");
    const r = await quickAction(admin, "due-week", deal.id);
    expect(r.status, r.body).toBe(200);
    expect(r.json.messages?.[0]?.text).toBe(`Due this week in ${deal.name}`);
  });

  test("AC4: the HTTP quick-action route, called with a hidden deal's projectId, leaves the name out of the response and the stored chat", { annotation: { type: "qa:TC", description: "missing" } }, async ({ admin, member, later }) => {
    await cleanChat(member, later);
    const { c, mode } = await ready(admin, member);
    if (!c.live || mode !== "admins") {
      test.info().annotations.push({
        type: "mode",
        description: `Staging is concierge ${c.live ? "on" : "off"}, CRM_VISIBLE=${mode}. A deal is not hidden from a Member in this mode, so this checks a project id that does not exist.`,
      });
      const before = await chat(member);
      const r = await quickAction(member, "due-week", "zz-http-missing");
      expect(r.status, r.body).toBe(404);
      expect(r.body).not.toContain("bug11");
      expect(r.body).not.toContain("ZZ-TEST");
      expect(await chat(member)).toBe(before);
      return;
    }
    const deal = await newDeal(admin, later, "bug11 http", [member]);
    const before = await chat(member);
    const r = await quickAction(member, "due-week", deal.id);
    expect(r.body, r.body).not.toContain(deal.name);
    const after = await chat(member);
    expect(after.length).toBeGreaterThan(before.length);
    expect(after).not.toContain(deal.name);
  });
});
