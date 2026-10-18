// APL-2674: the Activity page shows Undo on a delete only to people who may restore.
// The server check is unchanged (APL-2640). These cases open the page, or call the undo API, on a seeded project.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { account, BASE, patchTask, PW, superAdmin, task, type Account } from "./helpers";

/**
 * One test per approved AC v1. Pam has not published qa:TC-APL2674 markers on APL-2674
 * (R-S3 still pending; the issue's only comments are Michael's). Re-pin each title to her
 * exact `qa:TC-APL2674-xxxxxxxx@vN` string when that comment lands.
 */
const QA = {
  ac1: "APL-2674-AC1@v1",
  ac2: "APL-2674-AC2@v1",
  ac3: "APL-2674-AC3@v1",
};

const TITLE = "Fix invoice";
const DELETED = `moved "${TITLE}" to Trash`;
const RENAMED_TO = "Invoice sent";

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({
    executablePath: process.env.PW_CHROMIUM || "/usr/bin/google-chrome",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
}, 60_000);

afterAll(async () => {
  await browser?.close();
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

function deleteRow(page: Page, who: string) {
  return page.locator(".item.act", { hasText: DELETED }).filter({
    has: page.locator("strong", { hasText: new RegExp(`^${who}$`) }),
  });
}

describe("APL-2674 activity delete undo", () => {
  it(`${QA.ac1} Undo on a task.deleted row follows the Trash restore rule`, async () => {
    const leader = await account("leader");
    const editor = await account("editor");
    const root = await superAdmin();
    const projectId = await alpha(leader, editor);
    const [leaderName, editorName, rootName] = await Promise.all([displayName(leader), displayName(editor), displayName(root)]);

    const editorTask = await task(editor, projectId, { title: TITLE });
    const leaderTask = await task(leader, projectId, { title: TITLE });
    const rootTask = await task(root, projectId, { title: TITLE });
    expect((await editor.c.del(`/api/tasks/${editorTask}`)).status).toBe(204);
    expect((await leader.c.del(`/api/tasks/${leaderTask}`)).status).toBe(204);
    expect((await root.c.del(`/api/tasks/${rootTask}`)).status).toBe(204);

    const contexts: BrowserContext[] = [];
    try {
      const editorCtx = await signedIn(editor.email);
      contexts.push(editorCtx);
      const editorPage = await openActivity(editorCtx, projectId);
      const editorRow = deleteRow(editorPage, editorName);
      await editorRow.waitFor({ state: "visible", timeout: 30_000 });
      expect(await editorRow.getByRole("button", { name: "Undo" }).count()).toBe(0);

      const leaderCtx = await signedIn(leader.email);
      contexts.push(leaderCtx);
      const leaderPage = await openActivity(leaderCtx, projectId);
      const leaderRow = deleteRow(leaderPage, leaderName);
      await leaderRow.getByRole("button", { name: "Undo" }).waitFor({ state: "visible", timeout: 30_000 });

      const rootCtx = await signedIn(root.email);
      contexts.push(rootCtx);
      const rootPage = await openActivity(rootCtx, projectId);
      const rootRow = deleteRow(rootPage, rootName);
      await rootRow.getByRole("button", { name: "Undo" }).waitFor({ state: "visible", timeout: 30_000 });
    } finally {
      await Promise.all(contexts.map((ctx) => ctx.close()));
    }
  }, 90_000);

  it(`${QA.ac2} Other Undo rows are unchanged`, async () => {
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

  it(`${QA.ac3} The server stays the source of truth`, async () => {
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
});
