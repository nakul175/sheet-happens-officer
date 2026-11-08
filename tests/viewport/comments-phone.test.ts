// APL-2590 N1: on a 390×800 phone, Add comment must post. The tab bar used to return on
// textarea blur and swallow the pointerup. Needs Chromium (PW_CHROMIUM, or Playwright's build)
// and a local server. When that server has ff_task_comments off, this starts a second one.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { account, BASE, cleanupZz, project, PW, superAdmin, task, type Account } from "../helpers";
import { requireLocalFixtures } from "./screen-ready";

const SHOTS = "test-results/viewport";
let browser: Browser;
let child: ChildProcess | null = null;
let app = BASE;
let projectId = "";
let taskId = "";
let email = "";
let viewerEmail = "";
// QA #128 D4: ZZ-TEST names and nakul17+ aliases. The Super Admin leads the project so that, in afterAll,
// it can deactivate both people and archive the project through the API.
const RUN = Date.now().toString(36);
let root: Account | null = null;
const made: Account[] = [];
const CLEANUP = "test-results/viewport/comments/cleanup.json";

async function up(url: string) {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`The comments server did not answer ${url}`);
}

beforeAll(async () => {
  requireLocalFixtures(BASE, process.env.DATABASE_URL);
  mkdirSync(SHOTS, { recursive: true });
  browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
  const writer = await account("phonewriter", `nakul17+zztest-apl2590-phone-writer-${RUN}@aplyd.com`, "ZZ-TEST phone writer");
  made.push(writer);
  email = writer.email;
  const colleague = await account("phonecolleague", `nakul17+zztest-apl2590-phone-colleague-${RUN}@aplyd.com`, "ZZ-TEST phone colleague");
  made.push(colleague);
  const viewer = await account("phoneviewer", `nakul17+zztest-apl2590-phone-viewer-${RUN}@aplyd.com`, "ZZ-TEST phone viewer");
  made.push(viewer);
  viewerEmail = viewer.email;
  root = await superAdmin();
  const p = await project(root, root, [{ who: writer, role: "EDITOR" }, { who: colleague, role: "EDITOR" }, { who: viewer, role: "VIEWER" }], `ZZ-TEST phone ${RUN}`);
  projectId = p.id;
  taskId = await task(writer, p.id, { title: "ZZ-TEST phone comment" });
  const probe = await writer.c.get(`/api/tasks/${taskId}`);
  if (probe.json?.task?.commentsEnabled) {
    app = BASE;
    return;
  }
  child = spawn("npx", ["next", "start", "-p", "3191"], {
    env: { ...process.env, FF_TASK_COMMENTS: "true", FEATURE_COMMENTS: "true", NODE_ENV: "production", PORT: "3191" },
    stdio: "ignore",
  });
  app = "http://127.0.0.1:3191";
  await up(`${app}/api/health`);
}, 90_000);

afterAll(async () => {
  let cleanup = false;
  try {
    if (projectId || made.length) await cleanupZz(projectId ? [projectId] : [], made);
    cleanup = true;
  } finally {
    await browser?.close();
    if (child && !child.killed) child.kill();
    mkdirSync("test-results/viewport/comments", { recursive: true });
    writeFileSync(CLEANUP, JSON.stringify({ projects: Number(Boolean(projectId)), people: made.length, cleanup }, null, 2));
  }
});

async function phone(): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 800 },
    hasTouch: true,
    isMobile: true,
    baseURL: app,
  });
  const r = await ctx.request.post("/api/auth/signin", { data: { email, password: "correct-horse-9" } });
  expect(r.ok(), "sign in on the phone").toBe(true);
  const page = await ctx.newPage();
  return { ctx, page };
}

