// Real browser acceptance; all fixtures and database access stay on isolated local QA.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright-core";
import { db } from "@/lib/db";
import { account, BASE, cleanupZz, istDate, superAdmin, type Account } from "./helpers";

let browser: Browser, leader: Account, editor: Account, viewer: Account;
const projects: string[] = [], organisations: string[] = [];
const output = process.env.SHO_3052_ARTIFACT_DIR ?? "test-results/sho-3052";

beforeAll(async () => {
  const app = new URL(BASE), database = new URL(process.env.DATABASE_URL ?? "");
  if (![app, database].every(u => ["localhost", "127.0.0.1"].includes(u.hostname)) || !database.pathname.startsWith("/sho_test")) {
    throw new Error("SHO-3052 browser acceptance requires a local app and synthetic sho_test database.");
  }
  [leader, editor, viewer] = await Promise.all(["leader", "editor", "viewer"].map(role => account(`zz3052ui${role}`, undefined, `ZZ-TEST Buyer UI ${role}`)));
  browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
  mkdirSync(output, { recursive: true });
});

afterAll(async () => {
  await browser?.close();
  if (leader) {
    await cleanupZz(projects, [leader, editor, viewer]);
    const sa = await superAdmin();
    for (const id of organisations) expect((await sa.c.post(`/api/orgs/${id}/archive`, { archive: true })).status).toBe(200);
  }
  await db.$disconnect();
}, 120_000);

async function organisation(label: string) {
  const name = `ZZ-TEST Buyer UI ${label} ${Date.now()}`;
  const r = await leader.c.post("/api/orgs", { name });
  expect(r.status).toBe(201); organisations.push(r.json.organisation.id);
  return { id: r.json.organisation.id as string, name };
}

async function fixture(width: number) {
  const oldBuyer = await organisation(`old ${width}`), newBuyer = await organisation(`new ${width}`);
  const pipes = (await leader.c.get("/api/deals/pipelines")).json.pipelines as { id: string; key: string }[];
  const pipelineId = pipes.find(p => p.key === "DEAL_PROACTIVE")!.id;
  const name = `ZZ-TEST Buyer UI deal ${width} ${Date.now()}`;
  const ids: string[] = [];
  for (const buyer of [oldBuyer, newBuyer]) {
    const r = await leader.c.post("/api/deals", { name, organisationId: buyer.id, pipelineId, leaderId: leader.id, whyPursue: "Synthetic Buyer acceptance", force: true, nextStep: { title: "ZZ-TEST retain Buyer task", dueDate: istDate(3) } });
    expect(r.status).toBe(201); ids.push(r.json.deal.id); projects.push(r.json.deal.id);
  }
  for (const [who, role] of [[editor, "EDITOR"], [viewer, "VIEWER"]] as const) expect((await leader.c.post(`/api/projects/${ids[0]}/members`, { userId: who.id, role })).status).toBe(201);
  return { id: ids[0], other: ids[1], name, oldBuyer, newBuyer };
}

async function snapshot(id: string) {
  return JSON.parse(JSON.stringify(await db.project.findUniqueOrThrow({ where: { id }, include: { parties: { orderBy: { id: "asc" } }, actionLogs: { orderBy: { id: "asc" } } } })));
}

async function openAs(who: Account, width: number, id: string, name: string) {
  const context = await browser.newContext({ baseURL: BASE, viewport: { width, height: 900 } });
  const at = who.c.cookie.indexOf("=");
  await context.addCookies([{ name: who.c.cookie.slice(0, at), value: who.c.cookie.slice(at + 1), url: BASE }]);
  const page = await context.newPage();
  await page.goto(`/projects/${id}`);
  await page.getByRole("heading", { name, exact: true }).waitFor();
  return { context, page };
}

