// SHO-BUG-11 Concierge quick action can return the name of a hidden deal (Linear APL-2646, PR #10).
// A hidden deal, an archived project, and a project the person is not in are the same 404 "Project not found".
// The name never reaches the response or the stored chat, which is the history the next model request would send.
// Each test checks at run time (tests/e2e/helpers/jim-gate.ts) that the concierge is on, which CRM_VISIBLE mode staging runs,
// and that PR #10 is live; it skips with the reason otherwise. CRM_VISIBLE is a server setting the browser cannot change,
// and under `off` every CRM route is "not found", so no deal can be made: those cases stay skipped here
// and are covered by tests/crm-visible-quick.test.ts and tests/crm-visible-quick-http.test.ts (PR #10).
// Deals and organisations are ZZ-TEST and archived afterwards; the concierge chats are cleared (helpers/jim-http.ts cleanChat).
import { test, expect } from "../support";
import { newProject, type Who } from "../g2";
import { chatMessages, cleanChat, newDeal, QUICK, raw } from "../helpers/jim-http";
import { conciergeLive, conciergeOff, crmModeLive, notLive, prLive, type CrmLive } from "../helpers/jim-gate";

const WHY = "a hidden deal's name still reaches the chat.";
const COVERED = "Covered by tests/crm-visible-quick*.test.ts in PR #10, which start the server in each mode.";
const NEEDS_MODE = (want: string, mode: CrmLive) => `Needs staging started with CRM_VISIBLE=${want}; it runs ${mode} (a server setting the browser cannot change). ${COVERED}`;
const OFF = `Staging runs CRM_VISIBLE=off, where every CRM route is "not found", so the spec cannot create a deal. ${COVERED}`;

type Later = (fn: () => Promise<unknown>) => void;

/** Headers the quick-action route sets on purpose: content-type, and x-* (undo) headers. Transport headers such as date are left out. */
function headersThatMatter(headers: Record<string, string>) {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k === "content-type" || k.startsWith("x-")) out[k] = v;
  }
  return out;
}

/** POST a scoped quick action and keep the status, the headers that matter, and the JSON body. */
async function scoped(who: Who, id: string, projectId: string) {
  const r = await raw(who, "POST", `/api/concierge/quick/${id}`, { projectId });
  return { status: r.status, headers: headersThatMatter(r.headers), body: JSON.stringify(r.json), json: r.json };
}

/** Stored rows created since `before`, ignoring id and createdAt. A 404 writes none. */
async function storedDelta(who: Who, before: Set<string>) {
  return (await chatMessages(who)).filter((m) => !before.has(m.id)).map((m) => ({ role: m.role, text: m.text }));
}

const chatIds = async (who: Who) => new Set((await chatMessages(who)).map((m) => m.id));

// File-level skip. Runs before the admin fixture, which throws "Set SHO_ADMIN_EMAIL" when that variable is unset.
test.beforeAll(() => {
  test.skip(!process.env.SHO_QA_PASS, "Set SHO_QA_PASS (the password for nakul17+ aliases).");
});

/** Skips unless the concierge is on and PR #10 is live. Hidden-deal cases also need CRM_VISIBLE=admins. */
async function ready(admin: Who, member: Who, later: Later, opts: { admins?: boolean } = {}) {
  const c = await conciergeLive(admin);
  test.skip(!c.live, conciergeOff(c));
  const mode = await crmModeLive(admin, member);
  if (opts.admins) {
    test.skip(mode === "off", OFF);
    test.skip(mode !== "admins", NEEDS_MODE("admins", mode));
  }
  const gate = await prLive(10, admin, member, later);
  test.skip(!gate.deployed, notLive(gate, WHY));
  return mode;
}

