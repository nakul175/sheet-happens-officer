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
// The second describe is the local QA pass (quick actions, rebuilt change cards, stall and next-step notices,
// and the admin List / Search / Deals contract). It runs only against local next dev. On staging it is skipped,
// so a full story run keeps the tests above.
import { execFileSync } from "node:child_process";
import { test, expect, login, BASE_URL, zz } from "../support";
import { newProject, type Who } from "../g2";
import { chatMessages, cleanChat, newDeal, QUICK, quickAction, raw, why } from "../helpers/jim-http";
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

const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(BASE_URL);
const TOKEN = "APL2659";
type Later = (fn: () => Promise<unknown>) => void;

function db(args: string[]): string {
  return execFileSync("./node_modules/.bin/tsx", ["tests/e2e/stories/apl-2659-db.ts", ...args], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
  }).trim();
}

/** A ZZ-TEST deal created by the Admin, led by `leaderId` (a Member cannot create deals while CRM_VISIBLE=admins). */
async function dealAs(admin: Who, later: Later, label: string, leaderId: string) {
  const pipes = (await admin.api.get("/api/deals/pipelines")).json.pipelines as { id: string; key: string }[];
  const pipe = pipes.find((p) => p.key === "DEAL_PROACTIVE") ?? pipes[0];
  expect(pipe, "a deal pipeline").toBeTruthy();
  const org = await admin.api.post("/api/orgs", { name: zz(`${label} org`) });
  expect(org.status, JSON.stringify(org.json)).toBe(201);
  const orgId = org.json.organisation.id as string;
  later(() => admin.api.post(`/api/orgs/${orgId}/archive`));
  const name = zz(`${label} deal`);
  const ymd = new Date(Date.now() + 5.5 * 3600_000 + 3 * 86400_000).toISOString().slice(0, 10);
  const d = await admin.api.post("/api/deals", {
    name, organisationId: orgId, pipelineId: pipe.id, leaderId, whyPursue: "ZZ-TEST",
    nextStep: { title: zz("first step"), dueDate: ymd },
  });
  expect(d.status, JSON.stringify(d.json)).toBe(201);
  const id = d.json.deal.id as string;
  later(() => admin.api.post(`/api/projects/${id}/archive`));
  return { id, name };
}

const notes = async (who: Who) => ((await who.api.get("/api/notifications?limit=200")).json.items ?? []) as { text: string; href: string }[];
const ofDeal = (rows: { text: string; href: string }[], id: string, phrase: string) =>
  rows.filter((n) => n.href.includes(id) && n.text.includes(phrase));

async function stepId(who: Who, dealId: string, archived = false) {
  const r = await who.api.get(`/api/deals${archived ? "?archived=true" : ""}`);
  expect(r.status, JSON.stringify(r.json).slice(0, 300)).toBe(200);
  const row = (r.json.deals as { id: string; nextStep: { id: string } | null }[]).find((d) => d.id === dealId);
  expect(row?.nextStep?.id, "the deal's first next step").toBeTruthy();
  return row!.nextStep!.id;
}

/** Rebuild a stale change card. Confirm calls buildCard again when the fingerprint does not match. */
async function rebuild(who: Who, taskId: string) {
  const cardId = db(["card", who.user.id, taskId]);
  const r = await raw(who, "POST", `/api/concierge/cards/${cardId}/confirm`, {});
  return { status: r.status, body: JSON.stringify(r.json), chat: JSON.stringify(await chatMessages(who)) };
}

async function cookieFor(base: string, email: string, password: string) {
  const r = await fetch(`${base}/api/auth/signin`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) throw new Error(`sign-in on ${base} answered ${r.status}`);
  const cookie = r.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error(`sign-in on ${base} set no session`);
  return cookie;
}

