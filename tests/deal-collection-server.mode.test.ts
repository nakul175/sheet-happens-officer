// SHO-2642 real persistence/privacy/browser acceptance. Run only after the
// exact migration is approved and applied to an isolated test database.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, writeFileSync, mkdtempSync, openSync, readdirSync, readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { execFileSync } from "node:child_process";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, expect as browserExpect } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type Person = { id: string; email: string; cookie: string };
type Server = { base: string; child: ChildProcess; mode: "all" | "admins" | "off" };
const tag = `ZZ-TEST-2642-${Date.now()}-${process.pid}`;
const rootEmail = `nakul17+${tag.toLowerCase()}-root@aplyd.com`;
const password = "synthetic-bd-2642";
const logs = mkdtempSync(path.join(tmpdir(), "sho-2642-"));
const servers: Server[] = [];
const projects: string[] = [];
const people: Person[] = [];
let root: Person, leader: Person, editor: Person, viewer: Person, outsider: Person, admin: Person;
let organisationId: string, pipelineId: string, pipelineName: string;
let mainId: string, needsId: string, baseline: Server | undefined;
let stages: { id: string; name: string; category: string; needsReason: boolean }[];
const visualProof: { width: number; view: string; pixelsEqual: boolean }[] = [];
const due = () => new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
const values = { partner: `${tag} confidential partner`, athenaRole: "SUB", budgetUsd: 12345.67, pwinAdjustedNfrUsd: 0 };

