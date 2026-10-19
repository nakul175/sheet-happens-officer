// APL-2674 story spec. One case per acceptance criterion. workers=1: this file runs its cases in order.
// It lives in tests/e2e/stories/ so staging-e2e.yml collects it (Dwight's ruling on Pam's D2, 19 Oct 2026).
// Skipped unless SHO_QA_PASS is set: beforeAll launches nothing without it, and beforeEach skips every case.
// Production hosts are refused. AC6 backdates one action row through Prisma (there is no API for that), so the
// suite also refuses any DATABASE_URL that is not on this machine.
// Thrown-away people and projects use ZZ-TEST names and nakul17+ aliases. afterAll archives only
// the projects this file created and deactivates only the people this file created, through the API.
// Self-signup only accepts @aplyd.com, so the alias is nakul17+…@aplyd.com.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { PrismaClient } from "../../../src/generated/prisma/client";
import { account, BASE, patchTask, PW, superAdmin, task, type Account } from "../../helpers";

const PRODUCTION = new Set(["sheethappensofficer.com", "www.sheethappensofficer.com", "app.sheethappensofficer.com"]);
for (const raw of [process.env.TASKBOARD_URL, process.env.BASE_URL, process.env.STAGING_URL]) {
  if (!raw) continue;
  let host = "";
  try { host = new URL(raw).hostname.toLowerCase().replace(/\.$/, ""); } catch { host = raw; }
  if (PRODUCTION.has(host)) throw new Error(`Refusing to run story tests against production (${host}).`);
}