describe("phone comments", () => {
  it("feature OFF hides an existing comment from routes, task UI and search without deleting it", async () => {
    expect(app, "the default fixture server must have comments OFF; the second server has them ON").not.toBe(BASE);
    const on = await browser.newContext({ baseURL: app });
    const off = await browser.newContext({ baseURL: BASE });
    const token = `ZZ-TEST-flag-off-${RUN}`;
    const url = `/api/tasks/${taskId}/comments`;
    try {
      for (const ctx of [on, off]) {
        expect((await ctx.request.post("/api/auth/signin", { data: { email, password: PW } })).status()).toBe(200);
      }
      const created = await on.request.post(url, { data: { text: token } });
      expect(created.status()).toBe(201);
      const commentId = (await created.json()).comment.id as string;
      const enabledSearch = await on.request.get(`/api/search?q=${encodeURIComponent(token)}`);
      expect(enabledSearch.status()).toBe(200);
      const enabledResults = await enabledSearch.json();
      expect(enabledResults.tasks.map((found: { id: string }) => found.id)).toContain(taskId);
      expect(JSON.stringify(enabledResults)).not.toContain(token);
      expect((await off.request.get(url)).status()).toBe(404);
      expect((await off.request.post(url, { data: { text: "ZZ-TEST denied while OFF" } })).status()).toBe(404);
      expect((await off.request.patch(`${url}/${commentId}`, { data: { text: "ZZ-TEST denied edit while OFF" } })).status()).toBe(404);
      expect((await off.request.delete(`${url}/${commentId}`)).status()).toBe(404);
      const search = await off.request.get(`/api/search?q=${encodeURIComponent(token)}`);
      expect(search.status()).toBe(200);
      expect((await search.json()).tasks).toEqual([]);
      const page = await off.newPage();
      await page.goto(`/projects/${projectId}?task=${taskId}`, { waitUntil: "load" });
      await page.getByRole("dialog", { name: "Task", exact: true }).waitFor();
      expect(await page.getByRole("heading", { name: /Comments/ }).count()).toBe(0);
      expect(await page.getByText(token).count()).toBe(0);
      const retained = await on.request.get(url);
      expect(retained.status()).toBe(200);
      expect((await retained.json()).comments.some((comment: { id: string; text: string }) => comment.id === commentId && comment.text === token)).toBe(true);
    } finally {
      await on.close();
      await off.close();
    }
  });

  it("denies signed-in Viewer comment writes on the feature-enabled server without changing the visible list", async () => {
    const writer = await browser.newContext({ baseURL: app });
    const viewer = await browser.newContext({ baseURL: app });
    try {
      expect((await writer.request.post("/api/auth/signin", { data: { email, password: "correct-horse-9" } })).status()).toBe(200);
      expect((await viewer.request.post("/api/auth/signin", { data: { email: viewerEmail, password: "correct-horse-9" } })).status()).toBe(200);
      const url = `/api/tasks/${taskId}/comments`;
      const created = await writer.request.post(url, { data: { text: `ZZ-TEST viewer boundary ${RUN}` } });
      expect(created.status()).toBe(201);
      const id = (await created.json()).comment.id as string;
      const before = await viewer.request.get(url);
      expect(before.status()).toBe(200);
      const list = await before.json();
      expect(list.comments.some((comment: { id: string }) => comment.id === id)).toBe(true);
      expect((await viewer.request.post(url, { data: { text: "ZZ-TEST denied" } })).status()).toBe(403);
      expect((await viewer.request.patch(`${url}/${id}`, { data: { text: "ZZ-TEST denied edit" } })).status()).toBe(403);
      expect((await viewer.request.delete(`${url}/${id}`)).status()).toBe(403);
      expect(await (await viewer.request.get(url)).json()).toEqual(list);
    } finally {
      await writer.close();
      await viewer.close();
    }
  });

  it("edits and deletes an owned comment in the phone UI with escaped text and server readback", async () => {
    const { ctx, page } = await phone();
    const original = `ZZ-TEST edit phone ${RUN}`;
    const edited = `ZZ-TEST edited <img src=x onerror=alert(1)> ${RUN}`;
    const url = `/api/tasks/${taskId}/comments`;
    try {
      await page.goto(`/projects/${projectId}?task=${taskId}`, { waitUntil: "load" });
      await page.getByRole("dialog", { name: "Task", exact: true }).waitFor();
      await page.getByLabel("Add a comment").fill(original);
      await page.getByRole("button", { name: "Add comment" }).click();
      const comment = page.locator("article.comment").filter({ hasText: original });
      await comment.waitFor();
      const created = await ctx.request.get(url);
      expect(created.status()).toBe(200);
      const id = (await created.json()).comments.find((item: { id: string; text: string }) => item.text === original)?.id as string | undefined;
      expect(id).toBeTruthy();

      await comment.getByRole("button", { name: "Edit comment" }).click();
      await comment.getByLabel("Edit comment").fill(edited);
      const [patch] = await Promise.all([
        page.waitForResponse((response) => response.url().endsWith(`${url}/${id}`) && response.request().method() === "PATCH"),
        page.getByRole("dialog", { name: "Task", exact: true }).getByRole("button", { name: "Save", exact: true }).click(),
      ]);
      expect(patch.status()).toBe(200);
      const changed = page.locator("article.comment").filter({ hasText: edited });
      await changed.waitFor();
      expect(await changed.locator("img").count()).toBe(0);
      expect((await (await ctx.request.get(url)).json()).comments.some((item: { id: string; text: string }) => item.id === id && item.text === edited)).toBe(true);

      const [deleted] = await Promise.all([
        page.waitForResponse((response) => response.url().endsWith(`${url}/${id}`) && response.request().method() === "DELETE"),
        changed.getByRole("button", { name: "Delete comment" }).click(),
      ]);
      expect(deleted.status()).toBe(204);
      await changed.waitFor({ state: "detached" });
      expect((await (await ctx.request.get(url)).json()).comments.some((item: { id: string }) => item.id === id)).toBe(false);
    } catch (error) {
      await page.screenshot({ path: `${SHOTS}/phone-edit-delete-comment.png`, fullPage: true }).catch(() => {});
      throw error;
    } finally {
      await ctx.close();
    }
  });

  it("qa:TC missing N1: posts a comment from a 390x800 viewport", async () => {
    const { ctx, page } = await phone();
    const text = `ZZ-TEST phone ${Date.now().toString(36)}`;
    try {
      await page.goto(`/projects/${projectId}?task=${taskId}`, { waitUntil: "load" });
      const box = page.getByLabel("Add a comment");
      await box.waitFor({ state: "visible" });
      await box.click();
      await box.fill(text);
      const [res] = await Promise.all([
        page.waitForResponse((r) => r.url().includes(`/api/tasks/${taskId}/comments`) && r.request().method() === "POST"),
        page.getByRole("button", { name: "Add comment" }).click(),
      ]);
      expect(res.status(), "Add comment posts").toBe(201);
      await page.getByText(text).waitFor({ state: "visible" });
    } catch (e) {
      await page.screenshot({ path: `${SHOTS}/phone-add-comment.png`, fullPage: true }).catch(() => {});
      throw e;
    } finally {
      await ctx.close();
    }
  });

  it("qa:TC missing N2: the @ picker has no nested button on a phone", async () => {
    const { ctx, page } = await phone();
    try {
      await page.goto(`/projects/${projectId}?task=${taskId}`, { waitUntil: "load" });
      const box = page.getByLabel("Add a comment");
      await box.waitFor({ state: "visible" });
      await box.click();
      await box.fill("@");
      const list = page.getByRole("listbox", { name: "Mention a project member" });
      await list.waitFor({ state: "visible" });
      expect(await list.getByRole("button").count()).toBe(0);
      expect(await list.getByRole("option").count()).toBeGreaterThan(0);
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      expect(await box.inputValue()).toMatch(/@/);
      await page.addScriptTag({ path: "node_modules/axe-core/axe.min.js" });
      // D7: color-contrast is on, and its violations are asserted with nested-interactive.
      // axe takes a DOM node; the region is the one the Comments heading labels.
      const found = await page.evaluate(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = await (window as any).axe.run(document.querySelector("[aria-labelledby=comments-heading]"), {
          runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"] },
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ids = (id: string) => r.violations.filter((v: any) => v.id === id).map((v: any) => v.nodes.length);
        return { nested: ids("nested-interactive"), contrast: ids("color-contrast") };
      });
      expect(found).toEqual({ nested: [], contrast: [] });
    } catch (e) {
      await page.screenshot({ path: `${SHOTS}/phone-mention-picker.png`, fullPage: true }).catch(() => {});
      throw e;
    } finally {
      await ctx.close();
    }
  });
});
