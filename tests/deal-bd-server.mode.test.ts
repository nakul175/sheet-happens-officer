// SHO-3139 real persistence/privacy/browser acceptance. Run only after the
// exact migration is approved and applied to an isolated test database.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, expect as browserExpect } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type Person = { id: string; email: string; cookie: string };
type Server = { base: string; child: ChildProcess; mode: "all" | "admins" | "off" };
const tag = `ZZ-TEST-3139-${Date.now()}-${process.pid}`;
const rootEmail = `nakul17+${tag.toLowerCase()}-root@aplyd.com`;
const password = "synthetic-bd-3139";
const logs = mkdtempSync(path.join(tmpdir(), "sho-3139-"));
const servers: Server[] = [];
const projects: string[] = [];
const people: Person[] = [];
let root: Person, leader: Person, editor: Person, viewer: Person, outsider: Person, admin: Person;
let organisationId: string, pipelineId: string, pipelineName: string;
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
  return { name: `${tag} ${label}`, organisationId, pipelineId, leaderId: leader.id, whyPursue: "Synthetic fit", nextStep: { title: `${tag} follow up`, dueDate: due() }, ...fields };
}
async function fixture(label: string, fields: Record<string, unknown> = values) {
  const made = await call(all(), root, "POST", "/api/deals", payload(label, fields), 201);
  const id = made.json.deal.id as string; projects.push(id);
  for (const [person, role] of [[editor, "EDITOR"], [viewer, "VIEWER"]] as const) await call(all(), root, "POST", `/api/projects/${id}/members`, { userId: person.id, role }, 201);
  return id;
}
async function details(id: string) { return (await call(all(), root, "GET", `/api/projects/${id}`)).json.project.deal.details; }

beforeAll(async () => {
  const database = new URL(process.env.DATABASE_URL ?? "");
  expect(["127.0.0.1", "localhost", "[::1]"]).toContain(database.hostname);
  expect(database.pathname).toMatch(/^\/sho_test(?:_[\w-]+)?$/);
  expect(existsSync(".next/BUILD_ID")).toBe(true);
  await start("all"); root = await account("root", rootEmail); leader = await account("leader"); editor = await account("editor");
  viewer = await account("viewer"); outsider = await account("outsider"); admin = await account("admin");
  await call(all(), root, "PATCH", `/api/team/${admin.id}`, { orgRole: "ADMIN" });
  organisationId = (await call(all(), root, "POST", "/api/orgs", { name: `${tag} Buyer` }, 201)).json.organisation.id;
  const pipeline = (await call(all(), root, "GET", "/api/deals/pipelines")).json.pipelines.find((p: { key: string }) => p.key === "DEAL_PROACTIVE");
  pipelineId = pipeline.id; pipelineName = pipeline.name;
  await start("admins"); await start("off");
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
    for (const { child } of servers) {
      if (child.exitCode !== null) continue;
      try { process.kill(-child.pid!, "SIGTERM"); } catch { /* exited */ }
      await new Promise<void>((resolve) => { const t = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* exited */ } }, 5000); child.once("exit", () => { clearTimeout(t); resolve(); }); });
    }
  }
}, 120000);

