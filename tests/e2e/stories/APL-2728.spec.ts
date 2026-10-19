// APL-2728 AC1 in a real browser. A deal the viewer cannot see is one fixed sentence on the person page,
// with no deal name, no deal id, no /projects/<dealId> link and no deal-derived text.
// Each CRM_VISIBLE mode is its own `next start` process (as tests/crm-visible-modes-server.test.ts), and
// Chromium is driven with playwright-core at 1280x800 and 390x844. Needs `npm run build` first.
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
import { chromium, type Browser, type Page } from "playwright-core";
import { db } from "../../../src/lib/db";
import { istDate, PW } from "../../helpers";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const SHOTS = path.join(root, "test-results", "APL-2728");
const SENTENCE = "A deal you can't view.";
const runId = `${Date.now().toString(36)}-${process.pid}`;
const tag = `ZZ-TEST-${runId}`;
const dealName = `ZZ-TEST Acme renewal ${tag}`;
const taskTitle = `ZZ-TEST Acme kickoff ${tag}`;
const plainName = `ZZ-TEST Shared ${tag}`;
const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
] as const;
const HIDDEN_MODES = ["admins", "off"] as const;
type Mode = "on" | (typeof HIDDEN_MODES)[number];
type Server = { mode: Mode; pid: number; outbox: string; base: string };
type Person = { id: string; name: string; email: string; cookie: string };

const servers = new Map<Mode, Server>();
const seed = { emails: [] as string[], userIds: [] as string[], projectIds: [] as string[], orgIds: [] as string[] };
let browser: Browser | undefined;
let member: Person;
let rep: Person;
let admin: Person;
let dealId = "";
let plainId = "";
let stageName = "";

