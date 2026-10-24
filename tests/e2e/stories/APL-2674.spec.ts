// APL-2674 story spec. One case per acceptance criterion except AC6. Playwright (playwright.config.ts, workers=1);
// npm test skips it (vitest.config.mts). It lives in tests/e2e/stories/ so staging-e2e.yml collects it (Dwight's ruling).
// Skipped unless SHO_QA_PASS is set. Production hosts and the production IP are refused (Pam D7).
// No direct database writes: AC6 is not here, because there is no API to age an action row; AC6 is covered by
// d3c54eaf@v3, 6b35ff98@v3 and 8633ebdd@v1 in tests/activity-delete-undo.test.ts.
// People: the Super Admin is SHO_ADMIN_EMAIL / SHO_ADMIN_PASS. Everyone else is a thrown-away nakul17+…@aplyd.com alias
// (self-signup only accepts @aplyd.com) signed up through the API with SHO_QA_PASS as the password and verified from the
// local mail outbox (EMAIL_OUTBOX_DIR), so this spec needs a local app. Names and projects are ZZ-TEST.
// afterAll hands each project to the Super Admin, archives it, and deactivates the people this file created, through the API.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test, expect, request as pwRequest, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";

const PRODUCTION = new Set(["sheethappensofficer.com", "www.sheethappensofficer.com", "app.sheethappensofficer.com", "sheethappensofficer.aplyd.org", "168.144.144.69"]);
const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}`;
let seq = 0;

/** Same default as playwright.config.ts. */
const BASE = (process.env.BASE_URL || process.env.TASKBOARD_URL || "http://localhost:3100").replace(/\/+$/, "");
const OUTBOX = process.env.EMAIL_OUTBOX_DIR ?? "";
const QA_PASS = process.env.SHO_QA_PASS ?? "";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Account = { req: APIRequestContext; id: string; name: string; email: string; password: string };

const people: Account[] = [];
const projectIds: string[] = [];
let root: Account;

for (const raw of [process.env.TASKBOARD_URL, process.env.BASE_URL, process.env.STAGING_URL]) {
  if (!raw) continue;
  let host = "";
  try { host = new URL(raw).hostname.toLowerCase().replace(/\.$/, ""); } catch { host = raw; }
  if (PRODUCTION.has(host)) throw new Error(`Refusing to run story tests against production (${host}).`);
}

async function call(req: APIRequestContext, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, data?: unknown) {
  const res = await req.fetch(url, { method, data: data === undefined ? undefined : data });
  const text = await res.text();
  let json: Json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
  return { status: res.status(), json };
}

async function signInAs(email: string, password: string): Promise<Account> {
  const req = await pwRequest.newContext({ baseURL: BASE });
  const s = await call(req, "POST", "/api/auth/signin", { email, password });
  expect(s.status, `sign in ${email}: ${JSON.stringify(s.json)}`).toBe(200);
  return { req, id: s.json.user.id, name: s.json.user.name, email, password };
}

function verifyToken(email: string) {
  const files = readdirSync(OUTBOX).sort();
  const mails = files.map((f) => JSON.parse(readFileSync(path.join(OUTBOX, f), "utf8"))).filter((m) => m.to === email && /Verify/.test(m.subject));
  return (mails.at(-1)?.text.match(/token=([\w-]+)/)?.[1] ?? null) as string | null;
}

/** A thrown-away ZZ-TEST person on a nakul17+ alias, signed up and verified through the API. */
async function zzAccount(role: string): Promise<Account> {
  const n = seq++;
  const slug = role.toLowerCase().replace(/[^a-z0-9]+/g, "") || "user";
  const email = `nakul17+zz-2674-${RUN}-${slug}-${n}@aplyd.com`;
  const name = `ZZ-TEST ${role} ${RUN}-${n}`;
  const anon = await pwRequest.newContext({ baseURL: BASE });
  try {
    const up = await call(anon, "POST", "/api/auth/signup", { name, email, password: QA_PASS });
    expect(up.status, `sign up ${email}: ${JSON.stringify(up.json)}`).toBe(201);
    const token = verifyToken(email);
    expect(token, `verify mail for ${email} in EMAIL_OUTBOX_DIR`).toBeTruthy();
    expect((await call(anon, "POST", "/api/auth/verify", { token })).status).toBe(200);
  } finally {
    await anon.dispose();
  }
  const who = await signInAs(email, QA_PASS);
  people.push(who);
  return who;
}

async function zzProject(leader: Account, members: { who: Account; role?: "EDITOR" | "VIEWER" }[] = []) {
  const r = await call(leader.req, "POST", "/api/projects", { name: `ZZ-TEST ${RUN}-${seq++}`, leaderId: leader.id });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = r.json.project.id as string;
  projectIds.push(id);
  for (const m of members) {
    expect((await call(leader.req, "POST", `/api/projects/${id}/members`, { userId: m.who.id, role: m.role ?? "EDITOR" })).status).toBe(201);
  }
  return id;
}

const zzTitle = (label: string) => `ZZ-TEST ${label} ${RUN}-${seq++}`;

async function zzTask(who: Account, projectId: string, label: string, body: Json = {}) {
  const title = zzTitle(label);
  const r = await call(who.req, "POST", `/api/projects/${projectId}/tasks`, { ...body, title });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return { id: r.json.task.id as string, title };
}

/** PATCH a task on the version it is at right now (the server refuses an edit without one). */
async function patchTask(who: Account, id: string, body: Json) {
  const seen = (await call(who.req, "GET", `/api/tasks/${id}`)).json?.task?.updatedAt ?? new Date(0).toISOString();
  return call(who.req, "PATCH", `/api/tasks/${id}`, { ...body, expectedUpdatedAt: seen });
}

async function signedIn(browser: Browser, who: Account) {
  const ctx = await browser.newContext({ baseURL: BASE });
  const sign = await ctx.request.post("/api/auth/signin", { data: { email: who.email, password: who.password } });
  expect(sign.ok(), await sign.text()).toBe(true);
  return ctx;
}

async function openActivity(ctx: BrowserContext, projectId: string) {
  const page = await ctx.newPage();
  const roleReady = page.waitForResponse(
    (res) => res.url().includes(`/api/projects/${projectId}`) && !res.url().includes("/activity") && res.ok(),
    { timeout: 45_000 },
  );
  await page.goto(`/projects/${projectId}/activity`, { waitUntil: "load", timeout: 45_000 });
  await roleReady;
  return page;
}

function actRow(page: Page, who: string, what: string) {
  return page.getByRole("list", { name: "Activity" }).getByRole("listitem")
    .filter({ hasText: what })
    .filter({ has: page.getByText(who, { exact: true }) });
}

test.describe("APL-2674 activity delete undo", { tag: "@local-only" }, () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    test.skip(!QA_PASS, "APL-2674: Set SHO_QA_PASS (the shared password for the nakul17+ accounts).");
    if (!OUTBOX) throw new Error("APL-2674: set EMAIL_OUTBOX_DIR. This spec signs up nakul17+ aliases and verifies them from the local mail outbox.");
    const email = process.env.SHO_ADMIN_EMAIL ?? "";
    const password = process.env.SHO_ADMIN_PASS ?? "";
    if (!email || !password) throw new Error("APL-2674: set SHO_ADMIN_EMAIL and SHO_ADMIN_PASS (the Super Admin).");
    root = await signInAs(email, password);
  });

  test.afterAll(async () => {
    if (!root) return;
    const problems: string[] = [];
    try {
      for (const id of projectIds) {
        const added = await call(root.req, "POST", `/api/projects/${id}/members`, { userId: root.id, role: "EDITOR" });
        if (added.status !== 201 && !(added.status === 409 && /already a member/.test(added.json?.error ?? ""))) {
          problems.push(`add member ${id}: ${added.status} ${JSON.stringify(added.json)}`);
        }
        const led = await call(root.req, "POST", `/api/projects/${id}/leader`, { newLeaderId: root.id, previousRole: "EDITOR" });
        if (led.status !== 200 && !(led.status === 400 && /already the Leader/.test(led.json?.error ?? ""))) {
          problems.push(`change leader ${id}: ${led.status} ${JSON.stringify(led.json)}`);
        }
        const archived = await call(root.req, "POST", `/api/projects/${id}/archive`);
        if (archived.status !== 200) problems.push(`archive ${id}: ${archived.status} ${JSON.stringify(archived.json)}`);
      }
      for (const who of people) {
        const off = await call(root.req, "POST", `/api/team/${who.id}/deactivate`, { reassign: "leaders" });
        if (off.status !== 200 && !(off.status === 409 && /already deactivated/.test(off.json?.error ?? ""))) {
          problems.push(`deactivate ${who.email}: ${off.status} ${JSON.stringify(off.json)}`);
        }
      }
    } finally {
      for (const who of [...people, root]) await who.req.dispose();
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  test("qa:TC-APL2674-4c99513c@v1 qa:TC-APL2674-c7c6fa04@v1 AC1 Undo on a task.deleted row follows the Trash restore rule: no Undo for the Editor, Undo for the Leader and a Super Admin on their own deletes", async ({ browser }) => {
    test.setTimeout(180_000);
    const leader = await zzAccount("leader");
    const editor = await zzAccount("editor");
    const projectId = await zzProject(leader, [{ who: editor }]);

    const editorTask = await zzTask(editor, projectId, "Editor delete");
    expect((await call(editor.req, "DELETE", `/api/tasks/${editorTask.id}`)).status).toBe(204);
    const editorCtx = await signedIn(browser, editor);
    try {
      const page = await openActivity(editorCtx, projectId);
      const row = actRow(page, editor.name, `moved "${editorTask.title}" to Trash`);
      await expect(row).toBeVisible({ timeout: 30_000 });
      await expect(row.getByRole("button", { name: "Undo" })).toHaveCount(0);
    } finally {
      await editorCtx.close();
    }

    const leaderTask = await zzTask(leader, projectId, "Leader delete");
    expect((await call(leader.req, "DELETE", `/api/tasks/${leaderTask.id}`)).status).toBe(204);
    const leaderCtx = await signedIn(browser, leader);
    try {
      const page = await openActivity(leaderCtx, projectId);
      await expect(actRow(page, leader.name, `moved "${leaderTask.title}" to Trash`).getByRole("button", { name: "Undo" })).toBeVisible({ timeout: 30_000 });
    } finally {
      await leaderCtx.close();
    }

    const rootTask = await zzTask(root, projectId, "Super admin delete");
    expect((await call(root.req, "DELETE", `/api/tasks/${rootTask.id}`)).status).toBe(204);
    const rootCtx = await signedIn(browser, root);
    try {
      const page = await openActivity(rootCtx, projectId);
      await expect(actRow(page, root.name, `moved "${rootTask.title}" to Trash`).getByRole("button", { name: "Undo" })).toBeVisible({ timeout: 30_000 });
    } finally {
      await rootCtx.close();
    }
  });

  test("qa:TC-APL2674-5a651835@v1 AC2 Other Undo rows are unchanged: the Editor's own edit shows Undo and restores the title", async ({ browser }) => {
    test.setTimeout(90_000);
    const leader = await zzAccount("leader");
    const editor = await zzAccount("editor");
    const projectId = await zzProject(leader, [{ who: editor }]);
    const created = await zzTask(editor, projectId, "Edit me");
    const renamed = zzTitle("Edited");
    expect((await patchTask(editor, created.id, { title: renamed })).status).toBe(200);

    const ctx = await signedIn(browser, editor);
    try {
      const page = await openActivity(ctx, projectId);
      const undo = actRow(page, editor.name, `renamed "${created.title}" to "${renamed}"`).getByRole("button", { name: "Undo" });
      await expect(undo).toBeVisible({ timeout: 30_000 });
      await undo.click();
      await expect.poll(async () => (await call(editor.req, "GET", `/api/tasks/${created.id}`)).json?.task?.title, { timeout: 20_000 }).toBe(created.title);
    } finally {
      await ctx.close();
    }
  });

  test("qa:TC-APL2674-cbcdf3cc@v1 AC3 The server stays the source of truth: a direct undo of the Editor's own delete is 403 and nothing is restored", async ({ browser }) => {
    test.setTimeout(90_000);
    const leader = await zzAccount("leader");
    const editor = await zzAccount("editor");
    const projectId = await zzProject(leader, [{ who: editor }]);
    const created = await zzTask(editor, projectId, "Still deleted");
    expect((await call(editor.req, "DELETE", `/api/tasks/${created.id}`)).status).toBe(204);
    const items = (await call(editor.req, "GET", `/api/projects/${projectId}/activity`)).json.items as { id: string; what: string; kind: string }[];
    // SHO-2701: the delete row is found by its kind; the sentence it reads as is asserted beside it.
    const del = items.find((item) => item.kind === "task.deleted");
    expect(del?.what, "the delete still reads as a move to Trash").toBe(`moved "${created.title}" to Trash`);
    const actionId = del?.id;
    expect(actionId).toBeTruthy();

    const ctx = await signedIn(browser, editor);
    try {
      const undo = await ctx.request.post(`/api/actions/${actionId}/undo`, { data: {} });
      expect(undo.status()).toBe(403);
      expect((await undo.json()).error).toBe("Only the project Leader or an Admin can do this.");
    } finally {
      await ctx.close();
    }
    expect((await call(editor.req, "GET", `/api/tasks/${created.id}`)).status).toBe(404);
    const trash = await call(leader.req, "GET", `/api/projects/${projectId}/trash`);
    expect((trash.json.items as { id: string }[]).some((item) => item.id === created.id)).toBe(true);
  });

  test("qa:TC-APL2674-d0b5b573@v2 qa:TC-APL2674-db4b7af8@v3 AC4 Leader and Admin see Undo on someone else's delete and it restores; another Editor, an uninvolved Editor and a Viewer do not", async ({ browser }) => {
    test.setTimeout(180_000);
    const leader = await zzAccount("leader");
    const erin = await zzAccount("erin");
    const other = await zzAccount("other");
    const uninvolved = await zzAccount("uninvolved");
    const viewer = await zzAccount("viewer");
    const projectId = await zzProject(leader, [
      { who: erin }, { who: other }, { who: uninvolved }, { who: viewer, role: "VIEWER" },
    ]);
    const created = await zzTask(leader, projectId, "Erin delete", { assigneeId: other.id });
    expect((await call(erin.req, "DELETE", `/api/tasks/${created.id}`)).status).toBe(204);
    const what = `moved "${created.title}" to Trash`;

    const otherCtx = await signedIn(browser, other);
    try {
      const page = await openActivity(otherCtx, projectId);
      const row = actRow(page, erin.name, what);
      await expect(row).toBeVisible({ timeout: 30_000 });
      await expect(row.getByRole("button", { name: "Undo" })).toHaveCount(0);
      await expect(row).not.toContainText("Too old to undo");
    } finally {
      await otherCtx.close();
    }

    const plainCtx = await signedIn(browser, uninvolved);
    try {
      const page = await openActivity(plainCtx, projectId);
      // The feed does not list Erin's delete to an editor who is not involved in the task: the row is absent.
      const feed = (await call(uninvolved.req, "GET", `/api/projects/${projectId}/activity`)).json.items as { what: string; kind: string }[];
      expect(feed.some((item) => item.kind === "task.deleted"), "no delete row at all for this editor").toBe(false);
      // The feed has rendered: either the Activity list or its empty message (only one of them is ever on the page).
      await expect(page.getByRole("list", { name: "Activity" }).or(page.getByText("Nothing has happened yet."))).toBeVisible({ timeout: 30_000 });
      await expect(actRow(page, erin.name, what)).toHaveCount(0);
      await expect(page.getByText("Too old to undo")).toHaveCount(0);
    } finally {
      await plainCtx.close();
    }

    const viewerCtx = await signedIn(browser, viewer);
    try {
      const page = await openActivity(viewerCtx, projectId);
      await expect(page.getByText("Only people who work on this project can see Activity.")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole("button", { name: "Undo" })).toHaveCount(0);
    } finally {
      await viewerCtx.close();
    }

    const rootCtx = await signedIn(browser, root);
    try {
      const page = await openActivity(rootCtx, projectId);
      await expect(actRow(page, erin.name, what).getByRole("button", { name: "Undo" })).toBeVisible({ timeout: 30_000 });
    } finally {
      await rootCtx.close();
    }

    const leaderCtx = await signedIn(browser, leader);
    try {
      const page = await openActivity(leaderCtx, projectId);
      const button = actRow(page, erin.name, what).getByRole("button", { name: "Undo" });
      await expect(button).toBeVisible({ timeout: 30_000 });
      await button.click();
      await expect.poll(async () => (await call(leader.req, "GET", `/api/tasks/${created.id}`)).status, { timeout: 20_000 }).toBe(200);
    } finally {
      await leaderCtx.close();
    }
    const trash = await call(leader.req, "GET", `/api/projects/${projectId}/trash`);
    expect((trash.json.items as { id: string }[]).some((item) => item.id === created.id)).toBe(false);
  });

  test("qa:TC-APL2674-a4fde780@v2 AC5 Undo from the Activity row sends one POST /api/actions/{actionId}/undo with {\"anyway\":false}", async ({ browser }) => {
    test.setTimeout(90_000);
    const leader = await zzAccount("leader");
    const editor = await zzAccount("editor");
    const projectId = await zzProject(leader, [{ who: editor }]);
    const created = await zzTask(editor, projectId, "Undo target");
    expect((await call(editor.req, "DELETE", `/api/tasks/${created.id}`)).status).toBe(204);
    const items = (await call(leader.req, "GET", `/api/projects/${projectId}/activity`)).json.items as { id: string; what: string; kind: string }[];
    // SHO-2701: the kind picks the row; the sentence is asserted beside it.
    const del = items.find((item) => item.kind === "task.deleted");
    expect(del?.what, "the delete still reads as a move to Trash").toBe(`moved "${created.title}" to Trash`);
    const actionId = del?.id;
    expect(actionId).toBeTruthy();

    const ctx = await signedIn(browser, leader);
    const posts: { path: string; body: string | null }[] = [];
    try {
      const page = await openActivity(ctx, projectId);
      page.on("request", (req) => {
        if (req.method() !== "POST") return;
        const p = new URL(req.url()).pathname;
        if (p.endsWith("/undo")) posts.push({ path: p, body: req.postData() });
      });
      const button = actRow(page, editor.name, `moved "${created.title}" to Trash`).getByRole("button", { name: "Undo" });
      await expect(button).toBeVisible({ timeout: 30_000 });
      await button.click();
      await expect.poll(async () => (await call(leader.req, "GET", `/api/tasks/${created.id}`)).status, { timeout: 20_000 }).toBe(200);
    } finally {
      await ctx.close();
    }
    expect(posts).toEqual([{ path: `/api/actions/${actionId}/undo`, body: '{"anyway":false}' }]);
  });

  test("qa:TC-APL2674-070b48b9@v4 AC7 Trash and restore half: a deleted task shows 30 days in Trash, and the Leader restores it from Trash and from the Activity row", async ({ browser }) => {
    test.setTimeout(120_000);
    const leader = await zzAccount("leader");
    const projectId = await zzProject(leader);
    const first = await zzTask(leader, projectId, "Trash me");
    expect((await call(leader.req, "DELETE", `/api/tasks/${first.id}`)).status).toBe(204);
    const listed = await call(leader.req, "GET", `/api/projects/${projectId}/trash`);
    const item = (listed.json.items as { id: string; daysLeft: number }[]).find((row) => row.id === first.id);
    expect(item?.daysLeft).toBe(30);

    const ctx = await signedIn(browser, leader);
    try {
      const page = await ctx.newPage();
      await page.goto(`/projects/${projectId}/trash`, { waitUntil: "load", timeout: 45_000 });
      const row = page.getByRole("row").filter({ hasText: first.title });
      await expect(row).toBeVisible({ timeout: 30_000 });
      await expect(row).toContainText("30 days");
      await row.getByRole("button", { name: "Restore" }).click();
      await expect.poll(async () => (await call(leader.req, "GET", `/api/tasks/${first.id}`)).status, { timeout: 20_000 }).toBe(200);

      const again = await zzTask(leader, projectId, "Undo me");
      expect((await call(leader.req, "DELETE", `/api/tasks/${again.id}`)).status).toBe(204);
      const activity = await openActivity(ctx, projectId);
      const button = actRow(activity, leader.name, `moved "${again.title}" to Trash`).getByRole("button", { name: "Undo" });
      await expect(button).toBeVisible({ timeout: 30_000 });
      await button.click();
      await expect.poll(async () => (await call(leader.req, "GET", `/api/tasks/${again.id}`)).status, { timeout: 20_000 }).toBe(200);
    } finally {
      await ctx.close();
    }
  });
});
