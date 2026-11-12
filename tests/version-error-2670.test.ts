// APL-2670 v1.3: a missing expectedUpdatedAt is one body on every task mutation.
// Absent and null are 400 version_required. "" and "abc" are 400 invalid_version.
// A stale instant is 409 version_conflict. Each of those bodies is exactly { error: { code, message } }.
// An outsider PATCH on a hidden task is not a version error: it is the missing-task 404 { error: "Task not found" } (F8).
// T0 is the task's real updatedAt, read back after a save through the API. No test writes the database.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { account, BASE, OUTBOX, project, task, type Account } from "./helpers";
import { assertLocalFixture } from "./e2e/local-fixture-guard";

const REQUIRED = { error: { code: "version_required", message: "expectedUpdatedAt is required" } };
const INVALID = { error: { code: "invalid_version", message: "expectedUpdatedAt must be a full ISO 8601 date-time with a time and a zone." } };
const CONFLICT = { error: { code: "version_conflict", message: "Lead changed this task while you were editing it." } };
const runId = randomUUID();
const people: Account[] = [];
const projectIds: string[] = [];
const taskIds: string[] = [];
let sequence = 0;
let safe = false;

afterAll(async () => {
  if (!safe) return;
  let cleanup = false;
  try {
    const discoveredPeople = await db.user.findMany({ where: { email: { startsWith: `nakul17+v2670-${runId}-` } }, select: { id: true, email: true } });
    const discoveredProjects = await db.project.findMany({ where: { name: { startsWith: `ZZ-TEST v2670 ${runId}-` } }, select: { id: true } });
    const userIds = [...new Set([...people.map((person) => person.id), ...discoveredPeople.map((person) => person.id)])];
    const emails = [...new Set([...people.map((person) => person.email), ...discoveredPeople.map((person) => person.email)])];
    const ownedProjectIds = [...new Set([...projectIds, ...discoveredProjects.map((project) => project.id)])];
    await db.notification.deleteMany({ where: { projectId: { in: ownedProjectIds } } });
    await db.actionLog.deleteMany({ where: { projectId: { in: ownedProjectIds } } });
    await db.project.deleteMany({ where: { id: { in: ownedProjectIds } } });
    await db.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
    await db.loginAttempt.deleteMany({ where: { email: { in: emails } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    for (const name of readdirSync(OUTBOX)) {
      if (!name.endsWith(".json")) continue;
      const path = resolve(OUTBOX, name);
      const mail = JSON.parse(readFileSync(path, "utf8")) as { to?: string };
      if (mail.to && emails.includes(mail.to)) rmSync(path);
    }
    expect(await db.task.count({ where: { id: { in: taskIds } } })).toBe(0);
    expect(await db.task.count({ where: { projectId: { in: ownedProjectIds } } })).toBe(0);
    expect(await db.project.count({ where: { id: { in: ownedProjectIds } } })).toBe(0);
    expect(await db.user.count({ where: { id: { in: userIds } } })).toBe(0);
    cleanup = true;
  } finally {
    mkdirSync("test-results/version-error-2670", { recursive: true });
    writeFileSync("test-results/version-error-2670/cleanup.json", JSON.stringify({ fixture: runId, scope: "disposable-local-sho-test", tasks: taskIds.length, projects: projectIds.length, people: people.length, cleanup }, null, 2));
  }
});

describe("one error shape for a task version (APL-2670)", () => {
  async function fixture() {
    assertLocalFixture(process.env.DATABASE_URL, BASE);
    if (!resolve(OUTBOX).startsWith(resolve(process.cwd()) + sep)) throw new Error("PRIVATE_CHECKOUT_OUTBOX_REQUIRED");
    safe = true;
    const n = sequence++;
    const person = async (role: string) => {
      const who = await account(role, `nakul17+v2670-${runId}-${role}-${n}@aplyd.com`);
      people.push(who);
      return who;
    };
    const lead = await person("lead");
    const worker = await person("worker");
    const outsider = await person("outsider");
    const p = await project(lead, lead, [{ who: worker }], `ZZ-TEST v2670 ${runId}-${n}`);
    projectIds.push(p.id);
    const id = await task(lead, p.id, { title: "Original" });
    taskIds.push(id);
    // T0 is whatever the create saved, read back through the API.
    const t0 = (await shown(worker, id)).updatedAt;
    return { lead, worker, outsider, id, sectionId: p.doing, t0 };
  }

  async function effects(id: string) {
    return {
      task: await db.task.findUnique({ where: { id }, select: { title: true, assigneeId: true, approverId: true, sectionId: true, updatedAt: true } }),
      actionIds: (await db.actionLog.findMany({ where: { targetType: "task", targetId: id }, select: { id: true }, orderBy: { id: "asc" } })).map((row) => row.id),
      notificationIds: (await db.notification.findMany({ where: { taskId: id }, select: { id: true }, orderBy: { id: "asc" } })).map((row) => row.id),
      auditIds: (await db.auditLog.findMany({ where: { targetId: id }, select: { id: true }, orderBy: { id: "asc" } })).map((row) => row.id),
    };
  }

  async function shown(worker: Account, id: string) {
    const row = (await worker.c.get(`/api/tasks/${id}`)).json.task as { title: string; updatedAt: string };
    return { title: row.title, updatedAt: row.updatedAt };
  }

  function send(
    worker: Awaited<ReturnType<typeof fixture>>["worker"],
    id: string,
    sectionId: string,
    route: "edit" | "assign" | "move" | "complete" | "approver",
    body: Record<string, unknown>,
  ) {
    if (route === "edit") return worker.c.patch(`/api/tasks/${id}`, body);
    if (route === "assign") return worker.c.post(`/api/tasks/${id}/assign`, { assigneeId: worker.id, ...body });
    if (route === "move") return worker.c.post(`/api/tasks/${id}/move`, { sectionId, ...body });
    if (route === "complete") return worker.c.post(`/api/tasks/${id}/complete`, body);
    return worker.c.put(`/api/tasks/${id}/approver`, { approverId: worker.id, ...body });
  }

  it("AC1: absent or null expectedUpdatedAt is 400 version_required on every mutation (qa:TC-APL2670-273d7fb3@v4) (qa:TC-APL2670-247d44cc@v4)", async () => {
    const fx = await fixture();
    const cases: Array<["edit" | "assign" | "move" | "complete" | "approver", Record<string, unknown>]> = [
      ["edit", { title: "New" }],
      ["edit", { title: "New", expectedUpdatedAt: null }],
      ["assign", {}],
      ["assign", { expectedUpdatedAt: null }],
      ["move", {}],
      ["complete", {}],
      ["approver", {}],
    ];
    for (const [route, body] of cases) {
      const r = await send(fx.worker, fx.id, fx.sectionId, route, body);
      expect(r.status, JSON.stringify({ route, body, json: r.json })).toBe(400);
      expect(r.json).toEqual(REQUIRED);
      expect(Object.keys(r.json)).toEqual(["error"]);
      expect(Object.keys(r.json.error)).toEqual(["code", "message"]);
    }
    expect(await shown(fx.worker, fx.id)).toEqual({ title: "Original", updatedAt: fx.t0 });
  });

  it("AC2: an empty or non-ISO value is invalid_version, not version_required (qa:TC-APL2670-7de488a3@v3)", async () => {
    const fx = await fixture();
    for (const expectedUpdatedAt of ["", "abc"]) {
      const r = await fx.worker.c.patch(`/api/tasks/${fx.id}`, { title: "New", expectedUpdatedAt });
      expect(r.status).toBe(400);
      expect(r.json).toEqual(INVALID);
    }
    expect(await shown(fx.worker, fx.id)).toEqual({ title: "Original", updatedAt: fx.t0 });
  });

  it("AC3: missing, malformed and stale share one structure, and a hidden task gets the same 404 Task not found as a missing id (qa:TC-APL2670-2da9e2aa@v4)", async () => {
    const fx = await fixture();
    const missing = await fx.worker.c.patch(`/api/tasks/${fx.id}`, { title: "New" });
    const malformed = await fx.worker.c.patch(`/api/tasks/${fx.id}`, { title: "New", expectedUpdatedAt: "abc" });
    const stale = await fx.worker.c.patch(`/api/tasks/${fx.id}`, { title: "New", expectedUpdatedAt: new Date(Date.parse(fx.t0) - 1000).toISOString() });
    const raw = (path: string) =>
      fetch(BASE + path, { method: "PATCH", headers: { "content-type": "application/json", cookie: fx.outsider.c.cookie }, body: JSON.stringify({ title: "New", expectedUpdatedAt: "abc" }) });
    const hidden = await raw(`/api/tasks/${fx.id}`);
    const missingId = await raw("/api/tasks/does-not-exist");
    expect(missing.status).toBe(400);
    expect(malformed.status).toBe(400);
    expect(stale.status).toBe(409);
    expect(hidden.status).toBe(404);
    expect(missingId.status).toBe(404);
    expect(missing.json).toEqual(REQUIRED);
    expect(malformed.json).toEqual(INVALID);
    expect(stale.json).toEqual(CONFLICT);
    const [hiddenText, missingText] = await Promise.all([hidden.text(), missingId.text()]);
    expect(JSON.parse(missingText)).toEqual({ error: "Task not found" });
    expect(hiddenText).toBe(missingText); // F8: byte-identical
    for (const body of [missing.json, malformed.json, stale.json]) {
      expect(Object.keys(body)).toEqual(["error"]);
      expect(Object.keys(body.error).sort()).toEqual(["code", "message"]);
    }
    expect(await shown(fx.worker, fx.id)).toEqual({ title: "Original", updatedAt: fx.t0 });
  });

  it("qa:TC missing APL-2670 AC3 F8: on assign, move, complete and approver an outsider with a valid body gets the same 404 bytes as a missing id", async () => {
    const fx = await fixture();
    const valid = {
      assign: { assigneeId: fx.worker.id, expectedUpdatedAt: fx.t0 },
      move: { sectionId: fx.sectionId, expectedUpdatedAt: fx.t0 },
      complete: { expectedUpdatedAt: fx.t0 },
      approver: { approverId: fx.worker.id, expectedUpdatedAt: fx.t0 },
    } as const;
    const routes = [
      ["assign", "POST", "assign"],
      ["move", "POST", "move"],
      ["complete", "POST", "complete"],
      ["approver", "PUT", "approver"],
    ] as const;
    const raw = async (method: string, id: string, path: string, body: unknown) => {
      const r = await fetch(`${BASE}/api/tasks/${id}/${path}`, {
        method, headers: { "content-type": "application/json", cookie: fx.outsider.c.cookie }, body: JSON.stringify(body),
      });
      return { status: r.status, text: await r.text() };
    };
    const seen = [];
    for (const [name, method, path] of routes) {
      const hidden = await raw(method, fx.id, path, valid[name]);
      const missingId = await raw(method, "does-not-exist", path, valid[name]);
      seen.push({ name, hidden, missingId, identical: hidden.text === missingId.text });
    }
    const notFound = { status: 404, text: JSON.stringify({ error: "Task not found" }) };
    // F8: every route answers an outsider with exactly the bytes it gives for a missing id.
    expect(seen).toEqual(routes.map(([name]) => ({ name, hidden: notFound, missingId: notFound, identical: true })));
    expect(await shown(fx.worker, fx.id)).toEqual({ title: "Original", updatedAt: fx.t0 });
  });

  it("qa:TC missing APL-2670 AC1 v1.4 check order: session, access, version, then schema on all five routes", async () => {
    const fx = await fixture();
    // A bad body with no version is version_required, not "Validation failed".
    const noVersion: Array<[string, Promise<{ status: number; json: unknown }>]> = [
      ["PATCH title \"\"", fx.worker.c.patch(`/api/tasks/${fx.id}`, { title: "" })],
      ["move {}", fx.worker.c.post(`/api/tasks/${fx.id}/move`, {})],
      ["complete completeAll:\"x\"", fx.worker.c.post(`/api/tasks/${fx.id}/complete`, { completeAll: "x" })],
      ["approver {}", fx.worker.c.put(`/api/tasks/${fx.id}/approver`, {})],
      ["assign {}", fx.worker.c.post(`/api/tasks/${fx.id}/assign`, {})],
    ];
    const seen = [];
    for (const [name, call] of noVersion) {
      const r = await call;
      seen.push({ name, status: r.status, json: r.json });
    }
    expect(seen).toEqual(noVersion.map(([name]) => ({ name, status: 400, json: REQUIRED })));
    // Access comes before the version and the schema: an outsider's bad move is the missing-task 404.
    const outsiderMove = await fetch(`${BASE}/api/tasks/${fx.id}/move`, {
      method: "POST", headers: { "content-type": "application/json", cookie: fx.outsider.c.cookie }, body: "{}",
    });
    expect(outsiderMove.status).toBe(404);
    expect(await outsiderMove.text()).toBe(JSON.stringify({ error: "Task not found" }));
    expect(await shown(fx.worker, fx.id)).toEqual({ title: "Original", updatedAt: fx.t0 });
  });

  it("keeps session, access and version ahead of invalid schemas on every task mutation", async () => {
    const fx = await fixture();
    const beforeEffects = await effects(fx.id);
    const routes = [
      ["PATCH", "", { title: "" }, { title: "New" }],
      ["POST", "/assign", { assigneeId: "" }, { assigneeId: fx.worker.id }],
      ["POST", "/move", { sectionId: "" }, { sectionId: fx.sectionId }],
      ["POST", "/complete", { completeAll: "invalid" }, {}],
      ["PUT", "/approver", { approverId: "" }, { approverId: fx.worker.id }],
    ] as const;
    const raw = async (method: string, id: string, suffix: string, body: unknown, cookie = "") => {
      const response = await fetch(`${BASE}/api/tasks/${id}${suffix}`, {
        method,
        headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(body),
      });
      return { status: response.status, text: await response.text() };
    };
    for (const [method, suffix, invalidSchema, validSchema] of routes) {
      const path = `${method} ${suffix || "/"}`;
      const anonymous = await raw(method, fx.id, suffix, invalidSchema);
      expect(anonymous, path).toEqual({ status: 401, text: JSON.stringify({ error: "Not signed in" }) });

      const hidden = await raw(method, fx.id, suffix, invalidSchema, fx.outsider.c.cookie);
      const absent = await raw(method, "does-not-exist", suffix, invalidSchema, fx.outsider.c.cookie);
      expect(hidden, path).toEqual({ status: 404, text: JSON.stringify({ error: "Task not found" }) });
      expect(hidden, path).toEqual(absent);

      for (const [version, expectedStatus, expectedBody] of [
        [undefined, 400, REQUIRED],
        [null, 400, REQUIRED],
        ["abc", 400, INVALID],
      ] as const) {
        const body = { ...invalidSchema, ...(version === undefined ? {} : { expectedUpdatedAt: version }) };
        const result = await raw(method, fx.id, suffix, body, fx.worker.c.cookie);
        expect(result, `${path} ${String(version)}`).toEqual({ status: expectedStatus, text: JSON.stringify(expectedBody) });
      }
      // A stale instant is compared by the service after schema validation.
      const stale = new Date(Date.parse(fx.t0) - 1000).toISOString();
      const mixed = await raw(method, fx.id, suffix, { ...invalidSchema, expectedUpdatedAt: stale }, fx.worker.c.cookie);
      expect(mixed.status, `${path} stale version with invalid body`).toBe(400);
      const mixedBody = JSON.parse(mixed.text) as { error?: string; issues?: { path: unknown[] }[] };
      expect(mixedBody.error).toBe("Validation failed");
      expect(mixedBody.issues?.length).toBeGreaterThan(0);
      expect(mixedBody.issues?.some((issue) => issue.path[0] !== "expectedUpdatedAt")).toBe(true);
      const result = await raw(method, fx.id, suffix, { ...validSchema, expectedUpdatedAt: stale }, fx.lead.c.cookie);
      expect(result, `${path} stale valid body`).toEqual({ status: 409, text: JSON.stringify(CONFLICT) });
    }
    expect(await shown(fx.worker, fx.id)).toEqual({ title: "Original", updatedAt: fx.t0 });
    expect(await effects(fx.id)).toEqual(beforeEffects);
  });
});
