// [SHO-TECH] Guard against hand-written project lookups that skip the visibility filters (Linear APL-2659, PR #32).
// AC1, AC2 and AC4 are the lint rule sho/no-unguarded-project-lookup: a direct db.project.findMany (and findFirst,
// findUnique, count) under src/, outside src/lib/access.ts, fails npm run lint and names visibleProjects, myProjects
// and projectAccess. The same read passes through visibleProjects, or with // project-lookup-ok: <reason>.
// Staging does not serve that source, so those three stay skipped here. The proof is tests/project-lookup-guard.test.ts
// in PR #32. AC5's npm test, npm run lint and the CRM_VISIBLE unit run are the same PR's tests/crm-visible.test.ts.
// What a request can show is the leak that rule exists to stop. A quick action on an archived project, or on a deal
// the CRM hides, must be "Project not found" and must not store the name. That runs when PR #32 is live
// (tests/e2e/helpers/jim-gate.ts: release SHA, then the archived-project probe) and skips otherwise.
// A project the person can see still answers, on main and on the PR. Projects, deals and chats are ZZ-TEST and cleaned up.
import { test, expect, login } from "../support";
import { newProject } from "../g2";
import { chatMessages, cleanChat, newDeal, quickAction, why } from "../helpers/jim-http";
import { crmModeLive, notLive, prLive, type CrmLive } from "../helpers/jim-gate";

const GUARD = "Staging does not serve the source. Covered by tests/project-lookup-guard.test.ts in PR #32.";
const NEEDS_ADMINS = (mode: CrmLive) => `Needs staging started with CRM_VISIBLE=admins so a Member cannot see the deal; it runs ${mode}.`;

test.describe("SHO-TECH / APL-2659", () => {
  test.skip("AC1: a direct db.project.findMany under src/ fails lint and the message names the helpers", why(GUARD), async () => {});

  test.skip("AC2: // project-lookup-ok: <reason> is the escape hatch, and an empty reason still fails", why(GUARD), async () => {});

  test.skip("AC4: the same fixture fails a raw findMany and passes that read through visibleProjects", why(GUARD), async () => {});

  test("a quick action on an archived project the person belongs to is Project not found, and the name is not stored", async ({ admin, later }) => {
    await cleanChat(admin, later);
    const gate = await prLive(32, admin, null, later);
    test.skip(!gate.deployed, notLive(gate, "a quick action on an archived project still names it."));
    const p = await newProject(admin, later, { label: "lookup archived" });
    expect((await admin.api.post(`/api/projects/${p.id}/archive`)).status).toBe(200);
    const r = await quickAction(admin, "due-week", p.id);
    const body = r.body;
    const pass = login("ADMIN").password;
    expect(r.status, body).toBe(404);
    expect(r.json.error).toBe("Project not found");
    expect(body.includes(p.name)).toBe(false);
    expect(body.includes(pass)).toBe(false);
    expect(JSON.stringify(await chatMessages(admin)).includes(p.name)).toBe(false);
  });

  test("a quick action on a deal the CRM hides from a Member is Project not found, and the name is not stored", async ({ admin, member, later }) => {
    await cleanChat(member, later);
    const gate = await prLive(32, admin, member, later);
    test.skip(!gate.deployed, notLive(gate, "a quick action scoped to a hidden deal can still name it."));
    const mode = await crmModeLive(admin, member);
    test.skip(mode === "off", "CRM_VISIBLE=off: every CRM route is not found, so the spec cannot create a deal.");
    test.skip(mode !== "admins", NEEDS_ADMINS(mode));
    const deal = await newDeal(admin, later, "lookup hidden", [member]);
    const r = await quickAction(member, "due-week", deal.id);
    const body = r.body;
    const pass = login("MEMBER").password;
    expect(r.status, body).toBe(404);
    expect(r.json.error).toBe("Project not found");
    expect(body.includes(deal.name)).toBe(false);
    expect(body.includes(pass)).toBe(false);
    expect(JSON.stringify(await chatMessages(member)).includes(deal.name)).toBe(false);
  });

  test("AC5: a project the person can see still answers a quick action and names it", async ({ admin, later }) => {
    // Unchanged on main and on PR #32. myProjects includes a live project the person belongs to.
    await cleanChat(admin, later);
    const p = await newProject(admin, later, { label: "lookup visible" });
    const r = await quickAction(admin, "due-week", p.id);
    const body = r.body;
    const pass = login("ADMIN").password;
    expect(r.status, body).toBe(200);
    expect(r.json.messages?.[0]?.text).toBe(`Due this week in ${p.name}`);
    expect(body.includes(pass)).toBe(false);
  });
});
