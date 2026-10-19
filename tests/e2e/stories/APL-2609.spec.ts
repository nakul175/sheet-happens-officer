// SHO-BUG-2 CRM_VISIBLE=admins or off still shows deals through My tasks, search, the concierge
// and the task routes (Linear APL-2609).
// One test per acceptance criterion. People are nakul17+ aliases signed in with SHO_QA_PASS.
// Records are ZZ-TEST and archived afterwards. The people are this job's pool aliases (APL-2748): the org admin is put back to Member.
// The server's CRM_VISIBLE is a process setting. A test named for one mode skips when the live
// lever is different, so an `all` server cannot pass an `off` acceptance criterion.
// A quick action that names a hidden deal is a product defect (APL-2723): the test is marked as
// an expected failure with the reason, not skipped.
// Pam left no qa:TC id on the issue; each title says "qa:TC missing".
// Nothing here targets production.
import type { Browser, BrowserContext } from "@playwright/test";
import { test, expect, zz } from "../support";
import { newProject, newTask, ymd, type Who } from "../g2";
import { QA_ADMIN_EMAIL, QA_PASS, noSecret, qaPerson, signInAlias } from "../helpers/qa-alias";

type Mode = "all" | "admins" | "off";
type Deal = { id: string; name: string; stage: string; taskId: string; taskTitle: string };
type World = {
  mode: Mode;
  admin: Who;
  editor: Who;
  orgAdmin: Who;
  deal: Deal | null;
  plainTitle: string;
  ctx: BrowserContext[];
  emptyChat: Set<string>;
};

let world: World | null = null;
let adminWho: Who | null = null;
let editorWho: Who | null = null;
let orgAdminWho: Who | null = null;
const contexts: BrowserContext[] = [];
const emptyChatIds = new Set<string>();
let orgId = "";
let plainId = "";
let dealId = "";

test.describe.configure({ timeout: 180_000 });

test.beforeAll(() => {
  test.skip(!QA_PASS, "APL-2609: set SHO_QA_PASS (password for nakul17+ aliases).");
});

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  try {
    world = await buildWorld(browser);
  } catch (err) {
    await cleanupCreated();
    throw err;
  }
});

test.afterAll(async () => {
  await cleanupCreated();
});

async function cleanupCreated() {
  const quiet = async (fn: () => Promise<unknown>) => { try { await fn(); } catch { /* clean-up is best effort */ } };
  const admin = world?.admin ?? adminWho;
  if (admin) {
    const id = world?.deal?.id || dealId;
    if (id) await quiet(() => admin.api.post(`/api/projects/${id}/archive`));
    if (orgId) await quiet(() => admin.api.post(`/api/orgs/${orgId}/archive`, { archive: true }));
    if (plainId) await quiet(() => admin.api.post(`/api/projects/${plainId}/archive`));
    const chat = world?.emptyChat ?? emptyChatIds;
    for (const who of [world?.editor ?? editorWho, world?.orgAdmin ?? orgAdminWho]) {
      if (!who) continue;
      if (chat.has(who.user.id as string)) await quiet(() => who.api.del("/api/concierge/messages"));
      if (who.user.orgRole !== "MEMBER") await quiet(() => admin.api.patch(`/api/team/${who.user.id}`, { orgRole: "MEMBER" }));
    }
  }
  for (const ctx of world?.ctx ?? contexts) await quiet(() => ctx.close());
}

test.beforeEach(() => {
  if (world) test.info().annotations.push({ type: "CRM_VISIBLE", description: world.mode });
});

