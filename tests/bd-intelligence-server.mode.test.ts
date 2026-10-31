// SHO-3138 real persistence/privacy/browser acceptance. Run only after the
// exact migration is approved and applied to an isolated test database.
import pg from "pg";
import AxeBuilder from "@axe-core/playwright";
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, expect as browserExpect } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type Person = { id: string; email: string; cookie: string };
type Server = { base: string; child: ChildProcess; mode: "all" | "admins" | "off" };
const tag = `ZZ-TEST-3138-${Date.now()}-${process.pid}`;
const rootEmail = `nakul17+${tag.toLowerCase()}-root@aplyd.com`;
const password = "synthetic-bd-3138";
const logs = mkdtempSync(path.join(tmpdir(), "sho-3138-"));
const servers: Server[] = [];
const projects: string[] = [];
const people: Person[] = [];
let root: Person, leader: Person, editor: Person, viewer: Person, outsider: Person, admin: Person;
let organisationId: string, pipelineId: string;
let pipelineStages: { id: string; name: string }[] = [];
const customStages: string[] = [];
const fixtures: Record<string, string> = {};
const due = () => new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
const values = { partner: `${tag} confidential partner`, athenaRole: "SUB", budgetUsd: 12345.67, pwinAdjustedNfrUsd: 0 };

async function port() {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); if (!address || typeof address === "string") throw Error("No loopback port");
  await new Promise<void>((resolve) => server.close(() => resolve())); return address.port;
}
async function start(mode: Server["mode"]) {
  const base = `http://127.0.0.1:${await port()}`;
  const fd = openSync(path.join(logs, `${mode}.log`), "a", 0o600);
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", new URL(base).port], {
    detached: true, stdio: ["ignore", fd, fd], env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "production",
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
  return { name: `${tag} ${label}`, organisationId, pipelineId, leaderId: leader.id, whyPursue: "Synthetic fit", nextStep: { title: `${tag} follow up`, dueDate: due() }, submissionDeadline: "2088-02-01", ...fields };
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
  await start("all"); root = await account("root", rootEmail); leader = await account("leader"); editor = await account("editor");
  viewer = await account("viewer"); outsider = await account("outsider"); admin = await account("admin");
  await call(all(), root, "PATCH", `/api/team/${admin.id}`, { orgRole: "ADMIN" });
  organisationId = (await call(all(), root, "POST", "/api/orgs", { name: `${tag} Buyer`, country: "Kenya" }, 201)).json.organisation.id;
  const pipeline = (await call(all(), root, "GET", "/api/deals/pipelines")).json.pipelines.find((p: { key: string }) => p.key === "DEAL_BID");
  pipelineId = pipeline.id; pipelineStages = pipeline.stages;
  // Synthetic stage DATA in the guarded test DB; no schema/config migration or product stage API is claimed.
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  try { for (const name of ["HPP", "Shortlisted"]) { const id = `${tag}-${name}`; await c.query(`INSERT INTO "Stage" (id,"pipelineId",name,position,category,"needsReason","requiredFields","isRetired") VALUES ($1,$2,$3,$4,'ACTIVE',false,'{}',false)`, [id, pipelineId, name, 100 + customStages.length]); customStages.push(id); } } finally { await c.end(); }
  const rows = [
    ["WIP", pipelineStages[0].id, 1000, 50, 400, 175, "RFP_RFA", "2088-03-01"],
    ["Submission", pipelineStages.find(s => s.name === "Submitted")!.id, 2000, 25, 800, 201, "RFP_RFA", "2088-04-01"],
    ["EOI", pipelineStages.find(s => s.name === "Submitted")!.id, null, null, null, null, "EOI", "2088-05-01"],
    ["HPP", customStages[0], 3000, 80, 1200, 900, "RFP_RFA", "2088-06-01"],
    ["Shortlisted", customStages[1], 500, 100, 200, 175, "OTC", "2088-07-01"],
    ["Won", pipelineStages.find(s => s.name === "Won")!.id, 250, 100, 100, 90, "OTC", "2088-08-01"],
    ["Lost", pipelineStages.find(s => s.name === "Lost")!.id, 750, 25, 300, 70, "RFP_RFA", "2088-09-01"],
    ["Outside", pipelineStages[0].id, 9000, 100, 8000, 7000, "RFP_RFA", "2089-01-01"],
  ] as const;
  for (const [label, stageId, budgetUsd, probability, netFeeRevenueUsd, pwinAdjustedNfrUsd, opportunityType, expectedClose] of rows) {
    const id = await fixture(label, { ...values, athenaRole: "PRIME", budgetUsd, probability, netFeeRevenueUsd, pwinAdjustedNfrUsd, opportunityType, expectedClose }); fixtures[label] = id;
    if (label === "Lost") {
      const refused = await call(all(), root, "POST", `/api/projects/${id}/stage`, { stageId, reason: "Synthetic acceptance outcome" }, 409);
      expect(refused.json.tasks).toHaveLength(1);
      for (const task of refused.json.tasks) { const current = (await call(all(), root, "GET", `/api/tasks/${task.id}`)).json.task; await call(all(), root, "POST", `/api/tasks/${task.id}/complete`, { expectedUpdatedAt: current.updatedAt }); }
    }
    if (stageId !== pipelineStages[0].id) await call(all(), root, "POST", `/api/projects/${id}/stage`, { stageId, reason: "Synthetic acceptance outcome" });
  }
  await start("admins"); await start("off");
}, 120000);