test.describe("SHO-BUG-11 / APL-2646", () => {
  // qa:TC-APL2646-4346ccb6@v2 · ACa. Due this week on an archived project is the non-member refusal.
  // qa:TC-APL2646-e08272d4@v2 · ACa. The name is absent from the stored thread, which is the next model request's history.
  test("ACa: an archived project a member belongs to is the same 404 as a project they cannot see, and the name is not stored (qa:TC-APL2646-4346ccb6@v2, qa:TC-APL2646-e08272d4@v2)", async ({ admin, member, later }) => {
    await cleanChat(member, later);
    await ready(admin, member, later);
    const vault = await newProject(admin, later, { label: "bug11 archived", members: [{ who: member, role: "EDITOR" }] });
    expect((await admin.api.post(`/api/projects/${vault.id}/archive`)).status).toBe(200);
    expect((await member.api.get(`/api/projects/${vault.id}`)).json.project.archived).toBe(true);
    const other = await newProject(admin, later, { label: "bug11 other" });

    const refBefore = await chatIds(member);
    const reference = await scoped(member, "due-week", other.id);
    const referenceRows = await storedDelta(member, refBefore);
    expect(reference.status, reference.body).toBe(404);
    expect(reference.json.error).toBe("Project not found");
    expect(reference.body).not.toContain(vault.name);

    const before = await chatIds(member);
    const r = await scoped(member, "due-week", vault.id);
    expect(r.status, r.body).toBe(reference.status);
    expect(r.headers).toEqual(reference.headers);
    expect(r.body).toBe(reference.body);
    expect(r.body).not.toContain(vault.name);
    expect(await storedDelta(member, before)).toEqual(referenceRows);
    const thread = JSON.stringify(await chatMessages(member));
    expect(thread).not.toContain(vault.name);
  });

  // qa:TC-APL2646-1311c0f3@v2 · ACb. Hidden deal and a project the caller is not in: same status, headers, and body.
  // qa:TC-APL2646-2010a576@v2 · ACb. The stored thread does not name the deal, and an Admin (who can see it) still gets the name.
  test("ACb: a hidden deal and a project the person is not in return the same status, headers, and body (qa:TC-APL2646-1311c0f3@v2, qa:TC-APL2646-2010a576@v2)", async ({ admin, member, later }) => {
    await cleanChat(member, later);
    await cleanChat(admin, later);
    await ready(admin, member, later, { admins: true });
    const deal = await newDeal(admin, later, "bug11 hidden", [member]);
    const other = await newProject(admin, later, { label: "bug11 plain" });
    expect((await member.api.get("/api/deals")).status, "the deal list is hidden from a Member under admins").toBe(404);

    for (const id of QUICK) {
      const leftBefore = await chatIds(member);
      const left = await scoped(member, id, deal.id);
      const leftRows = await storedDelta(member, leftBefore);
      const rightBefore = await chatIds(member);
      const right = await scoped(member, id, other.id);
      const rightRows = await storedDelta(member, rightBefore);
      expect(left.status, `${id} ${left.body}`).toBe(404);
      expect(left.json.error).toBe("Project not found");
      expect(right.status).toBe(left.status);
      expect(right.headers).toEqual(left.headers);
      expect(right.body).toBe(left.body);
      expect(left.body).not.toContain(deal.name);
      expect(JSON.stringify(leftRows) + JSON.stringify(rightRows)).not.toContain(deal.name);
      expect(leftRows).toEqual(rightRows);
    }
    expect(JSON.stringify(await chatMessages(member))).not.toContain(deal.name);

    // Visible control on this staging: an Admin still sees the deal under admins. CRM_VISIBLE=all is the unit test's control.
    test.info().annotations.push({ type: "partial", description: `CRM_VISIBLE=all, and the next model request, are checked in tests/crm-visible-quick.test.ts. ${COVERED}` });
    const named = await scoped(admin, "due-week", deal.id);
    expect(named.status, named.body).toBe(200);
    expect(named.body).toContain(`Due this week in ${deal.name}`);
  });

  // qa:TC-APL2646-1e6ed728@v2 · ACc. Due this week for a deal member is the non-member refusal, with no stored "Due this week in <deal>".
  test("ACc: a deal member's due-week is the reference refusal, and the thread has no 'Due this week in <deal>' (qa:TC-APL2646-1e6ed728@v2)", async ({ admin, member, later }) => {
    await cleanChat(member, later);
    await ready(admin, member, later, { admins: true });
    const deal = await newDeal(admin, later, "bug11 due", [member]);
    const other = await newProject(admin, later, { label: "bug11 ref" });
    const refBefore = await chatIds(member);
    const reference = await scoped(member, "due-week", other.id);
    const referenceRows = await storedDelta(member, refBefore);
    expect(reference.status).toBe(404);
    expect(reference.json.error).toBe("Project not found");
    const before = await chatIds(member);
    const r = await scoped(member, "due-week", deal.id);
    expect(r.status).toBe(reference.status);
    expect(r.headers).toEqual(reference.headers);
    expect(r.body).toBe(reference.body);
    const rows = await storedDelta(member, before);
    expect(rows).toEqual(referenceRows);
    const stored = JSON.stringify(rows);
    expect(stored).not.toContain(`Due this week in ${deal.name}`);
    expect(stored).not.toContain(deal.name);
  });

  // qa:TC-APL2646-df616fe9@v2 · ACc. UI: Due this week no longer shows a hidden deal's name, at 1280 and at 390.
  test("ACc UI: Due this week hides a hidden deal's name at 1280 and at 390 (qa:TC-APL2646-df616fe9@v2)", async ({ admin, member, later }) => {
    test.setTimeout(120_000);
    await cleanChat(member, later);
    await ready(admin, member, later, { admins: true });
    const deal = await newDeal(admin, later, "bug11 screen", [member]);
    const page = member.page;

    for (const [width, height] of [[1280, 800], [390, 844]] as const) {
      await page.setViewportSize({ width, height });
      await page.goto(`/projects/${deal.id}`);
      await expect(page.getByRole("heading", { name: "This project isn't available" })).toBeVisible();
      if (width >= 1280) {
        await page.getByRole("button", { name: /^Concierge/ }).click();
      } else {
        await page.getByRole("button", { name: "More" }).click();
        await page.getByRole("menuitem", { name: "Concierge" }).click();
      }
      const dialog = page.getByRole("dialog", { name: "Concierge" });
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Due this week here" }).click();
      await expect(dialog.getByRole("alert")).toContainText("Project not found");
      await expect(dialog).not.toContainText(deal.name);
      await expect(page.locator("body")).not.toContainText(deal.name);
      await page.keyboard.press("Escape");
    }

    const stored = JSON.stringify(await chatMessages(member));
    expect(stored).not.toContain(deal.name);
    expect(stored).not.toContain(`Due this week in ${deal.name}`);
  });
});
