// APL-2875 AC1, example T3: a task in a deal hidden by CRM_VISIBLE=admins answers a non-admin exactly like a missing id
// on R1-R17, over HTTP. Same shape as tests/apl-2713-crm-modes.test.ts: its own `next start` with CRM_VISIBLE=admins.
// Run with `npm run test:crm-modes` after `npm run build`. `npm test` does not start this server.
// Test data: ZZ-TEST names and nakul17+ aliases, set up and cleaned up through the API only.
import "dotenv/config";
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { istDate, PW } from "./helpers";

const root = fileURLToPath(new URL("..", import.meta.url));
const RUN = `${Date.now().toString(36)}-${process.pid}`;
const MISSING = `zz-test-missing-${RUN}`;
const MALFORMED = "{";
const VERSION = "2020-01-01T00:00:00.000Z";
const ROOT_EMAIL = `nakul17+zz-2875-root-${RUN}@aplyd.com`;
const server = { base: "", pid: 0, outbox: "" };

type Res = { status: number; body: string };
type Who = { id: string; cookie: string };

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
    s.on("error", reject);
  });
}

function killGroup(pid: number) {
  if (!pid || pid === process.pid) return;
  try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}

/** The raw status and body text, so two answers can be compared byte for byte. */
async function send(cookie: string, method: string, p: string, body?: string): Promise<Res & { cookie: string; json: Record<string, unknown> | null }> {
  const res = await fetch(server.base + p, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
    body,
  });
  const session = (res.headers.getSetCookie?.() ?? []).map((l) => l.split(";")[0]).find((l) => l.startsWith("sho_session="));
  const text = await res.text();
  const json = text && res.headers.get("content-type")?.includes("json") ? (JSON.parse(text) as Record<string, unknown>) : null;
  return { status: res.status, body: text, cookie: session ?? cookie, json };
}
const answer = async (cookie: string, method: string, p: string, body?: string): Promise<Res> => {
  const r = await send(cookie, method, p, body);
  return { status: r.status, body: r.body };
};

async function person(label: string, email = `nakul17+zz-2875-${label}-${RUN}@aplyd.com`): Promise<Who> {
  const made = await send("", "POST", "/api/auth/signup", JSON.stringify({ name: `ZZ-TEST ${label}`, email, password: PW }));
  expect(made.status, made.body).toBe(201);
  const mails = readdirSync(server.outbox).filter((f) => f.endsWith(".json")).sort()
    .map((f) => JSON.parse(readFileSync(path.join(server.outbox, f), "utf8")) as { to?: string; subject?: string; text?: string });
  const token = mails.filter((m) => m.to?.toLowerCase() === email.toLowerCase() && /Verify/.test(m.subject ?? "")).at(-1)?.text?.match(/token=([\w-]+)/)?.[1];
  expect(token, `verification mail for ${label}`).toBeTruthy();
  expect((await send("", "POST", "/api/auth/verify", JSON.stringify({ token }))).status).toBe(200);
  const signed = await send("", "POST", "/api/auth/signin", JSON.stringify({ email, password: PW }));
  expect(signed.status, signed.body).toBe(200);
  return { id: (signed.json!.user as { id: string }).id, cookie: signed.cookie };
}

const seed: { sa?: Who; admin?: Who; people: Who[]; dealId?: string } = { people: [] };

beforeAll(async () => {
  if (!existsSync(path.join(root, ".next", "BUILD_ID"))) throw new Error("CRM_VISIBLE=admins cannot start: the production build is missing (.next/BUILD_ID)");
  const port = await freePort();
  server.outbox = mkdtempSync(path.join(tmpdir(), "sho-apl2875-admins-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env, NODE_ENV: "production", CRM_VISIBLE: "admins", EMAIL_OUTBOX_DIR: server.outbox,
    APP_URL: `http://127.0.0.1:${port}`, PORT: String(port), SUPER_ADMIN_EMAILS: ROOT_EMAIL,
    JOB_SECRET: process.env.JOB_SECRET || "replace-with-a-token-of-at-least-16-chars",
  };
  const logFd = openSync(path.join(server.outbox, "server.log"), "a");
  const child = spawn("npx", ["next", "start", "-H", "127.0.0.1", "-p", String(port)], { cwd: root, env, detached: true, stdio: ["ignore", logFd, logFd] });
  closeSync(logFd);
  child.unref();
  server.pid = child.pid ?? 0;
  server.base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`CRM_VISIBLE=admins cannot start (exited ${child.exitCode})`);
    try { if ((await fetch(`${server.base}/api/health`)).ok) break; } catch { /* still booting */ }
    if (Date.now() > deadline) throw new Error("CRM_VISIBLE=admins cannot start (no healthy response)");
    await new Promise((r) => setTimeout(r, 250));
  }
}, 120_000);

afterAll(async () => {
  try {
    if (seed.admin && seed.dealId) await send(seed.admin.cookie, "POST", `/api/projects/${seed.dealId}/archive`, "{}");
    if (seed.sa) for (const p of seed.people) await send(seed.sa.cookie, "POST", `/api/team/${p.id}/deactivate`, JSON.stringify({ reassign: "leaders" }));
  } finally {
    killGroup(server.pid);
  }
});