async function getJson(base: string, cookie: string, path: string) {
  const r = await fetch(base + path, { headers: { cookie } });
  return { status: r.status, json: await r.json() };
}
function stable(rows: Record<string, unknown>[], keys: string[]) {
  return [...rows].map((row) => Object.fromEntries(keys.map((k) => [k, row[k] ?? null]))).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

test.describe("APL-2659 project-lookup guard", () => {
  test.beforeEach(async ({ request }) => {
    test.skip(!LOCAL, "Local next dev only. Staging runs the SHO-TECH / APL-2659 describe above.");
    const r = await request.get("/api/health");
    const body = (await r.json()) as { release?: string | null };
    test.info().annotations.push({ type: "release", description: body.release ?? "not reported" });
  });

  test("(a) a hidden deal's name is absent from quick actions and the stored chat", async ({ admin, member, later }) => {
    await cleanChat(member, later);
    expect((await member.api.get("/api/deals")).status, "CRM_VISIBLE=admins hides deals from a Member").toBe(404);
    const deal = await dealAs(admin, later, `${TOKEN} hidden`, member.user.id);
    for (const id of QUICK) {
      const r = await quickAction(member, id, deal.id);
      expect(r.status, r.body).toBe(404);
      expect(r.body).not.toContain(deal.name);
    }
    const unscoped = await raw(member, "POST", "/api/concierge/quick/due-week", {});
    expect(JSON.stringify(unscoped.json)).not.toContain(deal.name);
    expect(JSON.stringify(await chatMessages(member))).not.toContain(deal.name);
  });

  test("(a) an archived deal's name is absent from quick actions and the stored chat", async ({ admin, later }) => {
    await cleanChat(admin, later);
    const deal = await dealAs(admin, later, `${TOKEN} archived-quick`, admin.user.id);
    expect((await admin.api.post(`/api/projects/${deal.id}/archive`)).status).toBe(200);
    for (const id of QUICK) {
      const r = await quickAction(admin, id, deal.id);
      expect(r.status, r.body).toBe(404);
      expect(r.body).not.toContain(deal.name);
    }
    const unscoped = await raw(admin, "POST", "/api/concierge/quick/due-week", {});
    expect(JSON.stringify(unscoped.json)).not.toContain(deal.name);
    expect(JSON.stringify(await chatMessages(admin))).not.toContain(deal.name);
  });

  test("(a) a hidden deal's name is absent from a rebuilt concierge change card", async ({ admin, member, later }) => {
    await cleanChat(member, later);
    const deal = await dealAs(admin, later, `${TOKEN} hidden-card`, member.user.id);
    const taskId = await stepId(admin, deal.id);
    const card = await rebuild(member, taskId);
    expect(card.status, card.body.slice(0, 500)).toBe(409);
    expect(card.body).not.toContain(deal.name);
    expect(card.chat).not.toContain(deal.name);
  });

  test("(a) an archived deal's name is absent from a rebuilt concierge change card", async ({ admin, later }) => {
    await cleanChat(admin, later);
    const deal = await dealAs(admin, later, `${TOKEN} archived-card`, admin.user.id);
    const taskId = await stepId(admin, deal.id);
    expect((await admin.api.post(`/api/projects/${deal.id}/archive`)).status).toBe(200);
    const card = await rebuild(admin, taskId);
    expect(card.status, card.body.slice(0, 500)).toBe(409);
    expect(card.body).not.toContain(deal.name);
    expect(card.chat).not.toContain(deal.name);
  });

  test("(a) a visible project's name is still quoted on a rebuilt change card", async ({ admin, later }) => {
    await cleanChat(admin, later);
    const project = await newProject(admin, later, { label: `${TOKEN} visible-card` });
    const ymd = new Date(Date.now() + 5.5 * 3600_000 + 3 * 86400_000).toISOString().slice(0, 10);
    const made = await admin.api.post(`/api/projects/${project.id}/tasks`, { title: zz("visible task"), dueDate: ymd });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    const card = await rebuild(admin, made.json.task.id as string);
    expect(card.status, card.body.slice(0, 400)).toBe(409);
    expect(card.body).toContain(project.name);
    expect(card.chat).toContain(project.name);
  });

  test("(b) stalled-deal notices skip a Member leader and still reach an Admin leader", async ({ admin, member, later }) => {
    expect((await member.api.get("/api/deals")).status).toBe(404);
    const hidden = await dealAs(admin, later, `${TOKEN} stall-member`, member.user.id);
    const shown = await dealAs(admin, later, `${TOKEN} stall-admin`, admin.user.id);
    db(["age", hidden.id]);
    db(["age", shown.id]);
    const job = await fetch(`${BASE_URL}/api/jobs/stalled-deals`, {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.JOB_SECRET ?? ""}` },
    });
    const jobJson = (await job.json()) as { stalled?: number; notified?: number; error?: string };
    expect(job.status, JSON.stringify({ stalled: jobJson.stalled, notified: jobJson.notified, error: jobJson.error ?? null })).toBe(200);
    const phrase = "no activity for 30 days";
    expect(ofDeal(await notes(member), hidden.id, phrase)).toEqual([]);
    const adminNotes = ofDeal(await notes(admin), shown.id, phrase);
    expect(adminNotes).toHaveLength(1);
    expect(adminNotes[0].text).toContain(shown.name);
  });

  test("(b) next-step notices skip a Member leader and still reach an Admin leader", async ({ admin, member, later }) => {
    const hidden = await dealAs(admin, later, `${TOKEN} step-member`, member.user.id);
    const shown = await dealAs(admin, later, `${TOKEN} step-admin`, admin.user.id);
    expect((await admin.api.post(`/api/tasks/${await stepId(admin, hidden.id)}/complete`)).status).toBe(200);
    expect((await admin.api.post(`/api/tasks/${await stepId(admin, shown.id)}/complete`)).status).toBe(200);
    const phrase = "needs a next step";
    expect(ofDeal(await notes(member), hidden.id, phrase)).toEqual([]);
    const adminNotes = ofDeal(await notes(admin), shown.id, phrase);
    expect(adminNotes).toHaveLength(1);
    expect(adminNotes[0].text).toContain(shown.name);
  });

  test("(c) admin List, Search and Deals show the same records as before the guard", async ({ admin, member, later }) => {
    test.setTimeout(180_000);
    const project = await newProject(member, later, { label: `${TOKEN} list-project`, leader: member, creator: member });
    const liveDeal = await dealAs(admin, later, `${TOKEN} list-deal`, admin.user.id);
    const oldProject = await newProject(admin, later, { label: `${TOKEN} list-archived-project` });
    const oldDeal = await dealAs(admin, later, `${TOKEN} list-archived-deal`, admin.user.id);
    expect((await admin.api.post(`/api/projects/${oldProject.id}/archive`)).status).toBe(200);
    expect((await admin.api.post(`/api/projects/${oldDeal.id}/archive`)).status).toBe(200);

    const names = (j: { projects?: { name: string }[] }) => (j.projects ?? []).map((p) => p.name);
    const live = await admin.api.get("/api/projects");
    const archived = await admin.api.get("/api/projects?archived=true");
    expect(names(live.json)).toContain(project.name);
    expect(names(live.json)).not.toContain(liveDeal.name);
    expect(names(live.json)).not.toContain(oldProject.name);
    expect(names(archived.json)).toContain(oldProject.name);
    expect(names(archived.json)).not.toContain(oldDeal.name);

    const q = encodeURIComponent(TOKEN);
    const found = (j: { projects?: { name: string }[] }) => (j.projects ?? []).map((p) => p.name);
    const search = await admin.api.get(`/api/search?q=${q}`);
    const searchOld = await admin.api.get(`/api/search?q=${q}&archived=true`);
    for (const name of [project.name, liveDeal.name]) expect(found(search.json)).toContain(name);
    for (const name of [oldProject.name, oldDeal.name]) expect(found(search.json)).not.toContain(name);
    for (const name of [project.name, liveDeal.name, oldProject.name, oldDeal.name]) expect(found(searchOld.json)).toContain(name);

    const dealNames = (j: { deals?: { name: string }[] }) => (j.deals ?? []).map((d) => d.name);
    expect(dealNames((await admin.api.get("/api/deals")).json)).toContain(liveDeal.name);
    expect(dealNames((await admin.api.get("/api/deals")).json)).not.toContain(oldDeal.name);
    expect(dealNames((await admin.api.get("/api/deals?archived=true")).json)).toContain(oldDeal.name);

    const page = admin.page;
    await page.goto("/projects");
    await page.getByRole("button", { name: "All projects" }).click();
    await expect(page.getByRole("heading", { name: project.name })).toBeVisible();
    await expect(page.getByRole("heading", { name: oldProject.name })).toBeVisible();
    await expect(page.getByRole("heading", { name: liveDeal.name })).toHaveCount(0);

    await page.goto("/search");
    await page.getByLabel("Search").fill(TOKEN);
    await expect(page.getByRole("link", { name: liveDeal.name })).toBeVisible();
    await expect(page.getByRole("link", { name: project.name })).toBeVisible();
    await expect(page.getByRole("link", { name: oldDeal.name })).toHaveCount(0);
    await page.getByRole("checkbox", { name: "Include archived" }).check();
    await expect(page.getByRole("link", { name: oldDeal.name })).toBeVisible();
    await expect(page.getByRole("link", { name: oldProject.name })).toBeVisible();

    await page.goto("/deals");
    await expect(page.getByRole("link", { name: liveDeal.name })).toBeVisible();
    await expect(page.getByRole("link", { name: oldDeal.name })).toHaveCount(0);
    await page.getByRole("button", { name: "Show archived" }).click();
    await expect(page.getByRole("link", { name: oldDeal.name })).toBeVisible();

    const other = process.env.COMPARE_URL?.replace(/\/+$/, "");
    test.skip(!other, "COMPARE_URL is unset, so this run checks the admin contract on this server only.");
    if (!other || !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(other)) return;
    const email = process.env.SHO_ADMIN_EMAIL ?? "";
    const password = process.env.SHO_ADMIN_PASS ?? "";
    const here = await cookieFor(BASE_URL, email, password);
    const there = await cookieFor(other, email, password);
    const paths = ["/api/projects", "/api/projects?archived=true", "/api/deals", "/api/deals?archived=true", `/api/search?q=${q}`, `/api/search?q=${q}&archived=true`];
    for (const path of paths) {
      const a = await getJson(BASE_URL, here, path);
      const b = await getJson(other, there, path);
      expect(a.status, path).toBe(200);
      expect(b.status, path).toBe(200);
      const key = path.includes("/api/deals") ? "deals" : "projects";
      const rows = (j: { json: Record<string, unknown> }) => (j.json[key] as Record<string, unknown>[]) ?? [];
      const fields = path.includes("/api/deals")
        ? ["id", "name", "archived", "stalled", "needsNextStep"]
        : path.includes("/api/search")
          ? ["id", "name", "archived", "type"]
          : ["id", "name", "archived", "openTasks", "myRole"];
      expect(stable(rows(b), fields), `${path} on ${other} differs`).toEqual(stable(rows(a), fields));
    }
  });
});
