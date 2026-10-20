// APL-2669 story: a malformed expectedUpdatedAt is a bad request, not a conflict.
// Gate: SHO_QA_PASS. Without it the file fails in beforeAll, by design (APL-2888). It is also the password of the
// throwaway accounts this spec signs up: ZZ-TEST names on nakul17+zz-2669-… aliases, verified through the local outbox.
// afterAll cleans up through the API: the local Super Admin (SUPER_ADMIN_EMAILS, as in tests/helpers.ts) takes over
// as Leader, restores Trash and archives the project, then deactivates the three people.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, request, test, type APIRequestContext } from "@playwright/test";

const QA_PASS = process.env.SHO_QA_PASS ?? "";
// The local Super Admin of tests/helpers.ts. The server must run with SUPER_ADMIN_EMAILS=root.test@aplyd.com.
const SUPER = { email: "root.test@aplyd.com", password: "correct-horse-9" };
const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}`;
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

type Person = { api: APIRequestContext; id: string; email: string; name: string };

/** A throwaway person: ZZ-TEST name, nakul17+ alias, verified through the local outbox. */
async function signUp(label: string): Promise<Person> {
  const email = `nakul17+zz-2669-${RUN}-${label}@aplyd.com`;
  const api = await request.newContext({ baseURL });
  const name = `ZZ-TEST ${label} ${RUN}`;
  expect((await api.post("/api/auth/signup", { data: { name, email, password: QA_PASS } })).status()).toBe(201);
  const token = verifyToken(email);
  expect(token, `verification mail for ${email}`).toBeTruthy();
  expect((await api.post("/api/auth/verify", { data: { token } })).status()).toBe(200);
  const signed = await api.post("/api/auth/signin", { data: { email, password: QA_PASS } });
  expect(signed.status()).toBe(200);
  const id = (await signed.json()).user.id as string;
  return { api, id, email, name };
}

/** The same API cleanup as cleanupZz in tests/helpers.ts: Leader to the Super Admin, Trash restored, project archived, people deactivated. */
async function cleanUp(projectIds: string[], people: Person[]) {
  const sa = await request.newContext({ baseURL });
  const signed = await sa.post("/api/auth/signin", { data: SUPER });
  expect(signed.status(), "the local Super Admin must exist (run the Vitest suite once, or sign it up)").toBe(200);
  const saId = (await signed.json()).user.id as string;
  const problems: string[] = [];
  for (const id of projectIds) {
    const added = await sa.post(`/api/projects/${id}/members`, { data: { userId: saId, role: "EDITOR" } });
    if (added.status() !== 201 && added.status() !== 409) problems.push(`add member ${id}: ${added.status()}`);
    const led = await sa.post(`/api/projects/${id}/leader`, { data: { newLeaderId: saId, previousRole: "EDITOR" } });
    if (led.status() !== 200 && led.status() !== 400) problems.push(`change leader ${id}: ${led.status()}`);
    const trash = await sa.get(`/api/projects/${id}/trash`);
    for (const item of ((await trash.json()).items ?? []) as { id: string }[]) {
      const back = await sa.post(`/api/tasks/${item.id}/restore`, { data: { confirmParent: true } });
      if (back.status() >= 300) problems.push(`restore ${item.id}: ${back.status()}`);
    }
    const archived = await sa.post(`/api/projects/${id}/archive`);
    if (archived.status() !== 200) problems.push(`archive ${id}: ${archived.status()}`);
  }
  for (const who of people) {
    const off = await sa.post(`/api/team/${who.id}/deactivate`, { data: { reassign: "leaders" } });
    if (off.status() !== 200 && off.status() !== 409) problems.push(`deactivate ${who.email}: ${off.status()}`);
  }
  await sa.dispose();
  expect(problems, problems.join("\n")).toEqual([]);
}

/** +05:30 wall clock for the same instant, so AC5 can send an offset form of the live updatedAt. */
function plus0530(iso: string) {
  const shifted = new Date(Date.parse(iso) + 5.5 * 3600_000);
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}.${pad(shifted.getUTCMilliseconds(), 3)}+05:30`;
}