afterAll(async () => {
  try {
    if (root) {
      for (const id of projects) {
        const project = (await call(all(), root, "GET", `/api/projects/${id}`)).json.project;
        const owner = project.members.find((m: { role: string }) => m.role === "LEADER");
        if (owner.userId !== root.id) await call(all(), root, "POST", `/api/projects/${id}/leader`, { newLeaderId: root.id, previousRole: "EDITOR" });
        if (customStages.includes(project.deal?.stage?.id)) await call(all(), root, "POST", `/api/projects/${id}/stage`, { stageId: pipelineStages[0].id, expectedStageId: project.deal.stage.id });
        if (!project.archived) await call(all(), root, "POST", `/api/projects/${id}/archive`);
      }
      if (customStages.length) { const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect(); try { await c.query('DELETE FROM "Stage" WHERE id = ANY($1::text[])', [customStages]); } finally { await c.end(); } }
      if (organisationId) await call(all(), root, "POST", `/api/orgs/${organisationId}/archive`, { archive: true });
      for (const person of people) if (person.id !== root.id) await call(all(), root, "POST", `/api/team/${person.id}/deactivate`, { reassign: "leaders" });
      await call(all(), root, "POST", "/api/profile/sessions/sign-out-others"); await call(all(), root, "POST", "/api/auth/signout", undefined, 204);
    }
  } finally {
    for (const { child } of servers) {
      if (child.exitCode !== null) continue;
      try { process.kill(-child.pid!, "SIGTERM"); } catch { /* exited */ }
      await new Promise<void>((resolve) => { const t = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* exited */ } }, 5000); child.once("exit", () => { clearTimeout(t); resolve(); }); });
    }
  }
}, 120000);