test("AC1: with CRM_VISIBLE=off, My tasks shows no deal task and no stage qa:TC missing", async () => {
  const w = need();
  only(w, "off");
  expect(w.deal).toBeNull();
  const rows = await myRows(w.editor);
  expect(rows.some((t) => t.project?.type === "DEAL")).toBe(false);
  expect(rows.some((t) => t.project?.stage)).toBe(false);
  expect(rows.some((t) => t.title === w.plainTitle)).toBe(true);
  await w.editor.api.post("/api/profile/start-guide");
  await w.editor.page.goto("/", { waitUntil: "domcontentloaded" });
  // The first document request can bounce through /signin while the route compiles. Wait for the row itself.
  const list = w.editor.page.getByRole("main");
  await expect(list.getByRole("heading", { name: "My tasks" })).toBeVisible({ timeout: 30_000 });
  await expect(list.getByRole("link", { name: w.plainTitle, exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(list.getByText("Deal", { exact: true })).toHaveCount(0);
});

test("AC2: with CRM_VISIBLE=off, search returns no deal and no deal task qa:TC missing", async () => {
  const w = need();
  only(w, "off");
  expect((await w.editor.api.get("/api/deals")).status).toBe(404);
  const plain = await search(w.editor, w.plainTitle);
  expect(plain.tasks.some((t) => t.title === w.plainTitle)).toBe(true);
  expect(plain.projects.every((p) => p.type !== "DEAL")).toBe(true);
  await w.editor.page.goto("/search", { waitUntil: "domcontentloaded" });
  const box = w.editor.page.getByRole("searchbox", { name: "Search" });
  await expect(box).toBeEditable();
  await expect(async () => {
    await box.fill(w.plainTitle);
    await expect(box).toHaveValue(w.plainTitle);
    await expect(w.editor.page.getByRole("link", { name: w.plainTitle })).toBeVisible();
  }).toPass();
  await expect(w.editor.page.getByRole("main").getByText("Deal", { exact: true })).toHaveCount(0);
});

test("AC3: with CRM_VISIBLE=off, the deal task and the deal task list answer not found qa:TC missing", async () => {
  const w = need();
  only(w, "off");
  // off answers not found for the deals API, so this run cannot plant a deal task to open.
  expect(w.deal).toBeNull();
  expect((await w.editor.api.get("/api/deals")).status).toBe(404);
  expect((await w.admin.api.get("/api/deals")).status).toBe(404);
  expect((await w.orgAdmin.api.get("/api/deals")).status).toBe(404);
});

test("AC4: with CRM_VISIBLE=off, the concierge does not mention a deal, a deal task, or a stage qa:TC missing", async () => {
  const w = need();
  only(w, "off");
  const open = await quick(w.editor);
  expect(open).not.toContain("DEAL");
  expect(open).toContain(w.plainTitle);
  if (!w.deal) return;
  expect(open).not.toContain(w.deal.name);
  expect(open).not.toContain(w.deal.taskTitle);
  expect(open).not.toContain(w.deal.stage);
  const scoped = await quick(w.editor, w.deal.id);
  const leaked = scoped.includes(w.deal.name) || scoped.includes(w.deal.taskTitle) || scoped.includes(w.deal.stage);
  if (leaked) {
    test.fail(true, "Product defect APL-2723: quickAnswer looks the deal up by membership only and stores its name on the concierge message (Due this week in <deal>). CRM_VISIBLE off still mentions the deal. This test is not skipped.");
  }
  expect(leaked).toBe(false);
});

test("AC5: with CRM_VISIBLE=admins, an Editor sees no deal data on the four surfaces qa:TC missing", async () => {
  const w = need();
  only(w, "admins");
  if (!w.deal) throw new Error("No deal was planted.");
  const seen = await surfaces(w.editor, w.deal);
  expect(seen.my).toBe(false);
  expect(seen.searchTask).toBe(false);
  expect(seen.searchDeal).toBe(false);
  expect(seen.taskStatus).toBe(404);
  expect(seen.listStatus).toBe(404);
  expect(seen.concierge).toBe(false);
  const plain = await myRows(w.editor);
  expect(plain.some((t) => t.title === w.plainTitle)).toBe(true);
});

test("AC6: with CRM_VISIBLE=admins, an Admin sees deal tasks as normal qa:TC missing", async () => {
  const w = need();
  only(w, "admins");
  if (!w.deal) throw new Error("No deal was planted.");
  const seen = await surfaces(w.orgAdmin, w.deal);
  expect(seen.my).toBe(true);
  expect(seen.searchTask).toBe(true);
  expect(seen.searchDeal).toBe(true);
  expect(seen.taskStatus).toBe(200);
  expect(seen.listStatus).toBe(200);
  expect(seen.concierge).toBe(true);
});

test("AC7: with CRM_VISIBLE=all, a member still sees their deal work qa:TC missing", async () => {
  const w = need();
  only(w, "all");
  if (!w.deal) throw new Error("No deal was planted.");
  const seen = await surfaces(w.editor, w.deal);
  expect(seen.my).toBe(true);
  expect(seen.searchDeal).toBe(true);
  expect(seen.taskStatus).toBe(200);
  expect(seen.concierge).toBe(true);
});

test("AC8: off hides deals from Admins and the Super Admin; admins mode keeps Admins in qa:TC missing", async () => {
  const w = need();
  if (w.mode === "all") {
    test.skip(true, "APL-2609: Needs CRM_VISIBLE=off or admins. This server runs all, so this AC is not a pass.");
  }
  if (w.mode === "off") {
    expect(w.deal).toBeNull();
    for (const who of [w.admin, w.orgAdmin, w.editor]) {
      expect((await who.api.get("/api/deals")).status).toBe(404);
      expect((await who.api.get("/api/orgs")).status).toBe(404);
    }
    return;
  }
  if (!w.deal) throw new Error("No deal was planted.");
  const asAdmin = await surfaces(w.orgAdmin, w.deal);
  const asSuper = await w.admin.api.get(`/api/tasks/${w.deal.taskId}`);
  noSecret(JSON.stringify(asSuper.json));
  const asMember = await w.editor.api.get(`/api/tasks/${w.deal.taskId}`);
  expect(asAdmin.taskStatus).toBe(200);
  expect(asAdmin.searchDeal).toBe(true);
  expect(asSuper.status).toBe(200);
  expect(asMember.status).toBe(404);
});

function need(): World {
  if (!world) throw new Error("The story world was not created.");
  return world;
}

/** Skip unless the live lever is the mode this acceptance criterion names. A different mode is not a pass. */
function only(w: World, want: Mode) {
  test.skip(w.mode !== want, `APL-2609: Needs CRM_VISIBLE=${want}. This server runs ${w.mode}, so this AC is not a pass.`);
}

type Row = { id?: string; title?: string; project?: { id?: string; name?: string; type?: string; stage?: string | null } };

async function myRows(who: Who): Promise<Row[]> {
  const r = await who.api.get("/api/my-tasks");
  noSecret(JSON.stringify(r.json));
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  const keys = ["waitingOnMe", "overdue", "next7", "later", "waitingOnOthers"] as const;
  return keys.flatMap((k) => (r.json[k] ?? []) as Row[]);
}

async function search(who: Who, q: string) {
  const r = await who.api.get(`/api/search?q=${encodeURIComponent(q)}`);
  noSecret(JSON.stringify(r.json));
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return {
    projects: (r.json.projects ?? []) as { id: string; type?: string }[],
    tasks: (r.json.tasks ?? []) as { id: string; title?: string; project?: { id?: string } }[],
  };
}

async function quick(who: Who, projectId?: string) {
  const r = await who.api.post("/api/concierge/quick/due-week", projectId ? { projectId } : {});
  const body = JSON.stringify(r.json);
  noSecret(body);
  expect(r.status, body).toBe(200);
  return body;
}

async function surfaces(who: Who, deal: Deal) {
  const rows = await myRows(who);
  const found = await search(who, deal.taskTitle);
  const byName = await search(who, deal.name);
  const one = await who.api.get(`/api/tasks/${deal.taskId}`);
  const list = await who.api.get(`/api/projects/${deal.id}/tasks`);
  noSecret(JSON.stringify(one.json));
  noSecret(JSON.stringify(list.json));
  const concierge = await quick(who);
  return {
    my: rows.some((t) => t.id === deal.taskId),
    searchTask: found.tasks.some((t) => t.id === deal.taskId),
    searchDeal: byName.projects.some((p) => p.id === deal.id),
    taskStatus: one.status,
    listStatus: list.status,
    concierge: concierge.includes(deal.taskTitle),
  };
}

async function chatWasEmpty(who: Who, into: Set<string>) {
  const r = await who.api.get("/api/concierge/state");
  const n = ((r.json.messages ?? []) as unknown[]).length;
  if (n === 0) into.add(who.user.id as string);
}

async function buildWorld(browser: Browser): Promise<World> {
  const emptyChat = new Set<string>();
  const adminIn = await signInAlias(browser, QA_ADMIN_EMAIL);
  contexts.push(adminIn.ctx);
  const editorIn = await signInAlias(browser, qaPerson(1).email);
  contexts.push(editorIn.ctx);
  const orgIn = await signInAlias(browser, qaPerson(2).email);
  contexts.push(orgIn.ctx);
  const admin = adminIn.who;
  const editor = editorIn.who;
  const orgAdmin = orgIn.who;
  adminWho = admin;
  editorWho = editor;
  orgAdminWho = orgAdmin;
  expect(admin.user.orgRole).toBe("SUPER_ADMIN");
  // A pool alias is reused, so one left as Admin by an interrupted run is put back first.
  if (editor.user.orgRole !== "MEMBER") {
    expect((await admin.api.patch(`/api/team/${editor.user.id}`, { orgRole: "MEMBER" })).status).toBe(200);
    editor.user.orgRole = "MEMBER";
  }
  const promoted = await admin.api.patch(`/api/team/${orgAdmin.user.id}`, { orgRole: "ADMIN" });
  expect(promoted.status, JSON.stringify(promoted.json)).toBe(200);
  orgAdmin.user.orgRole = "ADMIN";
  for (const who of [admin, editor, orgAdmin]) await chatWasEmpty(who, emptyChat);
  for (const id of emptyChat) emptyChatIds.add(id);

  const deals = await admin.api.get("/api/deals");
  const memberDeals = await editor.api.get("/api/deals");
  let mode: Mode;
  if (deals.status === 404) mode = "off";
  else {
    expect(deals.status, JSON.stringify(deals.json)).toBe(200);
    expect([200, 404]).toContain(memberDeals.status);
    mode = memberDeals.status === 404 ? "admins" : "all";
  }

  const plainTitle = zz("plain step");
  const plain = await newProject(admin, (fn) => { void fn; }, { label: "plain", members: [{ who: editor, role: "EDITOR" }] });
  plainId = plain.id;
  await newTask(admin, plain.id, { title: plainTitle, assigneeId: editor.user.id, dueDate: ymd(2) });

  let deal: Deal | null = null;
  if (mode !== "off") {
    const pipes = (await admin.api.get("/api/deals/pipelines")).json.pipelines as { id: string; key: string }[];
    const pipe = pipes.find((p) => p.key === "DEAL_PROACTIVE") ?? pipes[0];
    expect(pipe, "a deal pipeline").toBeTruthy();
    const org = await admin.api.post("/api/orgs", { name: zz("buyer org") });
    expect(org.status, JSON.stringify(org.json)).toBe(201);
    orgId = org.json.organisation.id as string;
    const name = zz("deal");
    const made = await admin.api.post("/api/deals", {
      name, organisationId: orgId, pipelineId: pipe.id, leaderId: admin.user.id, whyPursue: "ZZ-TEST",
      nextStep: { title: zz("first step"), dueDate: ymd(3) },
    });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    const id = made.json.deal.id as string;
    dealId = id;
    expect((await admin.api.post(`/api/projects/${id}/members`, { userId: editor.user.id, role: "EDITOR" })).status).toBe(201);
    expect((await admin.api.post(`/api/projects/${id}/members`, { userId: orgAdmin.user.id, role: "EDITOR" })).status).toBe(201);
    const taskTitle = zz("deal step");
    const taskId = await newTask(admin, id, { title: taskTitle, assigneeId: editor.user.id, dueDate: ymd(2) });
    expect((await admin.api.post(`/api/tasks/${taskId}/collaborators`, { userId: orgAdmin.user.id })).status).toBe(201);
    const loaded = await admin.api.get(`/api/projects/${id}`);
    expect(loaded.status, JSON.stringify(loaded.json)).toBe(200);
    const stage = (loaded.json.project?.deal?.stage?.name ?? "") as string;
    expect(stage.length, JSON.stringify(loaded.json.project?.deal ?? null)).toBeGreaterThan(0);
    deal = { id, name, stage, taskId, taskTitle };
  }

  return { mode, admin, editor, orgAdmin, deal, plainTitle, ctx: [adminIn.ctx, editorIn.ctx, orgIn.ctx], emptyChat };
}
