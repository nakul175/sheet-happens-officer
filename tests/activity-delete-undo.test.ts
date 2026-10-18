// APL-2674: the Activity page shows Undo on a delete only to people who may restore.
// The server check is unchanged (APL-2640). These cases open the page, or call the undo API, on a seeded project.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { PrismaClient } from "../src/generated/prisma/client";
import { projectActivity } from "../src/lib/feed";
import { purgeTrash } from "../src/lib/tasks";
import { account, admin, BASE, patchTask, PW, superAdmin, task, type Account } from "./helpers";

/** Titles are Pam's register text. Do not reword a qa:TC name. */

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

async function deletedTask(editor: Account, projectId: string, title: string) {
  const taskId = await task(editor, projectId, { title });
  expect((await editor.c.del(`/api/tasks/${taskId}`)).status).toBe(204);
  const logId = await ageLog(taskId, editor.id, "task.deleted", 0);
  return { taskId, logId, what: `moved "${title}" to Trash` };
}

/** The feed the Activity page renders. A live request cannot land on a 1 ms boundary, so exact ages are read here. */
async function undoFlag(user: { id: string; orgRole: "MEMBER" | "ADMIN" | "SUPER_ADMIN" }, projectId: string, logId: string) {
  const feed = await projectActivity(user, projectId);
  return feed.items.find((item) => item.id === logId)?.undo;
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

  it("qa:TC-APL2674-d0b5b573@v2 Leader and super admin see Undo on another Editor's delete, and it restores as Trash does", async () => {
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

  it("qa:TC-APL2674-db4b7af8@v3 Another Editor and a Viewer see no Undo on Erin's delete", async () => {
    const leader = await account("leader");
    const erin = await account("erin");
    const other = await account("other");
    const uninvolved = await account("uninvolved");
    const viewer = await account("viewer");
    const projectId = await alpha(leader, erin);
    await addMember(leader, projectId, other, "EDITOR");
    await addMember(leader, projectId, uninvolved, "EDITOR");
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
      expect(await row.innerText()).not.toContain("Too old to undo");
    } finally {
      await otherCtx.close();
    }

    const plainCtx = await signedIn(uninvolved.email);
    try {
      const page = await openActivity(plainCtx, projectId);
      const row = deleteRow(page, erinName);
      if ((await row.count()) > 0) {
        expect(await row.getByRole("button", { name: "Undo" }).count()).toBe(0);
        expect(await row.innerText()).not.toContain("Too old to undo");
      }
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

    const trash = await leader.c.get(`/api/projects/${projectId}/trash`);
    expect((trash.json.items as { id: string }[]).some((item) => item.id === id)).toBe(true);
  }, 90_000);

  it("qa:TC-APL2674-a4fde780@v2 Activity Undo sends POST /api/actions/{actionId}/undo with {\"anyway\":false}", async () => {
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

  it("qa:TC-APL2674-d3c54eaf@v3 A delete more than 30×24h old shows \"Too old to undo\", for anyone allowed to undo it", async () => {
    const leader = await account("leader");
    const editor = await account("editor");
    const root = await superAdmin();
    const projectId = await alpha(leader, editor);
    const row = await deletedTask(editor, projectId, TITLE);
    const name = await displayName(editor);

    const realNow = Date.now;
    const T = realNow();
    // IST midnight is 18:30 UTC. The server clock cannot be moved, so this instant is applied to the feed the page renders.
    const istMidnight = Date.UTC(new Date(T).getUTCFullYear(), new Date(T).getUTCMonth(), new Date(T).getUTCDate(), 18, 30, 0, 0);
    try {
      Date.now = () => T;
      await setLogTime(row.logId, new Date(T - 31 * DAY));
      expect(await undoFlag({ id: leader.id, orgRole: "MEMBER" }, projectId, row.logId)).toBe("too_old");
      expect(await undoFlag({ id: root.id, orgRole: "SUPER_ADMIN" }, projectId, row.logId)).toBe("too_old");
      Date.now = () => istMidnight;
      await setLogTime(row.logId, new Date(istMidnight - 31 * DAY));
      expect(await undoFlag({ id: leader.id, orgRole: "MEMBER" }, projectId, row.logId)).toBe("too_old");
    } finally {
      Date.now = realNow;
    }

    await setLogTime(row.logId, new Date(Date.now() - 31 * DAY));
    for (const who of [leader, root]) {
      const ctx = await signedIn(who.email);
      try {
        const page = await openActivity(ctx, projectId);
        await expectTooOld(page, name, DELETED);
        await page.reload({ waitUntil: "load", timeout: 45_000 });
        await expectTooOld(page, name, DELETED);
      } finally {
        await ctx.close();
      }
    }
  }, 120_000);

  it("qa:TC-APL2674-6b35ff98@v3 30×24h boundary: exactly 30×24h is undoable; 1 ms or 1 minute more is too old", async () => {
    const leader = await account("leader");
    const editor = await account("editor");
    const projectId = await alpha(leader, editor);
    const name = await displayName(editor);
    const rows = {
      a: await deletedTask(editor, projectId, "Fix invoice a"),
      b: await deletedTask(editor, projectId, TITLE),
      c: await deletedTask(editor, projectId, "Fix invoice c"),
      d: await deletedTask(editor, projectId, "Fix invoice d"),
    };
    const offsets = { a: 2_591_999_000, b: 2_592_000_000, c: 2_592_000_001, d: 2_592_060_000 };

    const realNow = Date.now;
    const T = realNow();
    try {
      Date.now = () => T;
      for (const key of ["a", "b", "c", "d"] as const) await setLogTime(rows[key].logId, new Date(T - offsets[key]));
      expect(await undoFlag({ id: leader.id, orgRole: "MEMBER" }, projectId, rows.a.logId)).toBe("available");
      expect(await undoFlag({ id: leader.id, orgRole: "MEMBER" }, projectId, rows.b.logId)).toBe("available");
      expect(await undoFlag({ id: leader.id, orgRole: "MEMBER" }, projectId, rows.c.logId)).toBe("too_old");
      expect(await undoFlag({ id: leader.id, orgRole: "MEMBER" }, projectId, rows.d.logId)).toBe("too_old");
    } finally {
      Date.now = realNow;
    }

    // (a) and (b) sit about 60s inside the window so the live page can still show Undo. (c) and (d) stay past it.
    const now = Date.now();
    await setLogTime(rows.a.logId, new Date(now - WINDOW + 60_000));
    await setLogTime(rows.b.logId, new Date(now - WINDOW + 60_000));
    await setLogTime(rows.c.logId, new Date(now - offsets.c));
    await setLogTime(rows.d.logId, new Date(now - offsets.d));
    const ctx = await signedIn(leader.email);
    try {
      const page = await openActivity(ctx, projectId);
      for (const key of ["a", "b"] as const) {
        const item = deleteRow(page, name, rows[key].what);
        await item.getByRole("button", { name: "Undo" }).waitFor({ state: "visible", timeout: 30_000 });
        expect(await item.innerText()).not.toContain("Too old to undo");
      }
      await expectTooOld(page, name, rows.c.what);
      await expectTooOld(page, name, rows.d.what);
      await clickUndo(page, name, rows.b.what);
      await expect.poll(async () => (await leader.c.get(`/api/tasks/${rows.b.taskId}`)).status, { timeout: 20_000 }).toBe(200);
    } finally {
      await ctx.close();
    }
  }, 120_000);

  it("qa:TC-APL2674-8633ebdd@v1 A non-delete undoable action more than 30×24h old shows \"Too old to undo\"", async () => {
    const leader = await account("leader");
    const editor = await account("editor");
    const projectId = await alpha(leader, editor);
    const oldTitle = "Fix invoice 2";
    const oldTo = "old edit";
    const controlTitle = "Fix invoice control";
    const controlTo = "control edit";
    const oldId = await task(editor, projectId, { title: oldTitle });
    const controlId = await task(editor, projectId, { title: controlTitle });
    expect((await patchTask(editor, oldId, { title: oldTo })).status).toBe(200);
    expect((await patchTask(editor, controlId, { title: controlTo })).status).toBe(200);
    const oldLog = await ageLog(oldId, editor.id, "task.updated", 0);
    const controlLog = await ageLog(controlId, editor.id, "task.updated", 0);
    const name = await displayName(editor);
    const oldWhat = `renamed "${oldTitle}" to "${oldTo}"`;
    const controlWhat = `renamed "${controlTitle}" to "${controlTo}"`;

    const realNow = Date.now;
    const T = realNow();
    try {
      Date.now = () => T;
      await setLogTime(oldLog, new Date(T - 2_592_000_001));
      await setLogTime(controlLog, new Date(T - 2_592_000_000));
      expect(await undoFlag({ id: editor.id, orgRole: "MEMBER" }, projectId, oldLog)).toBe("too_old");
      expect(await undoFlag({ id: editor.id, orgRole: "MEMBER" }, projectId, controlLog)).toBe("available");
    } finally {
      Date.now = realNow;
    }

    const now = Date.now();
    await setLogTime(oldLog, new Date(now - 2_592_000_001));
    await setLogTime(controlLog, new Date(now - WINDOW + 60_000));
    const ctx = await signedIn(editor.email);
    try {
      const page = await openActivity(ctx, projectId);
      await expectTooOld(page, name, oldWhat);
      const control = deleteRow(page, name, controlWhat);
      await control.getByRole("button", { name: "Undo" }).waitFor({ state: "visible", timeout: 30_000 });
      expect(await control.innerText()).not.toContain("Too old to undo");
    } finally {
      await ctx.close();
    }
    expect((await editor.c.get(`/api/tasks/${oldId}`)).json.task.title).toBe(oldTo);
  }, 90_000);

  it("qa:TC-APL2674-49035634@v1 PROVISIONAL (BA ruling; NJ confirms at 8:30 AM IST): \"Too old to undo\" shows only to people who could have undone the action", async () => {
    const leader = await account("leader");
    const editor = await account("editor");
    const erin = await account("erin");
    const viewer = await account("viewer");
    const root = await superAdmin();
    const projectId = await alpha(leader, editor);
    await addMember(leader, projectId, erin, "EDITOR");
    await addMember(leader, projectId, viewer, "VIEWER");
    const id = await task(editor, projectId, { title: "Fix invoice 2" });
    expect((await patchTask(editor, id, { title: RENAMED_TO })).status).toBe(200);
    expect((await editor.c.post(`/api/tasks/${id}/collaborators`, { userId: erin.id })).status).toBe(201);
    await ageLog(id, editor.id, "task.updated", 31 * DAY);
    const what = `renamed "Fix invoice 2" to "${RENAMED_TO}"`;
    const name = await displayName(editor);

    for (const who of [editor, leader, root]) {
      const ctx = await signedIn(who.email);
      try {
        const page = await openActivity(ctx, projectId);
        await expectTooOld(page, name, what);
      } finally {
        await ctx.close();
      }
    }

    const erinCtx = await signedIn(erin.email);
    try {
      const page = await openActivity(erinCtx, projectId);
      const row = deleteRow(page, name, what);
      await row.waitFor({ state: "visible", timeout: 30_000 });
      expect(await row.getByRole("button", { name: "Undo" }).count()).toBe(0);
      expect(await row.innerText()).not.toContain("Too old to undo");
    } finally {
      await erinCtx.close();
    }

    const viewerCtx = await signedIn(viewer.email);
    try {
      const page = await openActivity(viewerCtx, projectId);
      await page.getByText("Only people who work on this project can see Activity.").waitFor({ timeout: 30_000 });
      expect(await page.getByRole("button", { name: "Undo" }).count()).toBe(0);
      expect(await page.getByText("Too old to undo").count()).toBe(0);
    } finally {
      await viewerCtx.close();
    }
  }, 150_000);

  it("qa:TC-APL2674-070b48b9@v3 PROVISIONAL (AC7; NJ confirms at 8:30 AM IST): the Undo toast disappears after 10 s and the task stays in Trash with \"30 days left\"", async () => {
    const leader = await account("leader");
    const editor = await account("editor");
    const projectId = await alpha(leader, editor);
    const leaderName = await displayName(leader);
    const first = await task(leader, projectId, { title: TITLE });
    expect((await leader.c.del(`/api/tasks/${first}`)).status).toBe(204);
    const listed = await leader.c.get(`/api/projects/${projectId}/trash`);
    const item = (listed.json.items as { id: string; daysLeft: number }[]).find((row) => row.id === first);
    expect(item?.daysLeft).toBe(30);

    const ctx = await signedIn(leader.email);
    try {
      const page = await ctx.newPage();
      await page.goto(`/projects/${projectId}/trash`, { waitUntil: "load", timeout: 45_000 });
      const row = page.locator("tr", { hasText: TITLE });
      await row.waitFor({ state: "visible", timeout: 30_000 });
      expect(await row.innerText()).toContain("30 days");
      await row.getByRole("button", { name: "Restore" }).click();
      await expect.poll(async () => (await leader.c.get(`/api/tasks/${first}`)).status, { timeout: 20_000 }).toBe(200);

      const again = await task(leader, projectId, { title: "Pay vendor" });
      expect((await leader.c.del(`/api/tasks/${again}`)).status).toBe(204);
      const activity = await openActivity(ctx, projectId);
      await clickUndo(activity, leaderName, 'moved "Pay vendor" to Trash');
      await expect.poll(async () => (await leader.c.get(`/api/tasks/${again}`)).status, { timeout: 20_000 }).toBe(200);
    } finally {
      await ctx.close();
    }
  }, 120_000);

  it("qa:TC-APL2674-52c1df8f@v1 PROVISIONAL: purge-trash keeps a task 1 s short of 30×24h (the exact-30×24h purge row is superseded by APL-2711)", async () => {
    const leader = await account("leader");
    const editor = await account("editor");
    const projectId = await alpha(leader, editor);
    const keep = await task(leader, projectId, { title: TITLE });
    const exact = await task(leader, projectId, { title: "Fix invoice 3" });
    expect((await leader.c.del(`/api/tasks/${keep}`)).status).toBe(204);
    expect((await leader.c.del(`/api/tasks/${exact}`)).status).toBe(204);
    // Fix invoice 3 sits at exactly 30×24h. APL-2711 owns that result, so it is not asserted.
    const T = Date.now();
    await db.task.update({ where: { id: keep }, data: { deletedAt: new Date(T - 2_591_999_000) } });
    await db.task.update({ where: { id: exact }, data: { deletedAt: new Date(T - 2_592_000_000) } });
    await purgeTrash(new Date(T));

    const trash = await leader.c.get(`/api/projects/${projectId}/trash`);
    expect(trash.status).toBe(200);
    expect((trash.json.items as { id: string }[]).some((item) => item.id === keep)).toBe(true);
    expect((await leader.c.post(`/api/tasks/${keep}/restore`)).status).toBe(200);
    expect((await leader.c.get(`/api/tasks/${keep}`)).status).toBe(200);
  }, 60_000);
});
