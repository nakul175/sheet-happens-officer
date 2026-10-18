// APL-2669 story: a malformed expectedUpdatedAt is a bad request, not a conflict.
// Signs up its own worker and outsider against the local outbox. Staging shards share accounts, so they skip.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, request, test, type APIRequestContext } from "@playwright/test";

const PW = "correct-horse-9";
const OUTBOX = process.env.EMAIL_OUTBOX_DIR ?? ".outbox";
const baseURL = process.env.BASE_URL ?? process.env.TASKBOARD_URL ?? "http://localhost:3100";
const MALFORMED = [
  "abc",
  "",
  " ",
  "2026-13-40T99:00:00Z",
  "18/10/2026",
  "2026-10-18",
  "2026-10-18T10:00:00",
  "2026-10-18T10:00:00.000",
  1760781600000,
  true,
  [],
  {},
] as const;

function verifyToken(email: string) {
  const files = readdirSync(OUTBOX).sort();
  const mails = files
    .map((f) => JSON.parse(readFileSync(path.join(OUTBOX, f), "utf8")) as { to: string; subject: string; text: string })
    .filter((m) => m.to === email && /Verify/.test(m.subject));
  return mails.at(-1)?.text.match(/token=([\w-]+)/)?.[1] ?? null;
}

async function signUp(label: string) {
  const email = `${label}${Date.now()}${Math.floor(Math.random() * 1000)}@aplyd.com`;
  const api = await request.newContext({ baseURL });
  const name = label[0].toUpperCase() + label.slice(1);
  expect((await api.post("/api/auth/signup", { data: { name, email, password: PW } })).status()).toBe(201);
  const token = verifyToken(email);
  expect(token, `verification mail for ${email}`).toBeTruthy();
  expect((await api.post("/api/auth/verify", { data: { token } })).status()).toBe(200);
  const signed = await api.post("/api/auth/signin", { data: { email, password: PW } });
  expect(signed.status()).toBe(200);
  const id = (await signed.json()).user.id as string;
  return { api, id };
}

/** +05:30 wall clock for the same instant, so AC5 can send an offset form of the live updatedAt. */
function plus0530(iso: string) {
  const shifted = new Date(Date.parse(iso) + 5.5 * 3600_000);
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}.${pad(shifted.getUTCMilliseconds(), 3)}+05:30`;
}

test.describe("APL-2669 a malformed expectedUpdatedAt is a bad request", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(!!process.env.SHARD_EMAIL, "Staging shards share accounts. This story signs up against the local outbox.");

  let lead: APIRequestContext;
  let worker: APIRequestContext;
  let outsider: APIRequestContext;
  let projectId: string;
  let taskId: string;

  test.beforeAll(async () => {
    const leader = await signUp("lead");
    const editor = await signUp("worker");
    const stranger = await signUp("outsider");
    lead = leader.api;
    worker = editor.api;
    outsider = stranger.api;
    const created = await lead.post("/api/projects", { data: { name: `ZZ-TEST-VER-${Date.now()}`, leaderId: leader.id } });
    expect(created.status()).toBe(201);
    projectId = (await created.json()).project.id as string;
    expect((await lead.post(`/api/projects/${projectId}/members`, { data: { userId: editor.id, role: "EDITOR" } })).status()).toBe(201);
    const made = await lead.post(`/api/projects/${projectId}/tasks`, { data: { title: "Original" } });
    expect(made.status()).toBe(201);
    taskId = (await made.json()).task.id as string;
  });

  test.afterAll(async () => {
    await lead?.dispose();
    await worker?.dispose();
    await outsider?.dispose();
  });

  async function taskNow() {
    const r = await worker.get(`/api/tasks/${taskId}`);
    expect(r.status()).toBe(200);
    const row = (await r.json()).task as { title: string; updatedAt: string };
    return { title: row.title, updatedAt: row.updatedAt };
  }

  async function updatedCount() {
    const r = await lead.get(`/api/projects/${projectId}/activity`);
    expect(r.status()).toBe(200);
    return ((await r.json()).items as unknown[]).length;
  }

  test("AC1 an invalid or empty expectedUpdatedAt is 400 invalid_version", async () => {
    const before = await taskNow();
    const rows = await updatedCount();
    for (const expectedUpdatedAt of MALFORMED) {
      const r = await worker.patch(`/api/tasks/${taskId}`, { data: { title: "New", expectedUpdatedAt } });
      const body = await r.json();
      expect(r.status(), JSON.stringify({ expectedUpdatedAt, body })).toBe(400);
      expect(body.code).toBe("invalid_version");
    }
    expect(await taskNow()).toEqual(before);
    expect(await updatedCount()).toBe(rows);
  });

  test("AC2 a valid timestamp that is not current is 409 version_conflict", async () => {
    const before = await taskNow();
    const t0 = Date.parse(before.updatedAt);
    for (const expectedUpdatedAt of [new Date(t0 - 1000).toISOString(), new Date(t0 + 1000).toISOString()]) {
      const r = await worker.patch(`/api/tasks/${taskId}`, { data: { title: "New", expectedUpdatedAt } });
      const body = await r.json();
      expect(r.status()).toBe(409);
      expect(body.code).toBe("version_conflict");
      expect(await taskNow()).toEqual(before);
    }
  });

  test("AC4 a user who cannot see the task gets the same 404 before the timestamp is checked", async () => {
    const before = await taskNow();
    const hidden = await outsider.patch(`/api/tasks/${taskId}`, { data: { expectedUpdatedAt: "abc" } });
    const current = await outsider.patch(`/api/tasks/${taskId}`, { data: { expectedUpdatedAt: before.updatedAt } });
    const missing = await outsider.patch("/api/tasks/does-not-exist", { data: { expectedUpdatedAt: "abc" } });
    expect(hidden.status()).toBe(404);
    expect(current.status()).toBe(404);
    expect(missing.status()).toBe(404);
    const hiddenBody = await hidden.json();
    expect(await current.json()).toEqual(hiddenBody);
    expect(await missing.json()).toEqual(hiddenBody);
    expect(hiddenBody).toEqual({ error: "Task not found" });
    expect(JSON.stringify(hiddenBody)).not.toMatch(/Original|New|invalid_version|version_conflict/);
    expect(await taskNow()).toEqual(before);
  });

  test("AC5 the same instant succeeds as Z or as an offset", async () => {
    const before = await taskNow();
    // Dropping the fraction is the same instant only when it is .000, which the unit fixture covers.
    const forms = [before.updatedAt, plus0530(before.updatedAt), before.updatedAt.replace(/Z$/, "+00:00")];
    for (const expectedUpdatedAt of forms) {
      const r = await worker.patch(`/api/tasks/${taskId}`, { data: { title: "Original", expectedUpdatedAt } });
      const body = await r.json();
      expect(r.status(), JSON.stringify({ expectedUpdatedAt, body })).toBe(200);
    }
    expect(await taskNow()).toEqual(before);
  });

  test("AC3 the current timestamp saves and updatedAt moves forward", async () => {
    const before = await taskNow();
    const rows = await updatedCount();
    const r = await worker.patch(`/api/tasks/${taskId}`, { data: { title: "New", expectedUpdatedAt: before.updatedAt } });
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.task.title).toBe("New");
    expect(Date.parse(body.task.updatedAt)).toBeGreaterThan(Date.parse(before.updatedAt));
    expect((await taskNow()).title).toBe("New");
    expect(await updatedCount()).toBe(rows + 1);
  });
});