test.describe("APL-2669 a malformed expectedUpdatedAt is a bad request", { tag: "@local-only" }, () => {
  test.describe.configure({ mode: "serial" });
  test.beforeAll(() => { if (!QA_PASS) throw new Error("APL-2669: set SHO_QA_PASS (the password of the nakul17+zz aliases)."); });

  let lead: APIRequestContext;
  let worker: APIRequestContext;
  let outsider: APIRequestContext;
  let projectId: string;
  let taskId: string;
  const people: Person[] = [];
  let leadName = "";

  test.beforeAll(async () => {
    const leader = await signUp("lead");
    const editor = await signUp("worker");
    const stranger = await signUp("outsider");
    people.push(leader, editor, stranger);
    leadName = leader.name;
    lead = leader.api;
    worker = editor.api;
    outsider = stranger.api;
    const created = await lead.post("/api/projects", { data: { name: `ZZ-TEST APL-2669 ${RUN}`, leaderId: leader.id } });
    expect(created.status()).toBe(201);
    projectId = (await created.json()).project.id as string;
    expect((await lead.post(`/api/projects/${projectId}/members`, { data: { userId: editor.id, role: "EDITOR" } })).status()).toBe(201);
    const made = await lead.post(`/api/projects/${projectId}/tasks`, { data: { title: "Original" } });
    expect(made.status()).toBe(201);
    taskId = (await made.json()).task.id as string;
  });

  test.afterAll(async () => {
    if (people.length) await cleanUp(projectId ? [projectId] : [], people);
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

  test("AC1 an invalid or empty expectedUpdatedAt is 400 invalid_version (qa:TC-APL2669-0a0899e4@v4) (qa:TC-APL2669-6d7d7c6a@v4) (qa:TC-APL2669-0a13b349@v2)", async () => {
    const before = await taskNow();
    const rows = await updatedCount();
    for (const expectedUpdatedAt of MALFORMED) {
      const r = await worker.patch(`/api/tasks/${taskId}`, { data: { title: "New", expectedUpdatedAt } });
      const body = await r.json();
      expect(r.status(), JSON.stringify({ expectedUpdatedAt, body })).toBe(400);
      expect(body).toEqual({
        error: { code: "invalid_version", message: "expectedUpdatedAt must be a full ISO 8601 date-time with a time and a zone." },
      });
    }
    expect(await taskNow()).toEqual(before);
    expect(await updatedCount()).toBe(rows);
  });

  test("AC2 a valid timestamp that is not current is 409 version_conflict (qa:TC-APL2669-6219e8a1@v4)", async () => {
    const before = await taskNow();
    const t0 = Date.parse(before.updatedAt);
    for (const expectedUpdatedAt of [new Date(t0 - 1000).toISOString(), new Date(t0 + 1000).toISOString()]) {
      const r = await worker.patch(`/api/tasks/${taskId}`, { data: { title: "New", expectedUpdatedAt } });
      const body = await r.json();
      expect(r.status()).toBe(409);
      expect(body).toEqual({ error: { code: "version_conflict", message: `${leadName} changed this task while you were editing it.` } });
      expect(await taskNow()).toEqual(before);
    }
  });

  test("AC4 a user who cannot see the task gets the same 404 Task not found as a missing id, before the timestamp is checked (qa:TC-APL2669-d26a2659@v4)", async () => {
    const before = await taskNow();
    const hidden = await outsider.patch(`/api/tasks/${taskId}`, { data: { expectedUpdatedAt: "abc" } });
    const current = await outsider.patch(`/api/tasks/${taskId}`, { data: { expectedUpdatedAt: before.updatedAt } });
    const missing = await outsider.patch("/api/tasks/does-not-exist", { data: { expectedUpdatedAt: "abc" } });
    expect([hidden.status(), current.status(), missing.status()]).toEqual([404, 404, 404]);
    const missingText = await missing.text();
    expect(JSON.parse(missingText)).toEqual({ error: "Task not found" });
    // F8: byte-identical to the missing-id body, so no task id leaks.
    expect(await hidden.text()).toBe(missingText);
    expect(await current.text()).toBe(missingText);
    expect(await taskNow()).toEqual(before);
  });

  test("AC5 the same instant succeeds as Z or as an offset (qa:TC-APL2669-efd03389@v1)", async () => {
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

  test("AC3 the current timestamp saves and updatedAt moves forward (qa:TC-APL2669-6d6dc297@v4)", async () => {
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
