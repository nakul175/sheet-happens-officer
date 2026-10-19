// APL-2719 Playwright spec. Undo on Activity and the Trash countdown run from the same delete instant.
// No qa:TC id is assigned on the issue, so every title carries qa:TC missing.
// Local or CI server only. Signs in with the throwaway session cookie. ZZ-TEST names and a nakul17+ alias;
// afterAll cleans up through the API (cleanupZz): the project is archived and the person deactivated.
// Purge itself is covered by tests/apl-2719.test.ts: purgeTrash() takes no scope here, so this spec never runs it.
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { PrismaClient } from "../../../src/generated/prisma/client";
import { UNDO_DAYS } from "../../../src/lib/undoable";
import { account, BASE, cleanupZz, task, zzProject, type Account } from "../../helpers";

const db = new PrismaClient();
const WINDOW = UNDO_DAYS * 86_400_000;
const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}`;
let seq = 0;

let browser: Browser;
let lead: Account;
let projectId = "";

function chromePath() {
  const fromEnv = process.env.PW_CHROMIUM;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  for (const p of ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"]) {
    if (existsSync(p)) return p;
  }
  throw new Error("No Chrome/Chromium binary. Set PW_CHROMIUM.");
}

beforeAll(async () => {
  if (!/^(localhost|127\.0\.0\.1)$/.test(new URL(BASE).hostname)) {
    throw new Error(`Refusing to run against ${BASE}: this spec is local only.`);
  }
  browser = await chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  lead = await account(`ZZ-TEST lead ${RUN}`, `nakul17+zz-2719-${RUN}@aplyd.com`);
  projectId = await zzProject(lead, `APL-2719 ${RUN}`);
}, 180000);

afterAll(async () => {
  await browser?.close();
  if (lead) await cleanupZz(projectId ? [projectId] : [], [lead]);
  await db.$disconnect();
});

async function leadPage() {
  const ctx = await browser.newContext({ baseURL: BASE });
  const eq = lead.c.cookie.indexOf("=");
  await ctx.addCookies([{ name: lead.c.cookie.slice(0, eq), value: decodeURIComponent(lead.c.cookie.slice(eq + 1)), url: BASE, httpOnly: true, sameSite: "Lax" }]);
  return { ctx, page: await ctx.newPage() };
}

/** A ZZ-TEST task deleted through the API route, with its Trash row and its Activity row. */
async function deletedTask() {
  const title = `ZZ-TEST 2719 ${RUN}-${seq++}`;
  const id = await task(lead, projectId, { title });
  expect((await lead.c.del(`/api/tasks/${id}`)).status).toBeLessThan(300);
  const log = await db.actionLog.findFirstOrThrow({ where: { action: "task.deleted", targetId: id } });
  return { id, title, logId: log.id };
}

/** Moves deletedAt and the log row back by the same amount, so the delete happened `age` ms ago. */
async function age(t: { id: string; logId: string }, ms: number) {
  const row = await db.task.findUniqueOrThrow({ where: { id: t.id } });
  const log = await db.actionLog.findUniqueOrThrow({ where: { id: t.logId } });
  const shift = row.deletedAt!.getTime() - (Date.now() - ms);
  await db.task.update({ where: { id: t.id }, data: { deletedAt: new Date(row.deletedAt!.getTime() - shift) } });
  await db.actionLog.update({ where: { id: t.logId }, data: { createdAt: new Date(log.createdAt.getTime() - shift) } });
}

/** The Activity row for this delete: the sentence's text, then up to the row that also holds its Undo control. */
const activityRow = (page: Page, title: string) => page.getByText(`moved "${title}" to Trash`).locator("xpath=../..");

async function trashDays(page: Page, title: string) {
  await page.goto(`/projects/${projectId}/trash`);
  const row = page.getByRole("row").filter({ hasText: title });
  await row.waitFor();
  return (await row.getByRole("cell").filter({ hasText: /^\d+ days?$/ }).innerText()).trim();
}

describe("qa:TC missing APL-2719 Undo and purge share one timestamp", () => {
  it("qa:TC missing AC1: Activity and Trash show the same delete instant, and Undo is offered with 30 days left", async () => {
    const t = await deletedTask();
    const activity = await lead.c.get(`/api/projects/${projectId}/activity`);
    expect(activity.status).toBe(200);
    const item = (activity.json.items as { id: string; ts: number; undo: string }[]).find((i) => i.id === t.logId)!;
    const trash = await lead.c.get(`/api/projects/${projectId}/trash`);
    expect(trash.status).toBe(200);
    const inTrash = (trash.json.items as { id: string; deletedAt: string }[]).find((i) => i.id === t.id)!;
    expect(item.ts).toBe(new Date(inTrash.deletedAt).getTime());
    expect(item.undo).toBe("available");

    const { ctx, page } = await leadPage();
    try {
      await page.goto(`/projects/${projectId}/activity`);
      await activityRow(page, t.title).getByRole("button", { name: "Undo" }).waitFor();
      expect(await trashDays(page, t.title)).toBe("30 days");
    } finally {
      await ctx.close();
    }
  }, 120000);

  it("qa:TC missing AC2: one minute before 30 days Undo is still offered and the task is still in Trash", async () => {
    const t = await deletedTask();
    await age(t, WINDOW - 60_000);
    const { ctx, page } = await leadPage();
    try {
      await page.goto(`/projects/${projectId}/activity`);
      await activityRow(page, t.title).getByRole("button", { name: "Undo" }).waitFor();
      expect(await trashDays(page, t.title)).toBe("1 day");
    } finally {
      await ctx.close();
    }
  }, 120000);

  it("qa:TC missing AC2: just past 30 days Undo is withdrawn on Activity and refused by the API at the same moment the task is purgeable", async () => {
    const t = await deletedTask();
    await age(t, WINDOW + 2);
    const row = await db.task.findUniqueOrThrow({ where: { id: t.id } });
    const log = await db.actionLog.findUniqueOrThrow({ where: { id: t.logId } });
    expect(log.createdAt.getTime()).toBe(row.deletedAt!.getTime());
    const { ctx, page } = await leadPage();
    try {
      await page.goto(`/projects/${projectId}/activity`);
      const r = activityRow(page, t.title);
      await r.getByText("Too old to undo").waitFor();
      expect(await r.getByRole("button", { name: "Undo" }).count()).toBe(0);
      expect(await trashDays(page, t.title)).toBe("0 days");
    } finally {
      await ctx.close();
    }
    const undo = await lead.c.post(`/api/actions/${t.logId}/undo`);
    expect(undo.status).toBeGreaterThanOrEqual(400);
    expect(undo.json.error).toBe("Too old to undo");
  }, 120000);

  // Exactly 30x24h needs a frozen clock, so tests/apl-2719.test.ts covers day 30; this spec covers days 29 and 31.
  it("qa:TC missing AC2: on day 29 Undo is offered on Activity and the task shows 1 day left in Trash", async () => {
    const t = await deletedTask();
    await age(t, 29 * 86_400_000);
    const { ctx, page } = await leadPage();
    try {
      await page.goto(`/projects/${projectId}/activity`);
      await activityRow(page, t.title).getByRole("button", { name: "Undo" }).waitFor();
      expect(await trashDays(page, t.title)).toBe("1 day");
    } finally {
      await ctx.close();
    }
  }, 120000);

  it("qa:TC missing AC2: on day 31 Activity shows Too old to undo, the API refuses it, and Trash shows 0 days", async () => {
    const t = await deletedTask();
    await age(t, 31 * 86_400_000);
    const { ctx, page } = await leadPage();
    try {
      await page.goto(`/projects/${projectId}/activity`);
      const r = activityRow(page, t.title);
      await r.getByText("Too old to undo").waitFor();
      expect(await r.getByRole("button", { name: "Undo" }).count()).toBe(0);
      expect(await trashDays(page, t.title)).toBe("0 days");
    } finally {
      await ctx.close();
    }
    const undo = await lead.c.post(`/api/actions/${t.logId}/undo`);
    expect(undo.status).toBeGreaterThanOrEqual(400);
    expect(undo.json.error).toBe("Too old to undo");
  }, 120000);
});