type Route = { r: string; method: string; path: (id: string) => string; valid?: object; invalid?: object };
// R1-R17 of the APL-2875 v1.3 ACs, the same rows as tests/task-outsider-2875.test.ts.
const routes = (other: string): Route[] => [
  { r: "R1", method: "GET", path: (id) => `/api/tasks/${id}` },
  { r: "R2", method: "PATCH", path: (id) => `/api/tasks/${id}`, valid: { title: "ZZ-TEST changed", expectedUpdatedAt: VERSION }, invalid: { title: 7 } },
  { r: "R3", method: "DELETE", path: (id) => `/api/tasks/${id}` },
  { r: "R4", method: "POST", path: (id) => `/api/tasks/${id}/assign`, valid: { assigneeId: other, expectedUpdatedAt: VERSION }, invalid: { assigneeId: "" } },
  { r: "R5", method: "POST", path: (id) => `/api/tasks/${id}/collaborators`, valid: { userId: other }, invalid: { userId: "" } },
  { r: "R6", method: "DELETE", path: (id) => `/api/tasks/${id}/collaborators/${other}` },
  { r: "R7", method: "PUT", path: (id) => `/api/tasks/${id}/approver`, valid: { approverId: other, expectedUpdatedAt: VERSION }, invalid: { approverId: "" } },
  { r: "R8", method: "POST", path: (id) => `/api/tasks/${id}/send-for-approval`, valid: {} },
  { r: "R9", method: "POST", path: (id) => `/api/tasks/${id}/send-back`, valid: {} },
  { r: "R10", method: "POST", path: (id) => `/api/tasks/${id}/complete`, valid: { expectedUpdatedAt: VERSION }, invalid: { completeAll: "yes" } },
  { r: "R11", method: "POST", path: (id) => `/api/tasks/${id}/reopen`, valid: {}, invalid: { sectionId: "" } },
  { r: "R12", method: "POST", path: (id) => `/api/tasks/${id}/move`, valid: { sectionId: MISSING, expectedUpdatedAt: VERSION }, invalid: { sectionId: "" } },
  { r: "R13", method: "POST", path: (id) => `/api/tasks/${id}/restore`, valid: {}, invalid: { confirmParent: "yes" } },
  { r: "R14", method: "POST", path: (id) => `/api/tasks/${id}/idea`, valid: { isIdea: true }, invalid: { isIdea: "yes" } },
  { r: "R15", method: "POST", path: (id) => `/api/tasks/${id}/links`, valid: { organisationId: MISSING }, invalid: { organisationId: 7 } },
  { r: "R16", method: "DELETE", path: (id) => `/api/tasks/${id}/links/${MISSING}` },
  { r: "R17", method: "POST", path: (id) => `/api/tasks/${id}/convert`, valid: {}, invalid: { force: "yes" } },
];

describe("qa:TC missing APL-2875 T3: a task in a hidden deal answers like a missing id over HTTP", () => {
  it("qa:TC missing AC1: a non-admin deal member and an outsider get the missing-id answer for T3 on R1-R17, and T3 is unchanged", async () => {
    seed.sa = await person("root", ROOT_EMAIL);
    seed.admin = await person("admin");
    const editor = await person("editor");
    const outsider = await person("outsider");
    seed.people.push(seed.admin, editor, outsider);
    expect((await send(seed.sa.cookie, "PATCH", `/api/team/${seed.admin.id}`, JSON.stringify({ orgRole: "ADMIN" }))).status).toBe(200);

    const pipes = await send(seed.admin.cookie, "GET", "/api/deals/pipelines");
    expect(pipes.status, pipes.body).toBe(200);
    const pipeline = (pipes.json!.pipelines as { id: string; key: string }[]).find((p) => p.key === "DEAL_PROACTIVE");
    const org = await send(seed.admin.cookie, "POST", "/api/orgs", JSON.stringify({ name: `ZZ-TEST APL-2875 buyer ${RUN}` }));
    expect(org.status, org.body).toBe(201);
    const deal = await send(seed.admin.cookie, "POST", "/api/deals", JSON.stringify({
      name: `ZZ-TEST APL-2875 deal ${RUN}`, organisationId: (org.json!.organisation as { id: string }).id, pipelineId: pipeline!.id,
      leaderId: seed.admin.id, whyPursue: "ZZ-TEST", nextStep: { title: "ZZ-TEST call", dueDate: istDate(3) },
    }));
    expect(deal.status, deal.body).toBe(201);
    seed.dealId = (deal.json!.deal as { id: string }).id;
    expect((await send(seed.admin.cookie, "POST", `/api/projects/${seed.dealId}/members`, JSON.stringify({ userId: editor.id, role: "EDITOR" }))).status).toBe(201);
    const made = await send(seed.admin.cookie, "POST", `/api/projects/${seed.dealId}/tasks`, JSON.stringify({ title: `ZZ-TEST deal task ${RUN}`, assigneeId: seed.admin.id }));
    expect(made.status, made.body).toBe(201);
    const t3 = (made.json!.task as { id: string }).id;
    const before = (await send(seed.admin.cookie, "GET", `/api/tasks/${t3}`)).body;

    for (const [label, who] of [["deal member", editor], ["outsider", outsider]] as const) {
      for (const r of routes(seed.admin.id)) {
        const sent = r.valid === undefined ? [undefined] : [JSON.stringify(r.valid), ...(r.invalid ? [JSON.stringify(r.invalid)] : []), MALFORMED];
        for (const body of sent) {
          const missing = await answer(who.cookie, r.method, r.path(MISSING), body);
          const hidden = await answer(who.cookie, r.method, r.path(t3), body);
          expect(hidden, `${r.r} ${label} ${r.method} ${r.path("T3")} ${body ?? ""}`).toEqual(missing);
          expect(hidden.body).not.toMatch(/Project not found|ZZ-TEST|nakul17/);
        }
      }
    }
    // The Admin still sees T3, and nothing the refused calls sent was stored.
    expect((await send(seed.admin.cookie, "GET", `/api/tasks/${t3}`)).body).toBe(before);
  }, 120_000);
});