describe("SHO-3139 real USD fact acceptance", () => {
  it("persists create/update/read, preserves omitted fields, and distinguishes null, zero and cents", async () => {
    const id = await fixture("round trip"); expect(await details(id)).toMatchObject(values);
    const listed = (await call(all(), leader, "GET", "/api/deals")).json.deals.find((d: { id: string }) => d.id === id);
    expect(listed).toMatchObject(values);
    await call(all(), editor, "PATCH", `/api/projects/${id}/deal`, { partner: "  Changed partner  ", budgetUsd: 0, athenaRole: "SOLO", pwinAdjustedNfrUsd: 123.45 });
    expect(await details(id)).toMatchObject({ partner: "Changed partner", budgetUsd: 0, athenaRole: "SOLO", pwinAdjustedNfrUsd: 123.45 });
    await call(all(), editor, "PATCH", `/api/projects/${id}/deal`, { need: "Unrelated edit" });
    expect((await details(id)).budgetUsd).toBe(0);
    await call(all(), leader, "PATCH", `/api/projects/${id}/deal`, { partner: " ", athenaRole: null, budgetUsd: null, pwinAdjustedNfrUsd: null });
    expect(await details(id)).toMatchObject({ partner: null, athenaRole: null, budgetUsd: null, pwinAdjustedNfrUsd: null });
    const legacy = await fixture("omitted fields", {}); expect(await details(legacy)).toMatchObject({ partner: null, athenaRole: null, budgetUsd: null, pwinAdjustedNfrUsd: null });
  });

  it("rejects invalid values without changing existing facts or creating a deal", async () => {
    const id = await fixture("invalid"); const before = await details(id);
    const invalid = [{ athenaRole: "OTHER" }, { partner: "x".repeat(201) }, ...["budgetUsd", "pwinAdjustedNfrUsd"].flatMap((key) => ["100", { amount: 100, currency: "EUR" }, -1, 1.001, 10000000000000].map((value) => ({ [key]: value })))];
    for (const fields of invalid) {
      await call(all(), root, "PATCH", `/api/projects/${id}/deal`, fields, 400); expect(await details(id)).toEqual(before);
      await call(all(), root, "POST", "/api/deals", payload("invalid must not exist", fields), 400);
    }
    expect((await call(all(), root, "GET", "/api/deals")).json.deals.some((d: { name: string }) => d.name === `${tag} invalid must not exist`)).toBe(false);
  });

  it("Undo restores facts and detects a later editor's change rather than losing it", async () => {
    const id = await fixture("undo");
    const edited = await call(all(), root, "PATCH", `/api/projects/${id}/deal`, { ...values, partner: "First edit", budgetUsd: 500 });
    const action = edited.response.headers.get("x-undo-id"); expect(action).toBeTruthy();
    await call(all(), root, "POST", `/api/actions/${action}/undo`, {}); expect(await details(id)).toMatchObject(values);
    const again = await call(all(), root, "PATCH", `/api/projects/${id}/deal`, { partner: "Earlier edit" });
    await call(all(), editor, "PATCH", `/api/projects/${id}/deal`, { partner: "Later editor" });
    await call(all(), root, "POST", `/api/actions/${again.response.headers.get("x-undo-id")}/undo`, {}, 409);
    expect((await details(id)).partner).toBe("Later editor");
  });

  it("preserves Member/Viewer/outsider and CRM all/admins/off access boundaries", async () => {
    const id = await fixture("privacy");
    for (const server of servers) for (const person of [root, admin, leader, editor, viewer, outsider]) {
      const elevated = person.id === root.id || person.id === admin.id;
      const hidden = server.mode === "off" || (server.mode === "admins" && !elevated) || (!elevated && person.id === outsider.id);
      const response = await call(server, person, "GET", `/api/projects/${id}`, undefined, hidden ? 404 : 200);
      if (hidden) expect(response.text).not.toContain(values.partner);
      else expect(response.json.project.deal.details).toMatchObject(values);
      const crmHidden = server.mode === "off" || (server.mode === "admins" && !elevated);
      const listed = await call(server, person, "GET", "/api/deals", undefined, crmHidden ? 404 : 200);
      if (hidden) expect(listed.text).not.toContain(values.partner);
      else expect(listed.json.deals.find((d: { id: string }) => d.id === id)).toMatchObject(values);
      if (hidden || person.id === viewer.id) await call(server, person, "PATCH", `/api/projects/${id}/deal`, { partner: "Not permitted" }, hidden ? 404 : 403);
    }
    expect(await details(id)).toMatchObject(values);
  });

  for (const width of [1280, 390]) it(`${width}px actual create/edit/reload and board/list/detail disclosures`, async () => {
    const browser = await chromium.launch({ headless: true, ...(process.env.SHO_BROWSER_EXECUTABLE ? { executablePath: process.env.SHO_BROWSER_EXECUTABLE } : {}) });
    try {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      expect((await context.request.post(all().base + "/api/auth/signin", { data: { email: root.email, password } })).status()).toBe(200);
      const page = await context.newPage(); const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`${all().base}/deals/new?org=${organisationId}`);
      await page.getByLabel("Deal name", { exact: true }).fill(`${tag} browser ${width}`);
      await page.getByLabel("Pipeline", { exact: true }).selectOption(pipelineId);
      await page.getByLabel("Why are we pursuing this?", { exact: true }).fill("Synthetic fit");
      await page.getByLabel("First next step", { exact: true }).fill(`${tag} next step`);
      await page.getByLabel("Partner", { exact: true }).fill(`Browser partner ${width}`);
      await page.getByLabel("Athena role", { exact: true }).selectOption("PRIME");
      await page.getByLabel("Budget (USD)", { exact: true }).fill("1234.56");
      await page.getByLabel("PWin-adjusted NFR (USD)", { exact: true }).fill("0");
      const [created] = await Promise.all([
        page.waitForResponse((r) => new URL(r.url()).pathname === "/api/deals" && r.request().method() === "POST"),
        page.getByRole("button", { name: "Create deal", exact: true }).click(),
      ]);
      expect(created.status()).toBe(201); const id = (await created.json()).deal.id as string; projects.push(id);
      await page.waitForURL(/\/projects\/[^/?]+$/);
      await page.getByRole("button", { name: "Edit details", exact: true }).click();
      await browserExpect(page.getByLabel("Budget (USD)", { exact: true })).toHaveValue("1234.56");
      await page.getByLabel("Athena role", { exact: true }).selectOption("SUB");
      await page.getByLabel("Budget (USD)", { exact: true }).fill("0");
      await page.getByLabel("PWin-adjusted NFR (USD)", { exact: true }).fill("250.25");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await browserExpect(page.getByRole("dialog", { name: "Deal details" })).toHaveCount(0); await page.reload();
      await page.getByText("BD details", { exact: true }).click();
      await browserExpect(page.getByText("Budget: USD 0.00", { exact: true })).toBeVisible();
      await browserExpect(page.getByText("PWin-adjusted NFR: USD 250.25", { exact: true })).toBeVisible();
      await page.goto(all().base + "/deals");
      await page.getByRole("tab", { name: pipelineName, exact: true }).click();
      await page.getByRole("link", { name: `${tag} browser ${width}`, exact: true }).waitFor();
      const boardFacts = page.getByRole("group", { name: `BD details for ${tag} browser ${width}`, exact: true });
      await boardFacts.getByText("BD details", { exact: true }).click();
      await browserExpect(boardFacts).toContainText("Budget: USD 0.00");
      await browserExpect(boardFacts).toContainText("PWin-adjusted NFR: USD 250.25");
      await page.getByRole("button", { name: "List", exact: true }).click();
      const row = page.getByRole("row").filter({ has: page.getByRole("link", { name: `${tag} browser ${width}`, exact: true }) });
      await row.getByText("BD details", { exact: true }).click(); await browserExpect(row).toContainText("USD 250.25");
      if (process.env.SHO_EVIDENCE_DIR) await page.screenshot({ path: path.join(process.env.SHO_EVIDENCE_DIR, `bd-list-${width}.png`), fullPage: false });
      expect(await details(id)).toMatchObject({ partner: `Browser partner ${width}`, athenaRole: "SUB", budgetUsd: 0, pwinAdjustedNfrUsd: 250.25 });
      expect(errors).toEqual([]);
    } finally { await browser.close(); }
  });
});
