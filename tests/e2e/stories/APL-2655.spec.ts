// APL-2655 Playwright spec. Pam has not assigned TC ids. Titles keep the literal marker until then.
// Signs in with the throwaway session cookie and clicks Undo on Activity. Local or CI server only.
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { PrismaClient } from "../../../src/generated/prisma/client";
import { account, BASE, project, task, type Account } from "../../helpers";

const db = new PrismaClient();

function chromePath() {
  const fromEnv = process.env.PW_CHROMIUM;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  for (const p of ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"]) {
    if (existsSync(p)) return p;
  }
  throw new Error("No Chrome/Chromium binary. Set PW_CHROMIUM.");
}

const deleteRow = (taskId: string, actorId: string) =>
  db.actionLog.findFirstOrThrow({ where: { action: "task.deleted", targetId: taskId, actorId }, orderBy: { createdAt: "desc" } });

async function editorDeletedT1() {
  const lead = await account("lead");
  const ed = await account("editor");
  const p = await project(lead, lead, [{ who: ed }]);
  const t = await task(lead, p.id, { title: "T1", assigneeId: ed.id });
  expect((await ed.c.del(`/api/tasks/${t}`)).status).toBeLessThan(300);
  const row = await deleteRow(t, ed.id);
  return { lead, ed, p, t, row };
}

async function snapshot(taskId: string, logId: string) {
  const [log, taskRow, undoCount] = await Promise.all([
    db.actionLog.findUniqueOrThrow({ where: { id: logId } }),
    db.task.findUniqueOrThrow({ where: { id: taskId } }),
    db.actionLog.count({ where: { action: "undo", targetId: taskId } }),
  ]);
  return {
    undoneAt: log.undoneAt?.toISOString() ?? null,
    undoneById: log.undoneById,
    deletedAt: taskRow.deletedAt?.toISOString() ?? null,
    updatedAt: taskRow.updatedAt.toISOString(),
    undoCount,
  };
}

let browser: Browser;

beforeAll(async () => {
  if (!/^(localhost|127\.0\.0\.1)$/.test(new URL(BASE).hostname)) {
    throw new Error(`Refusing to run against ${BASE}: this spec is local only.`);
  }
  browser = await chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox", "--disable-dev-shm-usage"] });
});

afterAll(async () => {
  await browser?.close();
});

async function editorSession(ed: Account) {
  const ctx = await browser.newContext({ baseURL: BASE });
  const eq = ed.c.cookie.indexOf("=");
  await ctx.addCookies([{
    name: ed.c.cookie.slice(0, eq),
    value: decodeURIComponent(ed.c.cookie.slice(eq + 1)),
    url: BASE,
    httpOnly: true,
    sameSite: "Lax",
  }]);
  const page = await ctx.newPage();
  return { ctx, page };
}

function deleteRowOn(page: Page) {
  return page.locator(".item.act").filter({ hasText: 'moved "T1" to Trash' });
}

describe("qa:TC missing APL-2655 editor Undo of a delete", () => {
  it("qa:TC missing AC1 already undone wins: Activity Undo returns 409 This was already undone and nothing changes", async () => {
    const { lead, ed, p, t, row } = await editorDeletedT1();
    const { ctx, page } = await editorSession(ed);
    try {
      await page.goto(`/projects/${p.id}/activity`);
      const item = deleteRowOn(page);
      await item.getByRole("button", { name: "Undo" }).waitFor();
      expect((await lead.c.post(`/api/actions/${row.id}/undo`)).status).toBe(200);
      const before = await snapshot(t, row.id);
      expect(before.deletedAt).toBeNull();
      expect(before.undoneById).toBe(lead.id);

      const pending = page.waitForResponse((r) => r.url().includes(`/api/actions/${row.id}/undo`) && r.request().method() === "POST");
      await item.getByRole("button", { name: "Undo" }).click();
      const res = await pending;
      expect(res.status()).toBe(409);
      expect((await res.json()).error).toBe("This was already undone.");
      await page.locator(".undo-toast").waitFor();
      expect(await page.locator(".undo-toast").innerText()).toContain("This was already undone.");
      expect(await snapshot(t, row.id)).toEqual(before);

      await page.goto(`/projects/${p.id}/trash`);
      await page.getByRole("heading", { name: "Trash" }).waitFor();
      expect(await page.getByRole("cell", { name: "T1" }).count()).toBe(0);
      expect((await ed.c.get(`/api/tasks/${t}`)).status).toBe(200);
    } finally {
      await ctx.close();
    }
  }, 120000);

  it("qa:TC missing AC2 not-yet-undone delete: Activity Undo returns 403 and T1 stays in Trash", async () => {
    const { ed, p, t, row } = await editorDeletedT1();
    const before = await snapshot(t, row.id);
    expect(before.deletedAt).not.toBeNull();
    expect(before.undoneAt).toBeNull();
    const { ctx, page } = await editorSession(ed);
    try {
      await page.goto(`/projects/${p.id}/activity`);
      const item = deleteRowOn(page);
      const pending = page.waitForResponse((r) => r.url().includes(`/api/actions/${row.id}/undo`) && r.request().method() === "POST");
      await item.getByRole("button", { name: "Undo" }).click();
      const res = await pending;
      expect(res.status()).toBe(403);
      expect((await res.json()).error).toBe("Only the project Leader or an Admin can do this.");
      await page.locator(".undo-toast").waitFor();
      expect(await page.locator(".undo-toast").innerText()).toContain("Only the project Leader or an Admin can do this.");
      expect(await snapshot(t, row.id)).toEqual(before);

      await page.goto(`/projects/${p.id}/trash`);
      await page.getByRole("heading", { name: "Trash" }).waitFor();
      expect(await page.getByRole("cell", { name: "T1" }).count()).toBe(1);
      expect((await ed.c.get(`/api/tasks/${t}`)).status).toBe(404);
    } finally {
      await ctx.close();
    }
  }, 120000);
});