describe("SHO-3052 Buyer confirmation in the browser", () => {
  for (const width of [1280, 390]) {
    it(`${width}px cancels unchanged and requires fresh explicit confirmation after a duplicate warning`, async () => {
      const f = await fixture(width), before = await snapshot(f.id), other = await snapshot(f.other);
      const { context, page } = await openAs(leader, width, f.id, f.name);
      const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
      try {
        for (const cancel of [true, false]) {
          await page.getByRole("button", { name: "Change Buyer", exact: true }).click();
          const dialog = page.getByRole("dialog", { name: "Replace Buyer", exact: true });
          await dialog.getByLabel("New Buyer (active organisations only)").selectOption(f.newBuyer.id);
          const text = await dialog.innerText();
          expect(text).toContain("Current Buyer"); expect(text).toContain(f.oldBuyer.name);
          expect(text).toContain("Proposed Buyer"); expect(text).toContain(f.newBuyer.name);
          const save = dialog.getByRole("button", { name: "Replace Buyer", exact: true });
          expect(await save.isEnabled()).toBe(false);
          expect((await dialog.boundingBox())!.width).toBeLessThanOrEqual(width);
          if (cancel) {
            await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
            await dialog.waitFor({ state: "hidden" }); expect(await snapshot(f.id)).toEqual(before);
            continue;
          }
          await dialog.getByRole("checkbox").check(); await save.click();
          await dialog.getByRole("alert").waitFor();
          expect(await dialog.getByRole("checkbox").isChecked()).toBe(false);
          const anyway = dialog.getByRole("button", { name: "Replace anyway", exact: true });
          expect(await anyway.isEnabled()).toBe(false); expect(await snapshot(f.id)).toEqual(before);
          await page.screenshot({ path: path.join(output, `duplicate-${width}.png`) });
          await dialog.getByRole("checkbox").check(); await anyway.click();
          await dialog.waitFor({ state: "hidden" });
        }
        await page.getByRole("link", { name: f.newBuyer.name, exact: true }).first().waitFor();
        const after = await snapshot(f.id);
        expect(after.parties.filter((p: { role: string }) => p.role === "BUYER")).toEqual([expect.objectContaining({ organisationId: f.newBuyer.id })]);
        expect(await snapshot(f.other)).toEqual(other);
        await page.screenshot({ path: path.join(output, `replaced-${width}.png`), fullPage: true });
        expect(errors).toEqual([]);
      } finally { await context.close(); }
      for (const who of [editor, viewer]) {
        const { context, page } = await openAs(who, width, f.id, f.name);
        try { expect(await page.getByRole("button", { name: "Change Buyer", exact: true }).count()).toBe(0); }
        finally { await context.close(); }
      }
    }, 90_000);
  }
  it("never lists or accepts a Buyer from another workspace, even with force", async () => {
    const f = await fixture(390), before = await snapshot(f.id);
    const workspace = await db.workspace.create({ data: { name: "ZZ-TEST isolated foreign Buyer workspace" } });
    let foreignId: string | undefined;
    try {
      const foreign = await db.organisation.create({ data: { workspaceId: workspace.id, createdById: leader.id, name: `ZZ-TEST foreign Buyer ${Date.now()}` } });
      foreignId = foreign.id;
      const { context, page } = await openAs(leader, 390, f.id, f.name);
      try {
        await page.getByRole("button", { name: "Change Buyer", exact: true }).click();
        const select = page.getByLabel("New Buyer (active organisations only)");
        await select.locator(`option[value="${f.newBuyer.id}"]`).waitFor({ state: "attached" });
        expect(await select.locator(`option[value="${foreign.id}"]`).count()).toBe(0);
        const current = before.parties.find((p: { role: string }) => p.role === "BUYER");
        for (const force of [false, true]) {
          const result = await leader.c.patch(`/api/projects/${f.id}/parties/buyer`, { organisationId: foreign.id, expectedPartyId: current.id, expectedOrganisationId: f.oldBuyer.id, force });
          expect(result.status).toBe(400);
          expect(await snapshot(f.id)).toEqual(before);
        }
      } finally { await context.close(); }
    } finally {
      // Remove only these two test-owned rows; never alter schema or another workspace.
      if (foreignId) await db.organisation.delete({ where: { id: foreignId } });
      await db.workspace.delete({ where: { id: workspace.id } });
    }
  }, 90_000);
});
