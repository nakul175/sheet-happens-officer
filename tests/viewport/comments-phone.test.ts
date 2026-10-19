// APL-2590 N1: on a 390×800 phone, Add comment must post. The tab bar used to return on
// textarea blur and swallow the pointerup. Needs Chromium (PW_CHROMIUM, or Playwright's build)
// and a local server. When that server has ff_task_comments off, this starts a second one.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { account, BASE, project, task } from "../helpers";

const SHOTS = "test-results/viewport";
let browser: Browser;
let child: ChildProcess | null = null;
let app = BASE;
let projectId = "";
let taskId = "";
let email = "";

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
  if (!/^(localhost|127\.0\.0\.1)$/.test(new URL(BASE).hostname)) throw new Error(`Refusing to run the phone comment test against ${BASE}.`);
  mkdirSync(SHOTS, { recursive: true });
  browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
  const writer = await account("phonewriter");
  email = writer.email;
  const colleague = await account("phonecolleague");
  const p = await project(writer, writer, [{ who: colleague, role: "EDITOR" }]);
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
  await browser?.close();
  if (child && !child.killed) child.kill();
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
