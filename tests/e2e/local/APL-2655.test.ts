// APL-2655 Playwright spec. Pam has not assigned TC ids. Titles keep the literal marker until then.
// Signs in with the throwaway session cookie and clicks Undo on Activity. Local or CI server and database only.
// Gated on SHO_QA_PASS like the other story specs (staging-e2e.yml): without it the suite is skipped.
// assertStoryTargetAllowed() gets BASE explicitly, so it never falls back to reading the process image.
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { assertStoryTargetAllowed } from "../base-url";
import { BASE, type Account } from "../../helpers";
import { cleanupZz, editorDeletedT1, snapshot } from "../../apl-2655-zz";

function chromePath() {
  const fromEnv = process.env.PW_CHROMIUM;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  for (const p of ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"]) {
    if (existsSync(p)) return p;
  }
  throw new Error("No Chrome/Chromium binary. Set PW_CHROMIUM.");
}

assertStoryTargetAllowed(process.env, BASE);

let browser: Browser;

const LOCAL = /^(localhost|127\.0\.0\.1)$/;

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

/** Later APL-2674 hides delete Undo from Editors. A stale/direct authenticated
 * request must still obey APL-2655's already-undone-before-permission contract. */
async function noEditorDeleteUndo(page: Page, title: string) {
  await page.getByText(`moved "${title}" to Trash`).waitFor();
  expect(await page.getByRole("button", { name: "Undo", exact: true }).count()).toBe(0);
}

describe.skipIf(!process.env.SHO_QA_PASS)("qa:TC missing APL-2655 editor Undo of a delete", () => {
  beforeAll(async () => {
    if (!LOCAL.test(new URL(BASE).hostname)) {
      throw new Error("Refusing to run: TASKBOARD_URL is not a local server.");
    }
    // The spec reads rows with Prisma, so the database must be local too. The URL itself is never printed.
    if (!LOCAL.test(new URL(process.env.DATABASE_URL ?? "postgresql://unset").hostname)) {
      throw new Error("Refusing to run: DATABASE_URL is not a local database.");
    }
    browser = await chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  });

  afterAll(async () => {
    await browser?.close();
    await cleanupZz();
  });

  it("qa:TC missing AC1 already undone wins: Editor UI hides Undo, direct request returns 409 This was already undone and nothing changes", async () => {
    const { lead, ed, projectId, t, title, row } = await editorDeletedT1();
    const { ctx, page } = await editorSession(ed);
    try {
      await page.goto(`/projects/${projectId}/activity`);
      await noEditorDeleteUndo(page, title);
      expect((await lead.c.post(`/api/actions/${row.id}/undo`)).status).toBe(200);
      const before = await snapshot(t, row.id);
      expect(before.deletedAt).toBeNull();
      expect(before.undoneById).toBe(lead.id);

      const res = await page.request.post(`/api/actions/${row.id}/undo`, { data: {} });
      expect(res.status()).toBe(409);
      expect((await res.json()).error).toBe("This was already undone.");
      expect(await snapshot(t, row.id)).toEqual(before);

      await page.goto(`/projects/${projectId}/trash`);
      // The heading renders before the list loads, so wait for the loaded state, not the heading.
      await page.getByText("Trash is empty.").waitFor();
      expect(await page.getByRole("cell", { name: title, exact: true }).count()).toBe(0);
      expect((await ed.c.get(`/api/tasks/${t}`)).status).toBe(200);
    } finally {
      await ctx.close();
    }
  }, 120000);

  it("qa:TC missing AC2 not-yet-undone delete: Editor UI hides Undo, direct request returns 403 and T1 stays in Trash", async () => {
    const { ed, projectId, t, title, row } = await editorDeletedT1();
    const before = await snapshot(t, row.id);
    expect(before.deletedAt).not.toBeNull();
    expect(before.undoneAt).toBeNull();
    const { ctx, page } = await editorSession(ed);
    try {
      await page.goto(`/projects/${projectId}/activity`);
      await noEditorDeleteUndo(page, title);
      const res = await page.request.post(`/api/actions/${row.id}/undo`, { data: {} });
      expect(res.status()).toBe(403);
      expect((await res.json()).error).toBe("Only the project Leader or an Admin can do this.");
      expect(await snapshot(t, row.id)).toEqual(before);

      await page.goto(`/projects/${projectId}/trash`);
      await page.getByRole("cell", { name: title, exact: true }).waitFor();
      expect(await page.getByRole("cell", { name: title, exact: true }).count()).toBe(1);
      expect((await ed.c.get(`/api/tasks/${t}`)).status).toBe(404);
    } finally {
      await ctx.close();
    }
  }, 120000);
  it("positive control: Leader sees delete Undo and restores through the actual Activity control", async () => {
    const { lead, projectId, t, title, row } = await editorDeletedT1();
    const { ctx, page } = await editorSession(lead);
    try {
      await page.goto(`/projects/${projectId}/activity`);
      await page.getByText(`moved "${title}" to Trash`).waitFor();
      const undo = page.getByRole("listitem").filter({ hasText: `moved "${title}" to Trash` }).getByRole("button", { name: "Undo", exact: true });
      await undo.waitFor({ state: "visible" });
      expect(await undo.count()).toBe(1);
      const pending = page.waitForResponse(r => r.url().includes(`/api/actions/${row.id}/undo`) && r.request().method() === "POST");
      await undo.click();
      expect((await pending).status()).toBe(200);
      const after = await snapshot(t, row.id);
      expect(after.deletedAt).toBeNull();
      expect(after.undoneById).toBe(lead.id);
      await page.goto(`/projects/${projectId}/trash`);
      await page.getByText("Trash is empty.").waitFor();
      expect((await lead.c.get(`/api/tasks/${t}`)).status).toBe(200);
    } finally { await ctx.close(); }
  }, 120000);

});
