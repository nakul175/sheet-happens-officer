// SHO-BUG-11 Concierge quick action can return the name of a hidden deal (Linear APL-2646, PR #10).
// The issue's four unnumbered acceptance criteria are taken in order as AC1 to AC4, one test each.
// Each test checks at run time (tests/e2e/helpers/jim-gate.ts) that the concierge is on, which CRM_VISIBLE mode staging runs,
// and, where the AC needs the fix, that PR #10 is live; it skips with the reason otherwise. CRM_VISIBLE is a server setting the
// browser cannot change, and under `off` every CRM route is "not found", so no deal can be made: those cases stay skipped here
// and are covered by tests/crm-visible-quick.test.ts and tests/crm-visible-quick-http.test.ts (PR #10).
// Deals and organisations are ZZ-TEST and archived afterwards; the concierge chats are cleared (helpers/jim-http.ts cleanChat).
import { test, expect } from "../support";
import { chatMessages, cleanChat, newDeal, QUICK, quickAction } from "../helpers/jim-http";
import { conciergeLive, conciergeOff, crmModeLive, notLive, prLive, type CrmLive } from "../helpers/jim-gate";
import type { Who } from "../g2";

const WHY = "a hidden deal's name still reaches the chat.";
const COVERED = "Covered by tests/crm-visible-quick*.test.ts in PR #10, which start the server in each mode.";
const NEEDS_MODE = (want: string, mode: CrmLive) => `Needs staging started with CRM_VISIBLE=${want}; it runs ${mode} (a server setting the browser cannot change). ${COVERED}`;
const OFF = `Staging runs CRM_VISIBLE=off, where every CRM route is "not found", so the spec cannot create a deal. ${COVERED}`;

type Later = (fn: () => Promise<unknown>) => void;

/** Skips unless the concierge is on, staging hides deals from a Member (admins) and PR #10 is live. */
async function hiddenReady(admin: Who, member: Who, later: Later) {
  const c = await conciergeLive(admin);
  test.skip(!c.live, conciergeOff(c));
  const mode = await crmModeLive(admin, member);
  test.skip(mode === "off", OFF);
  test.skip(mode !== "admins", NEEDS_MODE("admins", mode));
  const gate = await prLive(10, admin, member, later);
  test.skip(!gate.deployed, notLive(gate, WHY));
}

const chat = async (who: Who) => JSON.stringify(await chatMessages(who));

async function expectHidden(who: Who, deal: { id: string; name: string }) {
  for (const id of QUICK) {
    const r = await quickAction(who, id, deal.id);
    expect(r.status, r.body).toBe(200);
    expect(r.json.messages?.at(-1)?.text).toBe("I can't find that.");
    expect(r.body).not.toContain(deal.name);
  }
  expect(await chat(who)).not.toContain(deal.name);
}

test.describe("SHO-BUG-11 / APL-2646", () => {
  test("AC1: a hidden deal's projectId yields \"I can't find that.\" and its name never reaches the chat", async ({ admin, member, later }) => {
    await cleanChat(member, later);
    await hiddenReady(admin, member, later);
    const deal = await newDeal(admin, later, "bug11 hidden", [member]);
    expect((await member.api.get("/api/deals")).status, "the deal list is hidden from a Member under admins").toBe(404);
    await expectHidden(member, deal);
  });

  test("AC2: holds for CRM_VISIBLE=admins (Member) and CRM_VISIBLE=off (Member and Admin)", async ({ admin, member, later }) => {
    await cleanChat(member, later);
    await hiddenReady(admin, member, later);
    // Only the admins half can run on a staging started with admins; the off half (Member and Admin) needs a server in off.
    test.info().annotations.push({ type: "partial", description: `CRM_VISIBLE=off (Member and Admin) is not checked here. ${COVERED}` });
    const deal = await newDeal(admin, later, "bug11 admins", [member]);
    await expectHidden(member, deal);
  });

  test("AC3: when the deal is visible (an Admin under admins), quick actions behave as today and name it", async ({ admin, later }) => {
    await cleanChat(admin, later);
    const c = await conciergeLive(admin);
    test.skip(!c.live, conciergeOff(c));
    const mode = await crmModeLive(admin, null);
    test.skip(mode === "off", OFF);
    // Unchanged behaviour, so this runs on main as well as on PR #10: an Admin sees deals under both all and admins.
    const deal = await newDeal(admin, later, "bug11 visible");
    const r = await quickAction(admin, "due-week", deal.id);
    expect(r.status, r.body).toBe(200);
    expect(r.json.messages?.[0]?.text).toBe(`Due this week in ${deal.name}`);
  });

  test("AC4: the HTTP quick-action route, called with a hidden deal's projectId, leaves the name out of the response and the stored chat", async ({ admin, member, later }) => {
    await cleanChat(member, later);
    await hiddenReady(admin, member, later);
    const deal = await newDeal(admin, later, "bug11 http", [member]);
    const before = await chat(member);
    const r = await quickAction(member, "due-week", deal.id);
    expect(r.status, r.body).toBe(200);
    expect(r.body).not.toContain(deal.name);
    const after = await chat(member);
    expect(after.length).toBeGreaterThan(before.length); // the exchange was stored...
    expect(after).not.toContain(deal.name); // ...without the deal's name
  });
});
