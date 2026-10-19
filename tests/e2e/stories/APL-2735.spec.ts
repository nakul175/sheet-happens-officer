// APL-2735 in a real browser. The team page deactivate dialog shows the 409 text inline (role="alert"), not as a toast.
// The person page does not call deactivate. An Admin while CRM_VISIBLE=off cannot see the CRM: the alert is the
// generic sentence, with no deal name, no deal id and no change-leader link. An Admin while CRM_VISIBLE=on still
// sees both deal names and a change-leader link for each.
// Each CRM_VISIBLE mode is its own `next start` process (as tests/e2e/stories/APL-2728.spec.ts), and
// Chromium is driven with playwright-core. Needs `npm run build` first.
// Run with `npm run test:crm-modes` (CI runs it after the build). `npm test` does not start these servers.
// Local or CI Postgres only: a DATABASE_URL on any other host is refused before anything starts.
// People are run-unique nakul17+ aliases, data is named ZZ-TEST, and afterAll deletes both.
import "dotenv/config";
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, statSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright-core";
import { db } from "../../../src/lib/db";
import { istDate, PW } from "../../helpers";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const SHOTS = path.join(root, "test-results", "APL-2735");
const GENERIC = "Name a new Leader first.";
const runId = `${Date.now().toString(36)}-${process.pid}`;
const tag = `ZZ-TEST-${runId}`;
const dealNames = [`ZZ-TEST Northwind ${tag}`, `ZZ-TEST Contoso ${tag}`];
const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
] as const;
type Mode = "on" | "off";
type Server = { mode: Mode; pid: number; outbox: string; base: string };
type Person = { id: string; name: string; email: string; cookie: string };

const servers = new Map<Mode, Server>();
const seed = { emails: [] as string[], userIds: [] as string[], projectIds: [] as string[], orgIds: [] as string[] };
const dealIds: string[] = [];
let browser: Browser | undefined;
let admin: Person;
let leader: Person;

/** Refuses any database that is not on this machine (the CI service container is localhost). */
function assertLocalDatabase() {
  let host = "";
  try { host = new URL(process.env.DATABASE_URL ?? "").hostname.toLowerCase(); } catch { /* checked below */ }
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("APL-2735 story: refusing to run, DATABASE_URL is not a local database.");
  }
}

function chromiumPath() {
  const candidates = [
    process.env.PW_CHROMIUM,
    "/opt/pw-browsers/chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/local/bin/google-chrome",
  ].filter((p): p is string => !!p);
  const found = candidates.find((p) => existsSync(p) && statSync(p).isFile());
  if (!found) throw new Error(`APL-2735 story: no Chromium found. Set PW_CHROMIUM. Looked in ${candidates.join(", ")}`);
  return found;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
    server.on("error", reject);
  });
}

/** Stops the process group this file spawned, by its exact PID. */
function stop(pid: number) {
  try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
}

