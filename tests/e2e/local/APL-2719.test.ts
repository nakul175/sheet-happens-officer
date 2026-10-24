// APL-2719 Playwright spec. Undo on Activity and the Trash countdown run from the same delete instant.
// No qa:TC id is assigned on the issue, so every title carries qa:TC missing.
// Local or CI server only. Signs in with the throwaway session cookie. ZZ-TEST names and a nakul17+ alias;
// afterAll cleans up through the API (cleanupZz): the project is archived and the person deactivated.
// The spec never touches the database. Ages (day 29, exactly 30x24h, day 31) need 'now' moved, which a live
// server cannot do until APL-2757's non-production clock hook exists, so tests/apl-2719.test.ts and
// tests/apl-2719-concierge.test.ts cover them in-process with 'now' injected.
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { account, BASE, cleanupZz, task, zzProject, type Account } from "../../helpers";

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
  return { id, title };
}

/** The Activity row for this delete: the sentence's text, then up to the row that also holds its Undo control. */
const activityRow = (page: Page, title: string) => page.getByText(`moved "${title}" to Trash`).locator("xpath=../..");

async function trashDays(page: Page, title: string) {
  await page.goto(`/projects/${projectId}/trash`);
  const row = page.getByRole("row").filter({ hasText: title });
  await row.waitFor();
  return (await row.getByRole("cell").filter({ hasText: /^\d+ days? left$/ }).innerText()).trim();
}

describe("qa:TC missing APL-2719 Undo and purge share one timestamp", () => {
  it("qa:TC missing AC1: Activity and Trash show the same delete instant, and Undo is offered with 30 days left", async () => {
    const t = await deletedTask();
    const activity = await lead.c.get(`/api/projects/${projectId}/activity`);
    expect(activity.status).toBe(200);
    // SHO-2701: the row is found by its kind; the sentence it reads as is still asserted below.
    const item = (activity.json.items as { what: string; kind: string; ts: number; undo: string }[]).find((i) => i.kind === "task.deleted")!;
    expect(item).toBeDefined();
    expect(item.what).toBe(`moved "${t.title}" to Trash`);
    const trash = await lead.c.get(`/api/projects/${projectId}/trash`);
    expect(trash.status).toBe(200);
    const inTrash = (trash.json.items as { id: string; deletedAt: string }[]).find((i) => i.id === t.id)!;
    expect(item.ts).toBe(new Date(inTrash.deletedAt).getTime());
    expect(item.undo).toBe("available");

    const { ctx, page } = await leadPage();
    try {
      await page.goto(`/projects/${projectId}/activity`);
      await activityRow(page, t.title).getByRole("button", { name: "Undo" }).waitFor();
      expect(await trashDays(page, t.title)).toBe("30 days left");
    } finally {
      await ctx.close();
    }
  }, 120000);
});