async function port() {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); if (!address || typeof address === "string") throw Error("No loopback port");
  await new Promise<void>((resolve) => server.close(() => resolve())); return address.port;
}
async function start(mode: Server["mode"], cwd = process.cwd()) {
  const base = `http://127.0.0.1:${await port()}`;
  const fd = openSync(path.join(logs, `${mode}-${servers.length}.log`), "a", 0o600);
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", new URL(base).port], {
    cwd, detached: true, stdio: ["ignore", fd, fd], env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "production",
      DATABASE_URL: process.env.DATABASE_URL, DIRECT_DATABASE_URL: process.env.DATABASE_URL, APP_URL: base,
      CRM_VISIBLE: mode, SUPER_ADMIN_EMAILS: rootEmail, EMAIL_OUTBOX_DIR: logs, SEARCH_STAGE_A_ENABLED: "false", APLYD_ACCOUNTS_SSO: "false" },
  }); closeSync(fd);
  const server = { base, child, mode }; servers.push(server);
  for (let n = 0; n < 100; n++) {
    if (child.exitCode !== null) throw Error(`${mode} exited; diagnostic ${logs}`);
    try { if ((await fetch(base + "/api/health", { signal: AbortSignal.timeout(2000) })).ok) return server; } catch { /* bounded startup */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw Error(`${mode} health failed; diagnostic ${logs}`);
}
async function call(server: Server, who: Person | undefined, method: string, route: string, body?: unknown, status = 200) {
  const response = await fetch(server.base + route, { method, headers: { "content-type": "application/json", ...(who ? { cookie: who.cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
  const text = await response.text(); const json = text ? JSON.parse(text) : null;
  // Retain cleanup ownership even if an invalid-create regression unexpectedly saves.
  if (method === "POST" && route === "/api/deals" && response.status === 201 && status !== 201 && json?.deal?.id) projects.push(json.deal.id);
  expect(response.status, `${server.mode} ${method} ${route}: ${text}`).toBe(status);
  return { response, text, json };
}
const all = () => servers.find((s) => s.mode === "all")!;
async function account(label: string, email = `nakul17+${tag.toLowerCase()}-${label}@aplyd.com`) {
  await call(all(), undefined, "POST", "/api/auth/signup", { name: `${tag} ${label}`, email, password }, 201);
  const mail = readdirSync(logs).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(path.join(logs, f), "utf8"))).find((m) => m.to === email && /Verify/.test(m.subject));
  const token = mail?.text.match(/token=([\w-]+)/)?.[1]; expect(token).toBeTruthy();
  await call(all(), undefined, "POST", "/api/auth/verify", { token });
  const signed = await call(all(), undefined, "POST", "/api/auth/signin", { email, password });
  expect(signed.json.user.orgRole).toBe(label === "root" ? "SUPER_ADMIN" : "MEMBER");
  const cookie = signed.response.headers.getSetCookie().map((s) => s.split(";")[0]).find((s) => s.startsWith("sho_session="))!;
  expect(cookie).toBeTruthy(); const person = { id: signed.json.user.id, email, cookie }; people.push(person); return person;
}
function payload(label: string, fields: Record<string, unknown> = values) {
  return { name: `${tag} ${label}`, organisationId, pipelineId, leaderId: leader.id, whyPursue: "Synthetic fit", nextStep: { title: `${tag} follow up`, dueDate: due() }, ...fields };
}
async function fixture(label: string, fields: Record<string, unknown> = values) {
  const made = await call(all(), root, "POST", "/api/deals", payload(label, fields), 201);
  const id = made.json.deal.id as string; projects.push(id);
  for (const [person, role] of [[editor, "EDITOR"], [viewer, "VIEWER"]] as const) await call(all(), root, "POST", `/api/projects/${id}/members`, { userId: person.id, role }, 201);
  return id;
}
beforeAll(async () => {
  const database = new URL(process.env.DATABASE_URL ?? "");
  expect(["127.0.0.1", "localhost", "[::1]"]).toContain(database.hostname);
  expect(database.pathname).toMatch(/^\/sho_test(?:_[\w-]+)?$/);
  expect(existsSync(".next/BUILD_ID")).toBe(true);
  for (const f of [".env", ".env.local", ".env.production", ".env.production.local"]) expect(existsSync(f)).toBe(false);
  await start("all"); root = await account("root", rootEmail); leader = await account("leader"); editor = await account("editor");
  viewer = await account("viewer"); outsider = await account("outsider"); admin = await account("admin");
  await call(all(), root, "PATCH", `/api/team/${admin.id}`, { orgRole: "ADMIN" });
  organisationId = (await call(all(), root, "POST", "/api/orgs", { name: `${tag} Buyer` }, 201)).json.organisation.id;
  const pipeline = (await call(all(), root, "GET", "/api/deals/pipelines")).json.pipelines.find((p: { key: string }) => p.key === "DEAL_PROACTIVE");
  pipelineId = pipeline.id; pipelineName = pipeline.name; stages = pipeline.stages;
  mainId = await fixture("collection", { ...values, opportunityType: "RFP_RFA", value: 100, currency: "USD" });
  needsId = await fixture("needs next step", { ...values, opportunityType: "RFP_RFA", leaderId: root.id });
  const step = (await call(all(), root, "GET", `/api/projects/${needsId}`)).json.project.deal.nextStep;
  const task = (await call(all(), root, "GET", `/api/tasks/${step.id}`)).json.task;
  await call(all(), root, "POST", `/api/tasks/${step.id}/complete`, { expectedUpdatedAt: task.updatedAt });
  await start("admins"); await start("off");
  if (process.env.SHO_BASELINE_CWD) {
    const cwd = path.resolve(process.env.SHO_BASELINE_CWD);
    for (const f of [".env", ".env.local", ".env.production", ".env.production.local"]) expect(existsSync(path.join(cwd, f))).toBe(false);
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()).toBe('a8f67c5b0f39cdd6fb6718fada64df7e92825903');
    expect(execFileSync('git', ['diff', 'HEAD', '--', 'src', 'prisma'], { cwd, encoding: 'utf8' }).trim()).toBe('');
    expect(process.env.SHO_EVIDENCE_DIR).toBeTruthy(); baseline = await start("all", cwd);
  }
}, 120000);

afterAll(async () => {
  try {
    if (root) {
      for (const id of projects) {
        const project = (await call(all(), root, "GET", `/api/projects/${id}`)).json.project;
        const owner = project.members.find((m: { role: string }) => m.role === "LEADER");
        if (owner.userId !== root.id) await call(all(), root, "POST", `/api/projects/${id}/leader`, { newLeaderId: root.id, previousRole: "EDITOR" });
        if (!project.archived) await call(all(), root, "POST", `/api/projects/${id}/archive`);
      }
      if (organisationId) await call(all(), root, "POST", `/api/orgs/${organisationId}/archive`, { archive: true });
      for (const person of people) if (person.id !== root.id) await call(all(), root, "POST", `/api/team/${person.id}/deactivate`, { reassign: "leaders" });
      await call(all(), root, "POST", "/api/profile/sessions/sign-out-others"); await call(all(), root, "POST", "/api/auth/signout", undefined, 204);
    }
  } finally {
    if (process.env.SHO_EVIDENCE_DIR && baseline) writeFileSync(path.join(process.env.SHO_EVIDENCE_DIR, "visual-comparison.json"), JSON.stringify({ baseline: "a8f67c5b0f39cdd6fb6718fada64df7e92825903", comparisons: visualProof }, null, 2));
    for (const { child } of servers) {
      if (child.exitCode !== null) continue;
      try { process.kill(-child.pid!, "SIGTERM"); } catch { /* exited */ }
      await new Promise<void>((resolve) => { const t = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* exited */ } }, 5000); child.once("exit", () => { clearTimeout(t); resolve(); }); });
    }
  }
}, 120000);