async function signedPage(server: Server, person: Person, width = 1280) {
  const browser = await chromium.launch({ headless: true, ...(process.env.SHO_BROWSER_EXECUTABLE ? { executablePath: process.env.SHO_BROWSER_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width, height: 1000 } });
  const origin = new URL(server.base);
  await context.addCookies([{ name: "sho_session", value: person.cookie.slice("sho_session=".length), domain: origin.hostname, path: "/", httpOnly: true, sameSite: "Lax" }]);
  return { browser, page: await context.newPage() };
}
async function period(page: import("@playwright/test").Page) {
  await page.getByLabel("Period basis", { exact: true }).selectOption("expectedClose");
  await page.getByLabel("From", { exact: true }).fill("2088-01-01");
  await page.getByLabel("To", { exact: true }).fill("2088-12-31");
  await page.getByLabel("Undated deals", { exact: true }).selectOption("exclude");
}
describe("SHO-3138 live-deal BD dashboard", () => {
  it("keeps signed-out users behind sign-in and the existing API auth gate", async () => {
    await call(all(), undefined, "GET", "/api/deals?lifecycle=all", undefined, 401);
    const browser = await chromium.launch({ headless: true, ...(process.env.SHO_BROWSER_EXECUTABLE ? { executablePath: process.env.SHO_BROWSER_EXECUTABLE } : {}) });
    try { const page = await browser.newPage(); await page.goto(all().base + "/bd-intelligence"); await page.waitForURL(/\/signin(?:[?#]|$)/); expect(new URL(page.url()).pathname).toBe("/signin"); } finally { await browser.close(); }
  });

  it("preserves existing API/CRM roles including country and confidential deal fields", async () => {
    for (const server of servers) for (const person of [root, admin, leader, editor, viewer, outsider]) {
      const elevated = person.id === root.id || person.id === admin.id;
      const crmHidden = server.mode === "off" || (server.mode === "admins" && !elevated);
      const r = await call(server, person, "GET", "/api/deals?lifecycle=all", undefined, crmHidden ? 404 : 200);
      if (crmHidden || person.id === outsider.id) expect(r.text).not.toContain(values.partner);
      else expect(r.json.deals.find((d: { id: string }) => d.id === fixtures.HPP)).toMatchObject({ partner: values.partner, budgetUsd: 3000, organisation: { country: "Kenya" } });
    }
    const denied = await signedPage(servers.find(s => s.mode === "admins")!, leader);
    try { await denied.page.goto(servers.find(s => s.mode === "admins")!.base + "/bd-intelligence"); await browserExpect(denied.page.getByText("This page is not available.", { exact: true })).toBeVisible(); expect(await denied.page.locator("body").textContent()).not.toContain(values.partner); } finally { await denied.browser.close(); }
  });

  for (const width of [1280, 390]) it(`${width}px mock panels, selected-period maths, live edits, keyboard and axe`, async () => {
    const { browser, page } = await signedPage(all(), root, width);
    try {
      const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
      await page.goto(all().base + "/bd-intelligence"); await page.getByRole("tab", { name: "Summary", exact: true }).waitFor();
      await period(page);
      for (const [name, count] of [["WIP", 1], ["Submissions", 1], ["EOI/CV", 1], ["Under Eval", 4], ["HPP", 1], ["Shortlisted", 1], ["Wins", 1], ["Losses", 1]]) {
        await browserExpect(page.getByRole("region", { name: `${name} count`, exact: true }).getByText(String(count), { exact: true })).toBeVisible();
      }
      const hpp = page.getByRole("region", { name: "HPP Pipeline", exact: true });
      await browserExpect(hpp).toContainText("USD 3,000.00"); await browserExpect(hpp).toContainText("USD 2,400.00"); await browserExpect(hpp).toContainText("USD 900.00");
      const evaluation = page.getByRole("region", { name: "Under Evaluation", exact: true });
      for (const amount of ["USD 5,500.00", "USD 3,400.00", "USD 2,200.00", "USD 1,276.00", "3 of 4 amounts known"]) await browserExpect(evaluation).toContainText(amount);
      const axe = await new AxeBuilder({ page }).analyze(); expect(axe.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (process.env.SHO_EVIDENCE_DIR) await page.screenshot({ path: path.join(process.env.SHO_EVIDENCE_DIR, `bd-summary-${width}.png`), fullPage: true });
      await page.getByRole("tab", { name: "Summary", exact: true }).focus(); await page.keyboard.press("ArrowRight");
      await browserExpect(page.getByRole("tab", { name: "WIP (1)", exact: true })).toBeFocused();
      await browserExpect(page.getByRole("table", { name: "WIP", exact: true })).toContainText(`${tag} WIP`);
      await page.getByRole("tab", { name: "HPP (1)", exact: true }).click();
      const table = page.getByRole("table", { name: "HPP", exact: true });
      for (const text of [values.partner, "Prime", "Kenya", "80%", "USD 900.00"]) await browserExpect(table).toContainText(text);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      if (process.env.SHO_EVIDENCE_DIR) await page.screenshot({ path: path.join(process.env.SHO_EVIDENCE_DIR, `bd-hpp-${width}.png`), fullPage: false });
      // Real API edit is reflected after the product Refresh data action; no mocked live data.
      await call(all(), editor, "PATCH", `/api/projects/${fixtures.HPP}/deal`, { budgetUsd: width === 1280 ? 3500 : 3000 });
      await page.getByRole("button", { name: "Refresh data", exact: true }).click();
      await browserExpect(table).toContainText(width === 1280 ? "USD 3,500.00" : "USD 3,000.00");
      await call(all(), editor, "PATCH", `/api/projects/${fixtures.HPP}/deal`, { budgetUsd: 3000 });
      await page.reload(); await period(page); await page.getByRole("tab", { name: "HPP (1)", exact: true }).click();
      await browserExpect(page.getByRole("table", { name: "HPP", exact: true })).toContainText("USD 3,000.00");
      for (const name of ["Submissions (1)", "EOI/CV (1)", "Under Eval (4)", "Shortlisted (1)", "Wins (1)", "Losses (1)", "Pipeline snapshots", "KMS & CNPS", "Add/Update BD Entry"]) {
        await page.getByRole("tab", { name, exact: true }).click(); await browserExpect(page.getByRole("tabpanel")).toBeVisible();
        if (name === "KMS & CNPS" || name === "Add/Update BD Entry") expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      }
      await browserExpect(page.getByRole("link", { name: "Create BD deal", exact: true })).toHaveAttribute("href", "/deals/new");
      await page.getByRole("table", { name: "Update an existing deal", exact: true }).getByRole("link", { name: `${tag} HPP`, exact: true }).click();
      await page.getByRole("button", { name: "Edit details", exact: true }).click();
      await browserExpect(page.getByRole("dialog", { name: "Deal details" }).getByLabel("Budget (USD)", { exact: true })).toHaveValue("3000");
      expect(errors).toEqual([]);
    } finally { await browser.close(); }
  });

  it("does not present fabricated totals on empty, invalid-period or API-error views", async () => {
    const { browser, page } = await signedPage(all(), outsider, 390);
    try {
      await page.goto(all().base + "/bd-intelligence"); await page.getByRole("tab", { name: "WIP (0)", exact: true }).click();
      await browserExpect(page.getByText("No matching deals in this period.", { exact: true })).toBeVisible();
      await page.getByLabel("From", { exact: true }).fill("2090-01-01"); await page.getByLabel("To", { exact: true }).fill("2080-01-01");
      await browserExpect(page.getByRole("main").getByRole("alert")).toHaveText("From must be on or before To."); await browserExpect(page.getByRole("tabpanel")).toHaveCount(0);
      await page.getByRole("button", { name: "Clear period", exact: true }).click();
      await page.route("**/api/deals?lifecycle=all", route => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Synthetic API failure" }) }));
      await page.getByRole("button", { name: "Refresh data", exact: true }).click();
      await browserExpect(page.getByRole("main").getByRole("alert")).toContainText("Could not load BD data. No totals are shown."); await browserExpect(page.getByRole("tabpanel")).toHaveCount(0);
    } finally { await browser.close(); }
  });
});
