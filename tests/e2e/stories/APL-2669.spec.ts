// APL-2669 story: a malformed task version is a bad request, not a conflict.
// Signs up its own worker and outsider against the local outbox. Staging shards share accounts, so they skip.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, request, test, type APIRequestContext } from "@playwright/test";

const PW = "correct-horse-9";
const OUTBOX = process.env.EMAIL_OUTBOX_DIR ?? ".outbox";
const baseURL = process.env.BASE_URL ?? process.env.TASKBOARD_URL ?? "http://localhost:3100";
const MALFORMED = ["abc", "", " 3 ", "3", 0, -1, 1.5, true, [], {}] as const;

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

test.describe("APL-2669 a malformed task version is a bad request", () => {
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
    // Two real edits take the new task from version 1 to version 3 without changing the title.
    let version = 1;
    for (const description of ["note-a", "note-b"]) {
      const saved = await worker.patch(`/api/tasks/${taskId}`, { data: { description, version } });
      expect(saved.status(), await saved.text()).toBe(200);
      version = (await saved.json()).task.version as number;
    }
    expect(version).toBe(3);
  });

  test.afterAll(async () => {
    await lead?.dispose();
    await worker?.dispose();
    await outsider?.dispose();
  });

  async function taskNow() {
    const r = await worker.get(`/api/tasks/${taskId}`);
    expect(r.status()).toBe(200);
    const task = (await r.json()).task as { title: string; version: number };
    return { title: task.title, version: task.version };
  }

  async function updatedCount() {
    const r = await lead.get(`/api/projects/${projectId}/activity`);
    expect(r.status()).toBe(200);
    return ((await r.json()).items as unknown[]).length;
  }

  test("AC1 any version that is not a positive integer is 400 invalid_version", async () => {
    const rows = await updatedCount();
    for (const version of MALFORMED) {
      const r = await worker.patch(`/api/tasks/${taskId}`, { data: { title: "New", version } });
      const body = await r.json();
      expect(r.status(), JSON.stringify({ version, body })).toBe(400);
      expect(body.code).toBe("invalid_version");
    }
    const overflow = await worker.fetch(`/api/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      data: '{"title":"New","version":1e309}',
    });
    expect(overflow.status()).toBe(400);
    expect((await overflow.json()).code).toBe("invalid_version");
    expect(await taskNow()).toEqual({ title: "Original", version: 3 });
    expect(await updatedCount()).toBe(rows);
  });

  test("AC2 a well-formed version that is not current is 409 version_conflict", async () => {
    for (const version of [2, 4]) {
      const r = await worker.patch(`/api/tasks/${taskId}`, { data: { title: "New", version } });
      expect(r.status()).toBe(409);
      expect((await r.json()).code).toBe("version_conflict");
      expect(await taskNow()).toEqual({ title: "Original", version: 3 });
    }
  });

  test("AC4 a user who cannot see the task gets the same 404 before the version is checked", async () => {
    const hidden = await outsider.patch(`/api/tasks/${taskId}`, { data: { version: "abc" } });
    const current = await outsider.patch(`/api/tasks/${taskId}`, { data: { version: 3 } });
    const missing = await outsider.patch("/api/tasks/does-not-exist", { data: { version: "abc" } });
    expect(hidden.status()).toBe(404);
    expect(current.status()).toBe(404);
    expect(missing.status()).toBe(404);
    const hiddenBody = await hidden.json();
    expect(await current.json()).toEqual(hiddenBody);
    expect(await missing.json()).toEqual(hiddenBody);
    expect(hiddenBody).toEqual({ error: "Task not found" });
    expect(JSON.stringify(hiddenBody)).not.toMatch(/Original|New|invalid_version|version_conflict/);
  });

  test("AC3 the current version saves and the task moves to the next version", async () => {
    const rows = await updatedCount();
    const r = await worker.patch(`/api/tasks/${taskId}`, { data: { title: "New", version: 3 } });
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.task.title).toBe("New");
    expect(body.task.version).toBe(4);
    expect(await taskNow()).toEqual({ title: "New", version: 4 });
    expect(await updatedCount()).toBe(rows + 1);
  });
});
