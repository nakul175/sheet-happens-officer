// APL-2674: the Activity page shows Undo on a delete only to people who may restore.
// The server check is unchanged (APL-2640). These cases open the page, or call the undo API, on a seeded project.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { PrismaClient } from "../src/generated/prisma/client";
import { projectActivity } from "../src/lib/feed";
import { account, admin, BASE, patchTask, PW, superAdmin, task, type Account } from "./helpers";

/** AC1–AC3 stay on Pam's @v1 markers. AC4–AC6 are tagged with AC ids until Pam's v2 TC ids land. No AC7. */

const TITLE = "Fix invoice";
const DELETED = `moved "${TITLE}" to Trash`;
const RENAMED_TO = "Invoice sent";
const DAY = 24 * 60 * 60 * 1000;
const WINDOW = 30 * DAY;

const db = new PrismaClient();
let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({
    executablePath: process.env.PW_CHROMIUM || "/usr/bin/google-chrome",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await db.$disconnect();
});

async function alpha(leader: Account, editor: Account) {
  const r = await leader.c.post("/api/projects", { name: "Alpha", leaderId: leader.id });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = r.json.project.id as string;
  expect((await leader.c.post(`/api/projects/${id}/members`, { userId: editor.id, role: "EDITOR" })).status).toBe(201);
  return id;
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

/** Open Activity and wait until the project role the page gates on has loaded. */
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

function deleteRow(page: Page, who: string, what = DELETED) {
  return page.locator(".item.act", { hasText: what }).filter({
    has: page.locator("strong", { hasText: new RegExp(`^${who}$`) }),
  });
}

async function addMember(leader: Account, projectId: string, who: Account, role: "EDITOR" | "VIEWER") {
  expect((await leader.c.post(`/api/projects/${projectId}/members`, { userId: who.id, role })).status).toBe(201);
}

async function preserved(id: string) {
  const row = await db.task.findUniqueOrThrow({
    where: { id },
    select: { title: true, sectionId: true, position: true, priority: true, description: true, assigneeId: true, dueDate: true, deletedAt: true },
  });
  const section = await db.section.findUniqueOrThrow({ where: { id: row.sectionId }, select: { name: true } });
  return {
    title: row.title,
    section: section.name,
    position: row.position,
    priority: row.priority,
    description: row.description,
    assigneeId: row.assigneeId,
    dueDate: row.dueDate?.toISOString() ?? null,
    inTrash: row.deletedAt !== null,
  };
}

async function ageLog(targetId: string, actorId: string, action: string, msAgo: number) {
  const row = await db.actionLog.findFirstOrThrow({
    where: { action, targetId, actorId },
    orderBy: { createdAt: "desc" },
  });
  await db.actionLog.update({ where: { id: row.id }, data: { createdAt: new Date(Date.now() - msAgo) } });
  return row.id;
}

async function setLogTime(id: string, createdAt: Date) {
  await db.actionLog.update({ where: { id }, data: { createdAt } });
}

async function clickUndo(page: Page, who: string, what = DELETED) {
  const button = deleteRow(page, who, what).getByRole("button", { name: "Undo" });
  await button.waitFor({ state: "visible", timeout: 30_000 });
  await button.click();
}

async function expectTooOld(page: Page, who: string, what: string) {
  const row = deleteRow(page, who, what);
  await row.waitFor({ state: "visible", timeout: 30_000 });
  expect(await row.getByRole("button", { name: "Undo" }).count()).toBe(0);
  expect(await row.innerText()).toContain("Too old to undo");
}

describe("APL-2674 activity delete undo", () => {
  it("qa:TC-APL2674-4c99513c@v1 Editor sees no Undo on their own task.deleted row", async () => {
    const leader = await account("leader");
    const editor = await account("editor");
    const projectId = await alpha(leader, editor);
    const editorName = await displayName(editor);
    const editorTask = await task(editor, projectId, { title: TITLE });
    expect((await editor.c.del(`/api/tasks/${editorTask}`)).status).toBe(204);

    const ctx = await signedIn(editor.email);
    try {
      const page = await openActivity(ctx, projectId);
      const row = deleteRow(page, editorName);
      await row.waitFor({ state: "visible", timeout: 30_000 });
      // Not rendered at all, including a disabled button.
      expect(await row.getByRole("button", { name: "Undo" }).count()).toBe(0);
    } finally {
      await ctx.close();
    }
    expect((await editor.c.get(`/api/tasks/${editorTask}`)).status).toBe(404);
    const trash = await leader.c.get(`/api/projects/${projectId}/trash`);
    expect(trash.status).toBe(200);
    expect((trash.json.items as { id: string }[]).some((item) => item.id === editorTask)).toBe(true);
  }, 90_000);

  it("qa:TC-APL2674-c7c6fa04@v1 Leader and super admin see Undo on their own task.deleted row", async () => {
    const leader = await account("leader");
    const editor = await account("editor");
    const root = await superAdmin();
    const projectId = await alpha(leader, editor);
    const [leaderName, rootName] = await Promise.all([displayName(leader), displayName(root)]);
    const leaderTask = await task(leader, projectId, { title: TITLE });
    expect((await leader.c.del(`/api/tasks/${leaderTask}`)).status).toBe(204);

    const contexts: BrowserContext[] = [];
    try {
      const leaderCtx = await signedIn(leader.email);
      contexts.push(leaderCtx);
      const leaderPage = await openActivity(leaderCtx, projectId);
      await deleteRow(leaderPage, leaderName).getByRole("button", { name: "Undo" }).waitFor({ state: "visible", timeout: 30_000 });

      const rootTask = await task(root, projectId, { title: TITLE });
      expect((await root.c.del(`/api/tasks/${rootTask}`)).status).toBe(204);
      const rootCtx = await signedIn(root.email);
      contexts.push(rootCtx);
      const rootPage = await openActivity(rootCtx, projectId);
      await deleteRow(rootPage, rootName).getByRole("button", { name: "Undo" }).waitFor({ state: "visible", timeout: 30_000 });
    } finally {
      await Promise.all(contexts.map((ctx) => ctx.close()));
    }
  }, 90_000);

  it("qa:TC-APL2674-5a651835@v1 Editor's Undo on their own edit still shows and works", async () => {
    const leader = await account("leader");
    const editor = await account("editor");
    const projectId = await alpha(leader, editor);
    const id = await task(editor, projectId, { title: TITLE });
    expect((await patchTask(editor, id, { title: RENAMED_TO })).status).toBe(200);

    const ctx = await signedIn(editor.email);
    try {
      const page = await openActivity(ctx, projectId);
      const row = page.locator(".item.act", { hasText: `renamed "${TITLE}" to "${RENAMED_TO}"` });
      const undo = row.getByRole("button", { name: "Undo" });
      await undo.waitFor({ state: "visible", timeout: 30_000 });
      await undo.click();
      await expect.poll(async () => (await editor.c.get(`/api/tasks/${id}`)).json?.task?.title, { timeout: 20_000 }).toBe(TITLE);
    } finally {
      await ctx.close();
    }
  }, 90_000);

  it("qa:TC-APL2674-cbcdf3cc@v1 Direct undo API call on editor's own delete is still 403, nothing restored", async () => {
    const leader = await account("leader");
    const editor = await account("editor");
    const projectId = await alpha(leader, editor);
    const id = await task(editor, projectId, { title: TITLE });
    expect((await editor.c.del(`/api/tasks/${id}`)).status).toBe(204);

    const items = (await editor.c.get(`/api/projects/${projectId}/activity`)).json.items as { id: string; what: string; undo: string }[];
    const row = items.find((item) => item.what === DELETED);
    expect(row?.id).toBeTruthy();
    const undo = await editor.c.post(`/api/actions/${row!.id}/undo`);
    expect(undo.status).toBe(403);
    expect(undo.json.error).toBe("Only the project Leader or an Admin can do this.");
    expect((await editor.c.get(`/api/tasks/${id}`)).status).toBe(404);
    const again = (await editor.c.get(`/api/projects/${projectId}/activity`)).json.items as { id: string; undo: string }[];
    expect(again.find((item) => item.id === row!.id)?.undo).not.toBe("undone");
    const trash = await leader.c.get(`/api/projects/${projectId}/trash`);
    expect(trash.status).toBe(200);
    expect((trash.json.items as { id: string }[]).some((item) => item.id === id)).toBe(true);
  }, 60_000);

  it("APL-2674-AC4@v2 Leader and Admin see Undo on anyone's delete and it restores as Trash does", async () => {
    const leader = await account("leader");
    const erin = await account("erin");
    const root = await superAdmin();
    const orgAdmin = await admin(root, "ada");
    const body = { title: TITLE, description: "Keep the note", priority: "HIGH" as const, dueDate: "2026-11-02" };
    const leaderName = await displayName(leader);
    const erinName = await displayName(erin);
    const otherDelete = 'moved "Pay vendor" to Trash';

    async function likeTrash(clicker: Account) {
      const projectId = await alpha(leader, erin);
      const controlId = await alpha(leader, erin);
      const subject = await task(erin, projectId, body);
      const byLeader = await task(leader, projectId, { title: "Pay vendor" });
      const control = await task(erin, controlId, body);
      const before = await preserved(subject);
      const beforeControl = await preserved(control);
      expect(before).toEqual(beforeControl);
      expect((await erin.c.del(`/api/tasks/${subject}`)).status).toBe(204);
      expect((await leader.c.del(`/api/tasks/${byLeader}`)).status).toBe(204);
      expect((await erin.c.del(`/api/tasks/${control}`)).status).toBe(204);
      expect((await clicker.c.post(`/api/tasks/${control}/restore`)).status).toBe(200);
      const restored = await preserved(control);
      expect(restored).toEqual({ ...beforeControl, inTrash: false });

      const ctx = await signedIn(clicker.email);
      try {
        const page = await openActivity(ctx, projectId);
        await deleteRow(page, erinName).getByRole("button", { name: "Undo" }).waitFor({ state: "visible", timeout: 30_000 });
        await deleteRow(page, leaderName, otherDelete).getByRole("button", { name: "Undo" }).waitFor({ state: "visible", timeout: 30_000 });
        await clickUndo(page, erinName);
        await expect.poll(async () => (await clicker.c.get(`/api/tasks/${subject}`)).status, { timeout: 20_000 }).toBe(200);
      } finally {
        await ctx.close();
      }
      expect(await preserved(subject)).toEqual(restored);
      const trash = await leader.c.get(`/api/projects/${projectId}/trash`);
      expect((trash.json.items as { id: string }[]).some((item) => item.id === subject)).toBe(false);
    }

    await likeTrash(leader);
    await likeTrash(orgAdmin);
    await likeTrash(root);
  }, 180_000);

  it("APL-2674-AC4@v2 Another Editor and a Viewer see no Undo on someone else's delete", async () => {
    const leader = await account("leader");
    const erin = await account("erin");
    const other = await account("other");
    const viewer = await account("viewer");
    const projectId = await alpha(leader, erin);
    await addMember(leader, projectId, other, "EDITOR");
    await addMember(leader, projectId, viewer, "VIEWER");
    const id = await task(leader, projectId, { title: TITLE, assigneeId: other.id });
    expect((await erin.c.del(`/api/tasks/${id}`)).status).toBe(204);
    const erinName = await displayName(erin);

    const otherCtx = await signedIn(other.email);
    try {
      const page = await openActivity(otherCtx, projectId);
      const row = deleteRow(page, erinName);
      await row.waitFor({ state: "visible", timeout: 30_000 });
      expect(await row.getByRole("button", { name: "Undo" }).count()).toBe(0);
      expect(await page.getByRole("button", { name: "Undo" }).count()).toBe(0);
    } finally {
      await otherCtx.close();
    }

    const viewerCtx = await signedIn(viewer.email);
    try {
      const page = await openActivity(viewerCtx, projectId);
      await page.getByText("Only people who work on this project can see Activity.").waitFor({ timeout: 30_000 });
      expect(await page.getByRole("button", { name: "Undo" }).count()).toBe(0);
    } finally {
      await viewerCtx.close();
    }

    const trash = await leader.c.get(`/api/projects/${projectId}/trash`);
    expect((trash.json.items as { id: string }[]).some((item) => item.id === id)).toBe(true);
  }, 90_000);

  it("APL-2674-AC5@v2 Activity Undo sends one POST /api/actions/{actionId}/undo with {\"anyway\":false}", async () => {
    const leader = await account("leader");
    const editor = await account("editor");
    const projectId = await alpha(leader, editor);
    const id = await task(editor, projectId, { title: TITLE });
    expect((await editor.c.del(`/api/tasks/${id}`)).status).toBe(204);
    const items = (await leader.c.get(`/api/projects/${projectId}/activity`)).json.items as { id: string; what: string }[];
    const actionId = items.find((item) => item.what === DELETED)?.id;
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
      await clickUndo(page, name);
      await expect.poll(async () => (await leader.c.get(`/api/tasks/${id}`)).status, { timeout: 20_000 }).toBe(200);
    } finally {
      await ctx.close();
    }

    expect(posts).toEqual([{ path: `/api/actions/${actionId}/undo`, body: '{"anyway":false}' }]);
  }, 90_000);

  it("APL-2674-AC6@v2 An activity row older than 30 days shows Too old to undo and no Undo", async () => {
    const leader = await account("leader");
    const editor = await account("editor");
    const other = await account("other");
    const root = await superAdmin();
    const orgAdmin = await admin(root, "ada");
    const projectId = await alpha(leader, editor);
    await addMember(leader, projectId, other, "EDITOR");
    const id = await task(editor, projectId, { title: TITLE });
    expect((await editor.c.post(`/api/tasks/${id}/collaborators`, { userId: other.id })).status).toBe(201);
    expect((await editor.c.del(`/api/tasks/${id}`)).status).toBe(204);
    await ageLog(id, editor.id, "task.deleted", 31 * DAY);
    const name = await displayName(editor);

    for (const who of [leader, orgAdmin, root, editor]) {
      const ctx = await signedIn(who.email);
      try {
        const page = await openActivity(ctx, projectId);
        await expectTooOld(page, name, DELETED);
      } finally {
        await ctx.close();
      }
    }

    const otherCtx = await signedIn(other.email);
    try {
      const page = await openActivity(otherCtx, projectId);
      const row = deleteRow(page, name);
      await row.waitFor({ state: "visible", timeout: 30_000 });
      expect(await row.getByRole("button", { name: "Undo" }).count()).toBe(0);
      expect(await row.innerText()).not.toContain("Too old to undo");
    } finally {
      await otherCtx.close();
    }
  }, 120_000);

  it("APL-2674-AC6@v2 Exactly 30×24h still shows Undo; one millisecond later is Too old to undo", async () => {
    const leader = await account("leader");
    const editor = await account("editor");
    const projectId = await alpha(leader, editor);
    const exactTask = await task(editor, projectId, { title: TITLE });
    const plusTask = await task(editor, projectId, { title: "Fix invoice 2" });
    expect((await editor.c.del(`/api/tasks/${exactTask}`)).status).toBe(204);
    expect((await editor.c.del(`/api/tasks/${plusTask}`)).status).toBe(204);
    const exactId = await ageLog(exactTask, editor.id, "task.deleted", 0);
    const plusId = await ageLog(plusTask, editor.id, "task.deleted", 0);
    const name = await displayName(editor);
    const plusWhat = 'moved "Fix invoice 2" to Trash';

    const realNow = Date.now;
    const T = realNow();
    try {
      Date.now = () => T;
      await setLogTime(exactId, new Date(T - WINDOW));
      await setLogTime(plusId, new Date(T - WINDOW - 1));
      const feed = await projectActivity({ id: leader.id, orgRole: "MEMBER" }, projectId);
      expect(feed.items.find((item) => item.id === exactId)?.undo).toBe("available");
      expect(feed.items.find((item) => item.id === plusId)?.undo).toBe("too_old");
    } finally {
      Date.now = realNow;
    }

    // A page request cannot land on a 1ms boundary. The frozen feed call above is the exact 30×24h check.
    await setLogTime(exactId, new Date(Date.now() - WINDOW + 60_000));
    await setLogTime(plusId, new Date(Date.now() - WINDOW - 1));
    const ctx = await signedIn(leader.email);
    try {
      const page = await openActivity(ctx, projectId);
      await deleteRow(page, name).getByRole("button", { name: "Undo" }).waitFor({ state: "visible", timeout: 30_000 });
      await expectTooOld(page, name, plusWhat);
      await clickUndo(page, name);
      await expect.poll(async () => (await leader.c.get(`/api/tasks/${exactTask}`)).status, { timeout: 20_000 }).toBe(200);
    } finally {
      await ctx.close();
    }
  }, 90_000);

  it("APL-2674-AC6@v2 An old task.updated row also shows Too old to undo and no Undo", async () => {
    const leader = await account("leader");
    const editor = await account("editor");
    const projectId = await alpha(leader, editor);
    const id = await task(editor, projectId, { title: TITLE });
    expect((await patchTask(editor, id, { title: RENAMED_TO })).status).toBe(200);
    await ageLog(id, editor.id, "task.updated", 31 * DAY);
    const what = `renamed "${TITLE}" to "${RENAMED_TO}"`;
    const name = await displayName(editor);

    const ctx = await signedIn(editor.email);
    try {
      const page = await openActivity(ctx, projectId);
      await expectTooOld(page, name, what);
    } finally {
      await ctx.close();
    }
    expect((await editor.c.get(`/api/tasks/${id}`)).json.task.title).toBe(RENAMED_TO);
  }, 90_000);
});
