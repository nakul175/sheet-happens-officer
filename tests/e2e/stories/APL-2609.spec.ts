// SHO-BUG-2 CRM_VISIBLE=admins or off still shows deals through My tasks, search, the concierge
// and the task routes (Linear APL-2609).
// One test per acceptance criterion. People are nakul17+ aliases signed in with SHO_QA_PASS.
// Records are ZZ-TEST and archived afterwards; the extra people are deactivated.
// The server's CRM_VISIBLE is a process setting. Each test checks the lever for the mode this
// server is actually running (all, admins, or off). A quick action that names a hidden deal is a
// product defect: the test is marked as an expected failure with the reason, not skipped.
// The only skip is a missing SHO_QA_PASS. Nothing here targets production.
import type { Browser, BrowserContext } from "@playwright/test";
import { test, expect, zz } from "../support";
import { newProject, newTask, ymd, type Who } from "../g2";
import { QA_PASS, noSecret, qaEmail, signInAlias } from "../helpers/qa-alias";

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
  test.skip(!QA_PASS, "Set SHO_QA_PASS (the password for nakul17+ aliases).");
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
      await quiet(() => admin.api.post(`/api/team/${who.user.id}/deactivate`, { reassign: "leaders" }));
    }
  }
  for (const ctx of world?.ctx ?? contexts) await quiet(() => ctx.close());
}

test.beforeEach(() => {
  if (world) test.info().annotations.push({ type: "CRM_VISIBLE", description: world.mode });
});

test("AC1: with CRM_VISIBLE=off, My tasks shows no deal task and no stage", async () => {
  const w = need();
  const hide = hides(w.mode, "MEMBER");
  if (!w.deal && w.mode !== "off") throw new Error("No deal was planted.");
  const rows = await myRows(w.editor);
  if (w.deal) {
    const hit = rows.filter((t) => t.id === w.deal!.taskId);
    expect(hit.length > 0).toBe(!hide);
    if (!hide) expect(hit[0].project?.stage).toBe(w.deal.stage);
    if (hide) expect(JSON.stringify(rows)).not.toContain(w.deal.name);
  } else {
    expect(rows.some((t) => t.project?.type === "DEAL")).toBe(false);
  }
  expect(rows.some((t) => t.title === w.plainTitle)).toBe(true);
  await w.editor.api.post("/api/profile/start-guide");
  await w.editor.page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(w.editor.page.getByRole("heading", { name: "My tasks" })).toBeVisible();
  await expect(w.editor.page.getByRole("status", { name: "Loading" })).toHaveCount(0, { timeout: 30_000 });
  await expect(w.editor.page.getByText(w.plainTitle).first()).toBeVisible();
  if (w.deal && hide) {
    await expect(w.editor.page.getByText(w.deal.taskTitle)).toHaveCount(0);
    await expect(w.editor.page.getByText(w.deal.name)).toHaveCount(0);
  }
  if (w.deal && !hide) {
    await expect(w.editor.page.getByText(w.deal.taskTitle).first()).toBeVisible();
    const byProject = w.editor.page.getByRole("button", { name: "By project" });
    if (await byProject.count()) {
      await byProject.click();
      await expect(w.editor.page.getByText(w.deal.stage).first()).toBeVisible();
    }
  }
  if (w.mode !== "off") {
    test.info().annotations.push({ type: "note", description: `This server runs CRM_VISIBLE=${w.mode}. My tasks was checked for that mode.` });
  }
});

test("AC2: with CRM_VISIBLE=off, search returns no deal and no deal task", async () => {
  const w = need();
  if (!w.deal) {
    expect((await w.editor.api.get("/api/deals")).status).toBe(404);
    const searched = await w.editor.api.get(`/api/search?q=${encodeURIComponent(w.plainTitle)}`);
    noSecret(JSON.stringify(searched.json));
    expect((searched.json.projects as { type?: string }[]).every((p) => p.type !== "DEAL")).toBe(true);
    return;
  }
  const hide = hides(w.mode, "MEMBER");
  const byTitle = await search(w.editor, w.deal.taskTitle);
  const byName = await search(w.editor, w.deal.name);
  expect(byTitle.tasks.some((t) => t.id === w.deal!.taskId)).toBe(!hide);
  expect(byName.projects.some((p) => p.id === w.deal!.id)).toBe(!hide);
  expect(byTitle.tasks.some((t) => t.project?.id === w.deal!.id)).toBe(!hide);
  const plain = await search(w.editor, w.plainTitle);
  expect(plain.tasks.some((t) => t.title === w.plainTitle)).toBe(true);
  await w.editor.page.goto("/search", { waitUntil: "domcontentloaded" });
  const box = w.editor.page.getByRole("searchbox", { name: "Search" });
  await expect(box).toBeEditable();
  const title = w.deal.taskTitle;
  await expect(async () => {
    await box.fill(title);
    await expect(box).toHaveValue(title);
  }).toPass();
  if (hide) await expect(w.editor.page.getByText(/Nothing matches/)).toBeVisible();
  else await expect(w.editor.page.getByText(w.deal.taskTitle).first()).toBeVisible();
});