async function startServer(mode: Mode): Promise<Server> {
  const port = await freePort();
  const outbox = mkdtempSync(path.join(tmpdir(), `sho-2735-${mode}-`));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    CRM_VISIBLE: mode,
    EMAIL_OUTBOX_DIR: outbox,
    APP_URL: `http://127.0.0.1:${port}`,
    PORT: String(port),
    SUPER_ADMIN_EMAILS: "root.test@aplyd.com",
    JOB_SECRET: process.env.JOB_SECRET || "replace-with-a-token-of-at-least-16-chars",
  };
  const logFd = openSync(path.join(outbox, "server.log"), "a");
  const child = spawn("npx", ["next", "start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: root, env, detached: true, stdio: ["ignore", logFd, logFd],
  });
  closeSync(logFd);
  child.unref();
  if (!child.pid) throw new Error(`APL-2735 story: CRM_VISIBLE=${mode} did not start`);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return { mode, pid: child.pid, outbox, base: `http://127.0.0.1:${port}` };
    } catch { /* still booting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  stop(child.pid);
  throw new Error(`APL-2735 story: CRM_VISIBLE=${mode} never answered /api/health`);
}

async function call(base: string, cookie: string, method: string, p: string, body?: unknown) {
  const res = await fetch(base + p, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sets = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  const session = sets.map((line) => line.split(";")[0]).find((line) => line.startsWith("sho_session="));
  const text = await res.text();
  const json = text && res.headers.get("content-type")?.includes("json") ? (JSON.parse(text) as Record<string, unknown>) : null;
  return { status: res.status, text, json, cookie: session ?? cookie };
}

async function signIn(server: Server, label: string): Promise<Person> {
  const email = `nakul17+zz-2735-${runId}-${label}@aplyd.com`;
  const name = `ZZ-TEST ${label} ${runId}`;
  seed.emails.push(email);
  const created = await call(server.base, "", "POST", "/api/auth/signup", { name, email, password: PW });
  expect(created.status, created.text).toBe(201);
  const mails = readdirSync(server.outbox).filter((f) => f.endsWith(".json")).sort()
    .map((f) => JSON.parse(readFileSync(path.join(server.outbox, f), "utf8")) as { to?: string; subject?: string; text?: string });
  const token = mails.filter((m) => m.to === email && /Verify/.test(m.subject ?? "")).at(-1)?.text?.match(/token=([\w-]+)/)?.[1];
  expect(token, `verification mail for ${label}`).toBeTruthy();
  expect((await call(server.base, "", "POST", "/api/auth/verify", { token })).status).toBe(200);
  const signed = await call(server.base, "", "POST", "/api/auth/signin", { email, password: PW });
  expect(signed.status, signed.text).toBe(200);
  const id = (signed.json?.user as { id: string }).id;
  seed.userIds.push(id);
  return { id, name, email, cookie: signed.cookie };
}

async function cleanup() {
  const users = await db.user.findMany({ where: { OR: [{ id: { in: seed.userIds } }, { email: { in: seed.emails } }] }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  if (userIds.length || seed.projectIds.length) {
    await db.actionLog.deleteMany({ where: { OR: [{ actorId: { in: userIds } }, { projectId: { in: seed.projectIds } }] } });
  }
  if (userIds.length) {
    await db.modelUsage.deleteMany({ where: { userId: { in: userIds } } });
    await db.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
  }
  if (seed.projectIds.length) await db.project.deleteMany({ where: { id: { in: seed.projectIds } } });
  if (seed.orgIds.length) await db.organisation.deleteMany({ where: { id: { in: seed.orgIds } } });
  if (seed.emails.length) await db.loginAttempt.deleteMany({ where: { email: { in: seed.emails } } });
  if (userIds.length) await db.user.deleteMany({ where: { id: { in: userIds } } });
}

/** Opens /team as `viewer`, clicks Deactivate on the leader's row, confirms, and waits for the inline alert. */
async function attemptDeactivate(server: Server, viewer: Person, size: { width: number; height: number }) {
  const context = await browser!.newContext({ viewport: size });
  const eq = viewer.cookie.indexOf("=");
  await context.addCookies([{ name: viewer.cookie.slice(0, eq), value: viewer.cookie.slice(eq + 1), url: server.base }]);
  const page = await context.newPage();
  await page.goto(`${server.base}/team`);
  const row = page.locator("tr").filter({ hasText: leader.email });
  await row.getByRole("button", { name: "Deactivate", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: `Deactivate ${leader.name}?` });
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "Deactivate", exact: true }).click();
  const alert = dialog.getByRole("alert");
  await alert.waitFor();
  const seen = {
    alert: (await alert.innerText()).trim(),
    text: await dialog.innerText(),
    html: await dialog.evaluate((el) => el.outerHTML),
    hrefs: await dialog.locator("a").evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? "")),
  };
  return { page, seen, close: () => context.close() };
}