async function signedPage(server: Server, who: Person, width = 1280) {
  const browser = await chromium.launch({ headless: true, ...(process.env.SHO_BROWSER_EXECUTABLE ? { executablePath: process.env.SHO_BROWSER_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width, height: 1000 } });
  await context.addCookies([{ name: "sho_session", value: who.cookie.slice("sho_session=".length), domain: new URL(server.base).hostname, path: "/", httpOnly: true, sameSite: "Lax" }]);
  return { browser, page: await context.newPage() };
}
const mainName = () => `${tag} collection`;
const needsName = () => `${tag} needs next step`;
async function openView(page: import("@playwright/test").Page, server: Server, view: string) {
  if (view === "organisation") {
    await page.goto(`${server.base}/accounts/${organisationId}`);
    const region = page.getByRole("region", { name: "Open deals", exact: true });
    await region.getByRole("link", { name: mainName(), exact: true }).waitFor(); return region;
  }
  if (view === "needs-step") {
    await page.goto(server.base + "/my-tasks"); await page.getByRole("button", { name: "By date", exact: true }).click();
    const region = page.getByRole("region", { name: "Deals that need a next step", exact: true });
    await region.getByRole("link", { name: needsName(), exact: true }).waitFor(); return region;
  }
  await page.goto(server.base + "/deals"); await page.getByRole("tab", { name: pipelineName, exact: true }).click();
  await page.getByRole("button", { name: view === "list" ? "List" : "Board", exact: true }).click();
  const group = page.getByRole("region", { name: "RFP/RFA + OTC sales", exact: true });
  const region = group.getByRole("region", { name: server === baseline ? (view === "list" ? "Deals table" : "Deal board") : `RFP/RFA + OTC sales ${view === "list" ? "table" : "board"}`, exact: true });
  await region.getByRole("link", { name: mainName(), exact: true }).waitFor();
  const facts = view === "list" ? region.getByRole("row").filter({ has: page.getByRole("link", { name: mainName(), exact: true }) }) : region.getByRole("group", { name: `BD details for ${mainName()}`, exact: true });
  await facts.getByText("BD details", { exact: true }).click();
  await browserExpect(facts).toContainText("Budget: USD 12,345.67"); return region;
}

describe("SHO-2642 shared deal rendering", () => {
  it("retains API visibility, CRM all/admins/off and readonly role boundaries", async () => {
    for (const server of servers) for (const person of [root, admin, leader, editor, viewer, outsider]) {
      const elevated = person.id === root.id || person.id === admin.id;
      const hidden = server.mode === "off" || (server.mode === "admins" && !elevated);
      const d = await call(server, person, "GET", "/api/deals", undefined, hidden ? 404 : 200);
      const o = await call(server, person, "GET", `/api/orgs/${organisationId}`, undefined, hidden ? 404 : 200);
      if (hidden || person.id === outsider.id) { expect(d.text).not.toContain(mainId); expect(o.text).not.toContain(mainId); }
      else { expect(d.json.deals.some((x: { id: string }) => x.id === mainId)).toBe(true); expect(o.json.organisation.deals.some((x: { projectId: string }) => x.projectId === mainId)).toBe(true); }
    }
    await call(all(), viewer, "PATCH", `/api/projects/${mainId}/deal`, { partner: "Forbidden" }, 403);
  });

  for (const width of [1280, 390]) it(`${width}px all collection layouts, BD facts and axe (paired baseline when supplied)`, async () => {
    const current = await signedPage(all(), root, width);
    const previous = baseline ? await signedPage(baseline, root, width) : undefined;
    try {
      const errors: string[] = []; current.page.on("pageerror", e => errors.push(e.message));
      for (const view of ["list", "board", "organisation", "needs-step"]) {
        const region = await openView(current.page, all(), view);
        await current.page.evaluate(() => document.fonts.ready);
        const axe = await new AxeBuilder({ page: current.page }).analyze();
        if (process.env.SHO_EVIDENCE_DIR) writeFileSync(path.join(process.env.SHO_EVIDENCE_DIR, `${view}-${width}-axe.json`), JSON.stringify(axe.violations, null, 2));
        expect(axe.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) }))).toEqual([]);
        expect(await current.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        if (previous && baseline) {
          const oldRegion = await openView(previous.page, baseline, view); await previous.page.evaluate(() => document.fonts.ready);
          if (view === "list") writeFileSync(path.join(process.env.SHO_EVIDENCE_DIR!, `baseline-list-${width}-axe.json`), JSON.stringify((await new AxeBuilder({ page: previous.page }).analyze()).violations, null, 2));
          const target = path.join(process.env.SHO_EVIDENCE_DIR!, `${view}-${width}`);
          await oldRegion.screenshot({ path: `${target}-baseline.png` }); await region.screenshot({ path: `${target}-candidate.png` });
          const pixelsEqual = readFileSync(`${target}-baseline.png`).equals(readFileSync(`${target}-candidate.png`));
          visualProof.push({ width, view, pixelsEqual }); expect(pixelsEqual, `${view} at${width}px must preserve the approved visual layout`).toBe(true);
        }
      }
      await current.page.goto(all().base + "/"); await browserExpect(current.page.getByRole("heading", { name: "Your workspace", exact: true })).toBeVisible();
      expect(errors).toEqual([]);
    } finally { await current.browser.close(); await previous?.browser.close(); }
  });

  it("board movement and missing-next-step actions keep their callbacks and project identity", async () => {
    const { browser, page } = await signedPage(all(), root, 390);
    try {
      const board = await openView(page, all(), "board");
      const target = stages.find(s => s.id !== stages[0].id && s.category === "ACTIVE" && !s.needsReason)!;
      await board.getByRole("button", { name: `Move ${mainName()}`, exact: true }).click();
      await page.getByRole("menuitem", { name: target.name, exact: true }).click();
      await browserExpect(board.getByRole("region", { name: `RFP/RFA + OTC sales board · ${target.name}`, exact: true }).getByRole("link", { name: mainName(), exact: true })).toBeVisible();
      expect((await call(all(), root, "GET", `/api/projects/${mainId}`)).json.project.deal.stage.id).toBe(target.id);
      const region = await openView(page, all(), "needs-step"); await region.getByRole("button", { name: "+ Add task", exact: true }).click();
      await region.getByLabel("Next task", { exact: true }).fill(`${tag} real callback task`);
      const [created] = await Promise.all([page.waitForResponse(r => new URL(r.url()).pathname === `/api/projects/${needsId}/tasks` && r.request().method() === "POST"), region.getByRole("button", { name: "Add", exact: true }).click()]);
      expect(created.status()).toBe(201); const id = (await created.json()).task.id;
      const task = (await call(all(), root, "GET", `/api/tasks/${id}`)).json.task;
      expect(task.project.id).toBe(needsId); expect(task.assignee.id).toBe(root.id);
      await browserExpect(region.getByRole("link", { name: needsName(), exact: true })).toHaveCount(0);
    } finally { await browser.close(); }
  });

  it("archive, Trash exclusion and restore retain the existing data rules in shared lists", async () => {
    const id = await fixture("archive boundary", { ...values, leaderId: root.id, opportunityType: "RFP_RFA" });
    const name = `${tag} archive boundary`; let deleted = false;
    const { browser, page } = await signedPage(all(), root);
    try {
      await call(all(), root, "POST", `/api/projects/${id}/archive`);
      expect((await call(all(), root, "GET", "/api/deals")).json.deals.some((d: { id: string }) => d.id === id)).toBe(false);
      await page.goto(all().base + "/deals"); await page.getByRole("tab", { name: pipelineName, exact: true }).click();
      await page.getByRole("button", { name: "Show archived", exact: true }).click();
      await browserExpect(page.getByRole("link", { name, exact: true })).toBeVisible();
      await call(all(), root, "POST", `/api/projects/${id}/delete`, { confirmationName: name }); deleted = true;
      expect((await call(all(), root, "GET", "/api/deals?archived=true")).json.deals.some((d: { id: string }) => d.id === id)).toBe(false);
      expect((await call(all(), root, "GET", "/api/deals?deleted=true")).json.deals.some((d: { id: string }) => d.id === id)).toBe(true);
      await page.reload(); await page.getByText("Trash", { exact: true }).click();
      await browserExpect(page.getByRole("group", { name: "Deal Trash", exact: true }).getByText(name, { exact: true })).toBeVisible();
      await call(all(), root, "POST", `/api/projects/${id}/restore`); deleted = false;
      expect((await call(all(), root, "GET", `/api/projects/${id}`)).json.project.archived).toBe(true);
      await page.reload(); await page.getByRole("tab", { name: pipelineName, exact: true }).click(); await page.getByRole("button", { name: "Show archived", exact: true }).click();
      await browserExpect(page.getByRole("link", { name, exact: true })).toBeVisible();
    } finally { if (deleted) await call(all(), root, "POST", `/api/projects/${id}/restore`); await browser.close(); }
  });
});
