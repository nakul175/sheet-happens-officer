// SHO-BUG-11 Concierge quick action can return the name of a hidden deal (Linear APL-2646, PR #10).
// The issue's four unnumbered acceptance criteria are taken in order as AC1 to AC4.
// All skipped on staging: the concierge is off there until 26 Oct 2026, CRM_VISIBLE is a server setting the browser cannot change,
// and PR #10 is not merged to main. Covered by tests/crm-visible-quick.test.ts (vitest), which flips CRM_VISIBLE in-process.
// The bodies run as written once the concierge is on and staging is started with the CRM_VISIBLE mode named in each test.
import { test, expect, type Json } from "../support";
import { newDeal, raw, why } from "../helpers/jim-http";
import type { Who } from "../g2";

const CONCIERGE_OFF = "The concierge is off in staging until 26 Oct 2026.";
const NOT_MERGED = "Needs PR #10 (SHO-BUG-11) merged to main and deployed to staging.";
const NEEDS_MODE = (mode: string) => `Needs staging started with CRM_VISIBLE=${mode} (a server setting; the browser cannot change it).`;
const QUICK = ["due-week", "overdue", "waiting-on-me", "blocked", "recently-completed"];

/** POST a quick action scoped to a project, as `who`; returns the raw body so a name can be searched for anywhere in it. */
async function quick(who: Who, id: string, projectId: string) {
  const r = await raw(who, "POST", `/api/concierge/quick/${id}`, { projectId });
  return { status: r.status, json: r.json, body: JSON.stringify(r.json) };
}
/** The person's stored chat, as the concierge state returns it. */
const chat = async (who: Who) => JSON.stringify(((await who.api.get("/api/concierge/state")).json as Json).messages ?? []);

async function expectHidden(who: Who, deal: { id: string; name: string }) {
  for (const id of QUICK) {
    const r = await quick(who, id, deal.id);
    expect(r.status, r.body).toBe(200);
    expect(r.json.messages?.at(-1)?.text).toBe("I can't find that.");
    expect(r.body).not.toContain(deal.name);
  }
  expect(await chat(who)).not.toContain(deal.name);
}

test.describe("SHO-BUG-11 / APL-2646", () => {
  test.skip("AC1: a hidden deal's projectId yields \"I can't find that.\" and its name never reaches the chat", why(`${CONCIERGE_OFF} ${NOT_MERGED} ${NEEDS_MODE("admins")}`), async ({ admin, member, later }) => {
    const deal = await newDeal(admin, later, "bug11 hidden", [member]);
    expect((await member.api.get("/api/deals")).status, "the deal list is hidden from a Member under admins").not.toBe(200);
    await expectHidden(member, deal);
  });

  test.skip("AC2 (admins): under CRM_VISIBLE=admins a Member's quick actions on a hidden deal never name it", why(`${CONCIERGE_OFF} ${NOT_MERGED} ${NEEDS_MODE("admins")}`), async ({ admin, member, later }) => {
    const deal = await newDeal(admin, later, "bug11 admins", [member]);
    await expectHidden(member, deal);
  });

  test.skip("AC2 (off): under CRM_VISIBLE=off neither a Member nor an Admin gets the deal's name from a quick action", why(`${CONCIERGE_OFF} ${NOT_MERGED} ${NEEDS_MODE("off")}`), async ({ admin, member, later }) => {
    const deal = await newDeal(admin, later, "bug11 off", [member]);
    await expectHidden(member, deal);
    await expectHidden(admin, deal);
  });

  test.skip("AC3: when the deal is visible (an Admin under admins), quick actions behave as today and name it", why(`${CONCIERGE_OFF} ${NEEDS_MODE("admins")}`), async ({ admin, later }) => {
    const deal = await newDeal(admin, later, "bug11 visible");
    const r = await quick(admin, "due-week", deal.id);
    expect(r.status, r.body).toBe(200);
    expect(r.json.messages?.[0]?.text).toBe(`Due this week in ${deal.name}`);
  });

  test.skip("AC4: the HTTP quick-action route, called with a hidden deal's projectId, leaves the name out of the response and the stored chat", why(`${CONCIERGE_OFF} ${NOT_MERGED} ${NEEDS_MODE("admins or off")}`), async ({ admin, member, later }) => {
    const deal = await newDeal(admin, later, "bug11 http", [member]);
    const before = await chat(member);
    const r = await quick(member, "due-week", deal.id);
    expect(r.status, r.body).toBe(200);
    expect(r.body).not.toContain(deal.name);
    const after = await chat(member);
    expect(after.length).toBeGreaterThan(before.length); // the exchange was stored...
    expect(after).not.toContain(deal.name); // ...without the deal's name
  });
});