/** Refuses any database that is not on this machine (the CI service container is localhost). */
function assertLocalDatabase() {
  let host = "";
  try { host = new URL(process.env.DATABASE_URL ?? "").hostname.toLowerCase(); } catch { /* checked below */ }
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("APL-2728 story: refusing to run, DATABASE_URL is not a local database.");
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
  if (!found) throw new Error(`APL-2728 story: no Chromium found. Set PW_CHROMIUM. Looked in ${candidates.join(", ")}`);
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
  const outbox = mkdtempSync(path.join(tmpdir(), `sho-2728-${mode}-`));
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
  if (!child.pid) throw new Error(`APL-2728 story: CRM_VISIBLE=${mode} did not start`);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return { mode, pid: child.pid, outbox, base: `http://127.0.0.1:${port}` };
    } catch { /* still booting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  stop(child.pid);
  throw new Error(`APL-2728 story: CRM_VISIBLE=${mode} never answered /api/health`);
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
  const email = `nakul17+zz-2728-${runId}-${label}@aplyd.com`;
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

/** Opens /team/<personId> as `viewer` and waits until the person and the shared plain project have loaded. */
async function openPerson(server: Server, viewer: Person, personId: string, personName: string, size: { width: number; height: number }) {
  const context = await browser!.newContext({ viewport: size });
  const eq = viewer.cookie.indexOf("=");
  await context.addCookies([{ name: viewer.cookie.slice(0, eq), value: viewer.cookie.slice(eq + 1), url: server.base }]);
  const page = await context.newPage();
  await page.goto(`${server.base}/team/${personId}`);
  await page.getByRole("heading", { level: 1, name: personName }).waitFor();
  await page.getByRole("link", { name: plainName }).waitFor();
  return { page, close: () => context.close() };
}

/** Every string a reader can see or a script can follow: page text, HTML, each link and each aria-label. */
async function surface(page: Page) {
  const dom = await page.evaluate(() => ({
    text: document.body.innerText,
    links: [...document.querySelectorAll("a")].map((a) => ({
      text: (a.textContent ?? "").replace(/\s+/g, " ").trim(),
      href: a.getAttribute("href") ?? "",
      label: a.getAttribute("aria-label") ?? "",
    })),
    labels: [...document.querySelectorAll("[aria-label]")].map((el) => el.getAttribute("aria-label") ?? ""),
  }));
  return { ...dom, html: await page.content() };
}

beforeAll(async () => {
  assertLocalDatabase();
  if (!existsSync(path.join(root, ".next", "BUILD_ID"))) {
    throw new Error("APL-2728 story cannot start: the production build is missing (.next/BUILD_ID)");
  }
  mkdirSync(SHOTS, { recursive: true });
  const [on, admins, off] = await Promise.all([startServer("on"), startServer("admins"), startServer("off")]);
  servers.set("on", on).set("admins", admins).set("off", off);
  browser = await chromium.launch({ executablePath: chromiumPath(), args: ["--no-sandbox"] });

  // Seeded once on the open server: an admin leads the deal, and the non-admins "member" and "rep" are both on it.
  member = await signIn(on, "member");
  rep = await signIn(on, "rep");
  admin = await signIn(on, "admin");
  await db.user.update({ where: { id: admin.id }, data: { orgRole: "ADMIN" } });
  const pipes = await call(on.base, admin.cookie, "GET", "/api/deals/pipelines");
  expect(pipes.status, pipes.text).toBe(200);
  const pipe = (pipes.json?.pipelines as { id: string; key: string }[]).find((p) => p.key === "DEAL_PROACTIVE");
  expect(pipe?.id).toBeTruthy();
  const org = await call(on.base, admin.cookie, "POST", "/api/orgs", { name: `ZZ-TEST Buyer ${tag}` });
  expect(org.status, org.text).toBe(201);
  seed.orgIds.push((org.json?.organisation as { id: string }).id);
  const made = await call(on.base, admin.cookie, "POST", "/api/deals", {
    name: dealName, organisationId: seed.orgIds[0], pipelineId: pipe!.id, leaderId: admin.id, whyPursue: tag,
    nextStep: { title: taskTitle, dueDate: istDate(3) },
  });
  expect(made.status, made.text).toBe(201);
  dealId = (made.json?.deal as { id: string }).id;
  seed.projectIds.push(dealId);
  const plain = await call(on.base, admin.cookie, "POST", "/api/projects", { name: plainName, leaderId: admin.id });
  expect(plain.status, plain.text).toBe(201);
  plainId = (plain.json?.project as { id: string }).id;
  seed.projectIds.push(plainId);
  for (const who of [member, rep]) {
    for (const projectId of [dealId, plainId]) {
      const added = await call(on.base, admin.cookie, "POST", `/api/projects/${projectId}/members`, { userId: who.id, role: "EDITOR" });
      expect(added.status, added.text).toBe(201);
    }
  }
  const stage = await db.project.findUnique({ where: { id: dealId }, select: { stage: { select: { name: true } } } });
  stageName = stage?.stage?.name ?? "";
  expect(stageName).toBeTruthy();
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

describe("qa:TC missing APL-2728 person page in the browser", () => {
  for (const mode of HIDDEN_MODES) {
    for (const size of VIEWPORTS) {
      it(`qa:TC missing AC1: CRM_VISIBLE=${mode} at ${size.width}x${size.height}, the member sees one sentence and nothing of the deal on the rep's page`, async () => {
        const { page, close } = await openPerson(servers.get(mode)!, member, rep.id, rep.name, size);
        try {
          await page.getByText(SENTENCE, { exact: true }).waitFor();
          await page.screenshot({ path: path.join(SHOTS, `${mode}-${size.width}x${size.height}.png`), fullPage: true });
          const seen = await surface(page);
          expect(seen.text.split(SENTENCE).length - 1, "the sentence appears once").toBe(1);
          for (const link of seen.links) {
            expect(link.text, "the sentence is not a link").not.toContain(SENTENCE);
            expect(link.label).not.toContain(SENTENCE);
          }
          expect(seen.links.some((link) => link.href === `/projects/${plainId}` && link.text === plainName), "the shared plain project still links").toBe(true);
          const blobs = [seen.text, seen.html, ...seen.labels, ...seen.links.flatMap((link) => [link.text, link.href, link.label])];
          for (const blob of blobs) {
            expect(blob).not.toContain(dealName);
            expect(blob).not.toContain(dealId);
            expect(blob).not.toContain(`/projects/${dealId}`);
            expect(blob).not.toContain(taskTitle);
            expect(blob).not.toContain(stageName);
          }
        } finally {
          await close();
        }
      });
    }
  }

  // Shows the checks above can see the deal when it is visible, so their passing is not vacuous.
  it("qa:TC missing AC2: CRM_VISIBLE=admins at 1280x800, the admin still sees the deal name and its link on the rep's page", async () => {
    const { page, close } = await openPerson(servers.get("admins")!, admin, rep.id, rep.name, VIEWPORTS[0]);
    try {
      await page.getByRole("link", { name: dealName }).waitFor();
      const seen = await surface(page);
      expect(seen.links.some((link) => link.href === `/projects/${dealId}` && link.text === dealName)).toBe(true);
      expect(seen.text).not.toContain(SENTENCE);
    } finally {
      await close();
    }
  });
});