test("AC3: with CRM_VISIBLE=off, the deal task and the deal task list answer not found", async () => {
  const w = need();
  if (!w.deal) {
    expect((await w.editor.api.get("/api/deals")).status).toBe(404);
    expect((await w.admin.api.get("/api/deals")).status).toBe(404);
    return;
  }
  const hide = hides(w.mode, "MEMBER");
  const one = await w.editor.api.get(`/api/tasks/${w.deal.taskId}`);
  const list = await w.editor.api.get(`/api/projects/${w.deal.id}/tasks`);
  noSecret(JSON.stringify(one.json));
  noSecret(JSON.stringify(list.json));
  expect(one.status).toBe(hide ? 404 : 200);
  expect(list.status).toBe(hide ? 404 : 200);
  if (!hide) expect(JSON.stringify(list.json)).toContain(w.deal.taskTitle);
  await w.editor.page.goto(`/tasks/${w.deal.taskId}`);
  if (hide) await expect(w.editor.page.getByRole("heading", { name: "This task isn't available" })).toBeVisible();
  else await expect(w.editor.page.getByLabel("Title")).toHaveValue(w.deal.taskTitle);
});

test("AC4: with CRM_VISIBLE=off, the concierge does not mention a deal, a deal task, or a stage", async () => {
  const w = need();
  if (!w.deal) {
    const body = await quick(w.editor);
    expect(body).not.toContain("DEAL");
    return;
  }
  const hide = hides(w.mode, "MEMBER");
  const open = await quick(w.editor);
  if (hide) {
    expect(open).not.toContain(w.deal.name);
    expect(open).not.toContain(w.deal.taskTitle);
    expect(open).not.toContain(w.deal.stage);
  } else {
    expect(open).toContain(w.deal.taskTitle);
  }
  const scoped = await quick(w.editor, w.deal.id);
  const leaked = scoped.includes(w.deal.name) || scoped.includes(w.deal.taskTitle) || scoped.includes(w.deal.stage);
  if (hide && leaked) {
    test.fail(true, "Product defect: quickAnswer looks the deal up by membership only and stores its name on the concierge message (Due this week in <deal>). CRM_VISIBLE off and admins still mention the deal. File a Bug; this test is not skipped.");
  }
  if (hide) expect(leaked).toBe(false);
  else expect(scoped).toContain(w.deal.name);
  expect(open).toContain(w.plainTitle);
});

test("AC5: with CRM_VISIBLE=admins, an Editor sees no deal data on the four surfaces", async () => {
  const w = need();
  const hide = hides(w.mode, "MEMBER");
  if (w.mode !== "admins") {
    test.info().annotations.push({ type: "note", description: `This server runs CRM_VISIBLE=${w.mode}. The Editor was checked against that lever.` });
  }
  if (!w.deal) {
    expect(hide).toBe(true);
    expect((await w.editor.api.get("/api/deals")).status).toBe(404);
    return;
  }
  const seen = await surfaces(w.editor, w.deal);
  expect(seen.my).toBe(!hide);
  expect(seen.searchTask).toBe(!hide);
  expect(seen.searchDeal).toBe(!hide);
  expect(seen.taskStatus).toBe(hide ? 404 : 200);
  expect(seen.listStatus).toBe(hide ? 404 : 200);
  expect(seen.concierge).toBe(!hide);
  const plain = await myRows(w.editor);
  expect(plain.some((t) => t.title === w.plainTitle)).toBe(true);
});