beforeAll(async () => {
  assertLocalDatabase();
  if (!existsSync(path.join(root, ".next", "BUILD_ID"))) {
    throw new Error("APL-2735 story cannot start: the production build is missing (.next/BUILD_ID)");
  }
  mkdirSync(SHOTS, { recursive: true });
  const [on, off] = await Promise.all([startServer("on"), startServer("off")]);
  servers.set("on", on).set("off", off);
  browser = await chromium.launch({ executablePath: chromiumPath(), args: ["--no-sandbox"] });

  // Seeded once on the open server: an Admin, and a Member who leads two ZZ-TEST deals.
  admin = await signIn(on, "admin");
  leader = await signIn(on, "leader");
  await db.user.update({ where: { id: admin.id }, data: { orgRole: "ADMIN" } });
  const pipes = await call(on.base, admin.cookie, "GET", "/api/deals/pipelines");
  expect(pipes.status, pipes.text).toBe(200);
  const pipe = (pipes.json?.pipelines as { id: string; key: string }[]).find((p) => p.key === "DEAL_PROACTIVE");
  expect(pipe?.id).toBeTruthy();
  const org = await call(on.base, admin.cookie, "POST", "/api/orgs", { name: `ZZ-TEST Buyer ${tag}` });
  expect(org.status, org.text).toBe(201);
  seed.orgIds.push((org.json?.organisation as { id: string }).id);
  for (const name of dealNames) {
    const made = await call(on.base, admin.cookie, "POST", "/api/deals", {
      name, organisationId: seed.orgIds[0], pipelineId: pipe!.id, leaderId: leader.id, whyPursue: tag,
      nextStep: { title: `ZZ-TEST step ${tag}`, dueDate: istDate(3) },
    });
    expect(made.status, made.text).toBe(201);
    const id = (made.json?.deal as { id: string }).id;
    dealIds.push(id);
    seed.projectIds.push(id);
  }
}, 180_000);

afterAll(async () => {
  try {
    await browser?.close();
    await cleanup();
  } finally {
    for (const server of servers.values()) stop(server.pid);
    await db.$disconnect();
  }
});

describe("qa:TC missing APL-2735 deactivate dialog in the browser", () => {
  for (const size of VIEWPORTS) {
    it(`qa:TC missing AC1: CRM_VISIBLE=off at ${size.width}x${size.height}, the admin sees the generic sentence and nothing of the deals`, async () => {
      const { page, seen, close } = await attemptDeactivate(servers.get("off")!, admin, size);
      try {
        await page.screenshot({ path: path.join(SHOTS, `off-${size.width}x${size.height}.png`), fullPage: true });
        expect(seen.alert).toBe(GENERIC);
        expect(seen.text).not.toMatch(/\b2\b/);
        expect(seen.hrefs.filter((href) => href.includes("/projects/")), "no change-leader link").toEqual([]);
        for (const blob of [seen.text, seen.html]) {
          for (const name of dealNames) expect(blob).not.toContain(name);
          for (const id of dealIds) expect(blob).not.toContain(id);
        }
        expect((await db.user.findUnique({ where: { id: leader.id }, select: { deactivatedAt: true } }))?.deactivatedAt).toBeNull();
      } finally {
        await close();
      }
    });
  }

  // Shows the checks above can see the deals when they are visible, so their passing is not vacuous.
  it("qa:TC missing AC2: CRM_VISIBLE=on at 1280x800, the admin sees both deal names and a change-leader link for each", async () => {
    const { page, seen, close } = await attemptDeactivate(servers.get("on")!, admin, VIEWPORTS[0]);
    try {
      await page.screenshot({ path: path.join(SHOTS, "on-1280x800.png"), fullPage: true });
      expect(seen.alert.startsWith("Name a new Leader first for: ")).toBe(true);
      for (const name of dealNames) {
        expect(seen.alert).toContain(name);
        expect(seen.text).toContain(`${name}: Change leader`);
      }
      for (const id of dealIds) expect(seen.hrefs).toContain(`/projects/${id}/members`);
    } finally {
      await close();
    }
  });
});