const QA_PASS = Boolean(process.env.SHO_QA_PASS);
const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}`;
let seq = 0;
const people: Account[] = [];
const projectIds: string[] = [];
let browser: Browser;
let db: PrismaClient;

async function zzAccount(role: string) {
  const n = seq++;
  const slug = role.toLowerCase().replace(/[^a-z0-9]+/g, "") || "user";
  const email = `nakul17+zz-2674-${RUN}-${slug}-${n}@aplyd.com`;
  const who = await account(`ZZ-TEST ${role} ${RUN}-${n}`, email);
  people.push(who);
  return who;
}

async function zzProject(leader: Account, members: { who: Account; role?: "EDITOR" | "VIEWER" }[] = []) {
  const name = `ZZ-TEST ${RUN}-${seq++}`;
  const r = await leader.c.post("/api/projects", { name, leaderId: leader.id });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = r.json.project.id as string;
  projectIds.push(id);
  for (const m of members) {
    expect((await leader.c.post(`/api/projects/${id}/members`, { userId: m.who.id, role: m.role ?? "EDITOR" })).status).toBe(201);
  }
  return id;
}

function zzTitle(label: string) {
  return `ZZ-TEST ${label} ${RUN}-${seq++}`;
}

async function zzTask(who: Account, projectId: string, title: string, body: Record<string, unknown> = {}) {
  const named = title.startsWith("ZZ-TEST") ? title : zzTitle(title);
  const id = await task(who, projectId, { ...body, title: named });
  return { id, title: named };
}

async function displayName(who: Account) {
  const me = await who.c.get("/api/auth/me");
  expect(me.status).toBe(200);
  return me.json.user.name as string;
}

async function signedIn(email: string) {
  const ctx = await browser.newContext({ baseURL: BASE });
  const sign = await ctx.request.post("/api/auth/signin", { data: { email, password: PW } });
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

describe("qa:TC missing APL-2674 activity delete undo", () => {
  beforeAll(async () => {
    if (!QA_PASS) return;
    let dbHost = "";
    try { dbHost = new URL(process.env.DATABASE_URL ?? "").hostname; } catch { dbHost = ""; }
    if (!/^(localhost|127\.0\.0\.1)$/.test(dbHost)) throw new Error("Refusing the APL-2674 story spec: DATABASE_URL must be a database on this machine.");
    browser = await chromium.launch({
      executablePath: process.env.PW_CHROMIUM || "/usr/bin/google-chrome",
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    db = new PrismaClient();
  }, 60_000);

  beforeEach(({ skip }) => {
    if (!QA_PASS) skip("Set SHO_QA_PASS to run the APL-2674 story spec.");
  });

  afterAll(async () => {
    if (!QA_PASS) return;
    const problems: string[] = [];
    try {
      const sa = await superAdmin();
      for (const id of projectIds) {
        const added = await sa.c.post(`/api/projects/${id}/members`, { userId: sa.id, role: "EDITOR" });
        if (added.status !== 201 && !(added.status === 409 && /already a member/.test(added.json?.error ?? ""))) {
          problems.push(`add member ${id}: ${added.status} ${JSON.stringify(added.json)}`);
        }
        const led = await sa.c.post(`/api/projects/${id}/leader`, { newLeaderId: sa.id, previousRole: "EDITOR" });
        if (led.status !== 200 && !(led.status === 400 && /already the Leader/.test(led.json?.error ?? ""))) {
          problems.push(`change leader ${id}: ${led.status} ${JSON.stringify(led.json)}`);
        }
        const archived = await sa.c.post(`/api/projects/${id}/archive`);
        if (archived.status !== 200) problems.push(`archive ${id}: ${archived.status} ${JSON.stringify(archived.json)}`);
      }
      for (const who of people) {
        if (who.id === sa.id) continue;
        const off = await sa.c.post(`/api/team/${who.id}/deactivate`, { reassign: "leaders" });
        if (off.status !== 200 && !(off.status === 409 && /already deactivated/.test(off.json?.error ?? ""))) {
          problems.push(`deactivate ${who.email}: ${off.status} ${JSON.stringify(off.json)}`);
        }
      }
    } finally {
      await browser?.close();
      await db?.$disconnect();
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("qa:TC missing AC1 Undo on a task.deleted row follows the Trash restore rule: no Undo for the Editor, Undo for the Leader and a Super Admin on their own deletes", async () => {
    const leader = await zzAccount("leader");
    const editor = await zzAccount("editor");
    const root = await superAdmin();
    const projectId = await zzProject(leader, [{ who: editor }]);
    const [editorName, leaderName, rootName] = await Promise.all([displayName(editor), displayName(leader), displayName(root)]);

    const editorTask = await zzTask(editor, projectId, "Editor delete");
    expect((await editor.c.del(`/api/tasks/${editorTask.id}`)).status).toBe(204);
    const editorCtx = await signedIn(editor.email);
    try {
      const page = await openActivity(editorCtx, projectId);
      const row = actRow(page, editorName, `moved "${editorTask.title}" to Trash`);
      await row.waitFor({ state: "visible", timeout: 30_000 });
      expect(await row.getByRole("button", { name: "Undo" }).count()).toBe(0);
    } finally {
      await editorCtx.close();
    }

    const leaderTask = await zzTask(leader, projectId, "Leader delete");
    expect((await leader.c.del(`/api/tasks/${leaderTask.id}`)).status).toBe(204);
    const leaderCtx = await signedIn(leader.email);
    try {
      const page = await openActivity(leaderCtx, projectId);
      await actRow(page, leaderName, `moved "${leaderTask.title}" to Trash`).getByRole("button", { name: "Undo" }).waitFor({ state: "visible", timeout: 30_000 });
    } finally {
      await leaderCtx.close();
    }

    const rootTask = await zzTask(root, projectId, "Super admin delete");
    expect((await root.c.del(`/api/tasks/${rootTask.id}`)).status).toBe(204);
    const rootCtx = await signedIn(root.email);
    try {
      const page = await openActivity(rootCtx, projectId);
      await actRow(page, rootName, `moved "${rootTask.title}" to Trash`).getByRole("button", { name: "Undo" }).waitFor({ state: "visible", timeout: 30_000 });
    } finally {
      await rootCtx.close();
    }
  }, 180_000);

  it("qa:TC missing AC2 Other Undo rows are unchanged: the Editor's own edit shows Undo and restores the title", async () => {
    const leader = await zzAccount("leader");
    const editor = await zzAccount("editor");
    const projectId = await zzProject(leader, [{ who: editor }]);
    const created = await zzTask(editor, projectId, "Edit me");
    const renamed = zzTitle("Edited");
    expect((await patchTask(editor, created.id, { title: renamed })).status).toBe(200);
    const name = await displayName(editor);

    const ctx = await signedIn(editor.email);
    try {
      const page = await openActivity(ctx, projectId);
      const row = actRow(page, name, `renamed "${created.title}" to "${renamed}"`);
      const undo = row.getByRole("button", { name: "Undo" });
      await undo.waitFor({ state: "visible", timeout: 30_000 });
      await undo.click();
      await expect.poll(async () => (await editor.c.get(`/api/tasks/${created.id}`)).json?.task?.title, { timeout: 20_000 }).toBe(created.title);
    } finally {
      await ctx.close();
    }
  }, 90_000);

  it("qa:TC missing AC3 The server stays the source of truth: a direct undo of the Editor's own delete is 403 and nothing is restored", async () => {
    const leader = await zzAccount("leader");
    const editor = await zzAccount("editor");
    const projectId = await zzProject(leader, [{ who: editor }]);
    const created = await zzTask(editor, projectId, "Still deleted");
    expect((await editor.c.del(`/api/tasks/${created.id}`)).status).toBe(204);
    const items = (await editor.c.get(`/api/projects/${projectId}/activity`)).json.items as { id: string; what: string }[];
    const actionId = items.find((item) => item.what === `moved "${created.title}" to Trash`)?.id;
    expect(actionId).toBeTruthy();

    const ctx = await signedIn(editor.email);
    try {
      const undo = await ctx.request.post(`/api/actions/${actionId}/undo`, { data: {} });
      expect(undo.status()).toBe(403);
      expect((await undo.json()).error).toBe("Only the project Leader or an Admin can do this.");
    } finally {
      await ctx.close();
    }
    expect((await editor.c.get(`/api/tasks/${created.id}`)).status).toBe(404);
    const trash = await leader.c.get(`/api/projects/${projectId}/trash`);
    expect((trash.json.items as { id: string }[]).some((item) => item.id === created.id)).toBe(true);
  }, 90_000);

  it("qa:TC missing AC4 Leader and Admin see Undo on someone else's delete and it restores; another Editor, an uninvolved Editor and a Viewer do not", async () => {
    const leader = await zzAccount("leader");
    const erin = await zzAccount("erin");
    const other = await zzAccount("other");
    const uninvolved = await zzAccount("uninvolved");
    const viewer = await zzAccount("viewer");
    const root = await superAdmin();
    const projectId = await zzProject(leader, [
      { who: erin }, { who: other }, { who: uninvolved }, { who: viewer, role: "VIEWER" },
    ]);
    const created = await zzTask(leader, projectId, "Erin delete", { assigneeId: other.id });
    expect((await erin.c.del(`/api/tasks/${created.id}`)).status).toBe(204);
    const erinName = await displayName(erin);
    const what = `moved "${created.title}" to Trash`;

    const otherCtx = await signedIn(other.email);
    try {
      const page = await openActivity(otherCtx, projectId);
      const row = actRow(page, erinName, what);
      await row.waitFor({ state: "visible", timeout: 30_000 });
      expect(await row.getByRole("button", { name: "Undo" }).count()).toBe(0);
      expect(await row.innerText()).not.toContain("Too old to undo");
    } finally {
      await otherCtx.close();
    }

    const plainCtx = await signedIn(uninvolved.email);
    try {
      const page = await openActivity(plainCtx, projectId);
      // The feed does not list Erin's delete to an editor who is not involved in the task: the row is absent.
      const feed = (await uninvolved.c.get(`/api/projects/${projectId}/activity`)).json.items as { what: string }[];
      expect(feed.some((item) => item.what === what)).toBe(false);
      // The feed has rendered: either the Activity list or its empty message (only one of them is ever on the page).
      await page.getByRole("list", { name: "Activity" }).or(page.getByText("Nothing has happened yet.")).waitFor({ state: "visible", timeout: 30_000 });
      expect(await actRow(page, erinName, what).count()).toBe(0);
      expect(await page.getByText("Too old to undo").count()).toBe(0);
    } finally {
      await plainCtx.close();
    }

    const viewerCtx = await signedIn(viewer.email);
    try {
      const page = await openActivity(viewerCtx, projectId);
      await page.getByText("Only people who work on this project can see Activity.").waitFor({ timeout: 30_000 });
      expect(await page.getByRole("button", { name: "Undo" }).count()).toBe(0);
    } finally {
      await viewerCtx.close();
    }

    const rootCtx = await signedIn(root.email);
    try {
      const page = await openActivity(rootCtx, projectId);
      await actRow(page, erinName, what).getByRole("button", { name: "Undo" }).waitFor({ state: "visible", timeout: 30_000 });
    } finally {
      await rootCtx.close();
    }

    const leaderCtx = await signedIn(leader.email);
    try {
      const page = await openActivity(leaderCtx, projectId);
      const button = actRow(page, erinName, what).getByRole("button", { name: "Undo" });
      await button.waitFor({ state: "visible", timeout: 30_000 });
      await button.click();
      await expect.poll(async () => (await leader.c.get(`/api/tasks/${created.id}`)).status, { timeout: 20_000 }).toBe(200);
    } finally {
      await leaderCtx.close();
    }
    const trash = await leader.c.get(`/api/projects/${projectId}/trash`);
    expect((trash.json.items as { id: string }[]).some((item) => item.id === created.id)).toBe(false);
  }, 180_000);

  it("qa:TC missing AC5 Undo from the Activity row sends one POST /api/actions/{actionId}/undo with {\"anyway\":false}", async () => {
    const leader = await zzAccount("leader");
    const editor = await zzAccount("editor");
    const projectId = await zzProject(leader, [{ who: editor }]);
    const created = await zzTask(editor, projectId, "Undo target");
    expect((await editor.c.del(`/api/tasks/${created.id}`)).status).toBe(204);
    const items = (await leader.c.get(`/api/projects/${projectId}/activity`)).json.items as { id: string; what: string }[];
    const actionId = items.find((item) => item.what === `moved "${created.title}" to Trash`)?.id;
    expect(actionId).toBeTruthy();
    const name = await displayName(editor);

    const ctx = await signedIn(leader.email);
    const posts: { path: string; body: string | null }[] = [];
    try {
      const page = await openActivity(ctx, projectId);
      page.on("request", (req) => {
        if (req.method() !== "POST") return;
        const path = new URL(req.url()).pathname;
        if (path.endsWith("/undo")) posts.push({ path, body: req.postData() });
      });
      const button = actRow(page, name, `moved "${created.title}" to Trash`).getByRole("button", { name: "Undo" });
      await button.waitFor({ state: "visible", timeout: 30_000 });
      await button.click();
      await expect.poll(async () => (await leader.c.get(`/api/tasks/${created.id}`)).status, { timeout: 20_000 }).toBe(200);
    } finally {
      await ctx.close();
    }
    expect(posts).toEqual([{ path: `/api/actions/${actionId}/undo`, body: '{"anyway":false}' }]);
  }, 90_000);

  it("qa:TC missing AC6 A delete more than 30×24h old shows \"Too old to undo\" and no Undo to the Leader", async () => {
    const leader = await zzAccount("leader");
    const editor = await zzAccount("editor");
    const projectId = await zzProject(leader, [{ who: editor }]);
    const created = await zzTask(editor, projectId, "Old delete");
    expect((await editor.c.del(`/api/tasks/${created.id}`)).status).toBe(204);
    const log = await db.actionLog.findFirstOrThrow({
      where: { action: "task.deleted", targetId: created.id, actorId: editor.id },
      orderBy: { createdAt: "desc" },
    });
    await db.actionLog.update({ where: { id: log.id }, data: { createdAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) } });
    const name = await displayName(editor);
    const what = `moved "${created.title}" to Trash`;

    const ctx = await signedIn(leader.email);
    try {
      const page = await openActivity(ctx, projectId);
      const row = actRow(page, name, what);
      await row.waitFor({ state: "visible", timeout: 30_000 });
      expect(await row.getByRole("button", { name: "Undo" }).count()).toBe(0);
      expect(await row.innerText()).toContain("Too old to undo");
    } finally {
      await ctx.close();
    }
  }, 90_000);

  it("qa:TC missing AC7 A deleted task stays in Trash with 30 days, and the Leader restores it from Trash and from the Activity row (the toast is not asserted)", async () => {
    const leader = await zzAccount("leader");
    const projectId = await zzProject(leader);
    const leaderName = await displayName(leader);
    const first = await zzTask(leader, projectId, "Trash me");
    expect((await leader.c.del(`/api/tasks/${first.id}`)).status).toBe(204);
    const listed = await leader.c.get(`/api/projects/${projectId}/trash`);
    const item = (listed.json.items as { id: string; daysLeft: number }[]).find((row) => row.id === first.id);
    expect(item?.daysLeft).toBe(30);

    const ctx = await signedIn(leader.email);
    try {
      const page = await ctx.newPage();
      await page.goto(`/projects/${projectId}/trash`, { waitUntil: "load", timeout: 45_000 });
      const row = page.getByRole("row").filter({ hasText: first.title });
      await row.waitFor({ state: "visible", timeout: 30_000 });
      expect(await row.innerText()).toContain("30 days");
      await row.getByRole("button", { name: "Restore" }).click();
      await expect.poll(async () => (await leader.c.get(`/api/tasks/${first.id}`)).status, { timeout: 20_000 }).toBe(200);

      const again = await zzTask(leader, projectId, "Undo me");
      expect((await leader.c.del(`/api/tasks/${again.id}`)).status).toBe(204);
      const activity = await openActivity(ctx, projectId);
      const button = actRow(activity, leaderName, `moved "${again.title}" to Trash`).getByRole("button", { name: "Undo" });
      await button.waitFor({ state: "visible", timeout: 30_000 });
      await button.click();
      await expect.poll(async () => (await leader.c.get(`/api/tasks/${again.id}`)).status, { timeout: 20_000 }).toBe(200);
    } finally {
      await ctx.close();
    }
  }, 120_000);
});