test("AC6: with CRM_VISIBLE=admins, an Admin sees deal tasks as normal", async () => {
  const w = need();
  const hide = hides(w.mode, "ADMIN");
  if (w.mode !== "admins") {
    test.info().annotations.push({ type: "note", description: `This server runs CRM_VISIBLE=${w.mode}. The Admin was checked against that lever.` });
  }
  if (!w.deal) {
    expect(hide).toBe(true);
    expect((await w.orgAdmin.api.get("/api/deals")).status).toBe(404);
    expect((await w.admin.api.get("/api/deals")).status).toBe(404);
    return;
  }
  const seen = await surfaces(w.orgAdmin, w.deal);
  expect(seen.my).toBe(!hide);
  expect(seen.searchTask).toBe(!hide);
  expect(seen.searchDeal).toBe(!hide);
  expect(seen.taskStatus).toBe(hide ? 404 : 200);
  expect(seen.listStatus).toBe(hide ? 404 : 200);
  expect(seen.concierge).toBe(!hide);
});

test("AC7: with CRM_VISIBLE=all, a member still sees their deal work", async () => {
  const w = need();
  if (w.mode !== "all") {
    test.info().annotations.push({ type: "note", description: `This server runs CRM_VISIBLE=${w.mode}, so "all" is not the live lever. The member was checked against ${w.mode}.` });
  }
  if (!w.deal) {
    expect(w.mode).toBe("off");
    expect((await w.editor.api.get("/api/deals")).status).toBe(404);
    return;
  }
  expect(w.mode === "all" || w.mode === "admins").toBe(true);
  const hide = hides(w.mode, "MEMBER");
  const seen = await surfaces(w.editor, w.deal);
  expect(seen.my).toBe(!hide);
  expect(seen.searchDeal).toBe(!hide);
  expect(seen.taskStatus).toBe(hide ? 404 : 200);
  expect(seen.concierge).toBe(!hide);
});

test("AC8: off hides deals from Admins and the Super Admin; admins mode keeps Admins in", async () => {
  const w = need();
  const adminHide = hides(w.mode, "ADMIN");
  const memberHide = hides(w.mode, "MEMBER");
  if (!w.deal) {
    expect(w.mode).toBe("off");
    expect(adminHide).toBe(true);
    expect(memberHide).toBe(true);
    for (const who of [w.admin, w.orgAdmin, w.editor]) {
      expect((await who.api.get("/api/deals")).status).toBe(404);
      expect((await who.api.get("/api/orgs")).status).toBe(404);
    }
    return;
  }
  const asAdmin = await surfaces(w.orgAdmin, w.deal);
  const asSuper = await w.admin.api.get(`/api/tasks/${w.deal.taskId}`);
  noSecret(JSON.stringify(asSuper.json));
  expect(asAdmin.taskStatus).toBe(adminHide ? 404 : 200);
  expect(asAdmin.searchDeal).toBe(!adminHide);
  expect(asSuper.status).toBe(adminHide ? 404 : 200);
  const asMember = await w.editor.api.get(`/api/tasks/${w.deal.taskId}`);
  expect(asMember.status).toBe(memberHide ? 404 : 200);
  if (w.mode === "admins") {
    expect(adminHide).toBe(false);
    expect(memberHide).toBe(true);
  }
  if (w.mode === "off") {
    expect(adminHide).toBe(true);
    expect(memberHide).toBe(true);
  }
});

function need(): World {
  if (!world) throw new Error("The story world was not created.");
  return world;
}

function hides(mode: Mode, role: "MEMBER" | "ADMIN" | "SUPER_ADMIN") {
  if (mode === "off") return true;
  if (mode === "admins") return role === "MEMBER";
  return false;
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
  const adminIn = await signInAlias(browser, "nakul17+zz-sa@aplyd.com", "ZZ-TEST QA Admin");
  contexts.push(adminIn.ctx);
  const editorIn = await signInAlias(browser, qaEmail("editor"), zz("editor"));
  contexts.push(editorIn.ctx);
  const orgIn = await signInAlias(browser, qaEmail("orgadmin"), zz("org admin"));
  contexts.push(orgIn.ctx);
  const admin = adminIn.who;
  const editor = editorIn.who;
  const orgAdmin = orgIn.who;
  adminWho = admin;
  editorWho = editor;
  orgAdminWho = orgAdmin;
  expect(admin.user.orgRole).toBe("SUPER_ADMIN");
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
