// APL-2670 v1.3: a missing expectedUpdatedAt is one body on every task mutation.
// Absent and null are 400 version_required. "" and "abc" are 400 invalid_version.
// A stale instant is 409 version_conflict. Each of those bodies is exactly { error: { code, message } }.
// An outsider PATCH on a hidden task is not a version error: it is the missing-task 404 { error: "Task not found" } (F8).
// T0 is the task's real updatedAt, read back after a save through the API. No test writes the database.
import { describe, expect, it } from "vitest";
import { account, BASE, project, task, type Account } from "./helpers";

const REQUIRED = { error: { code: "version_required", message: "expectedUpdatedAt is required" } };
const INVALID = { error: { code: "invalid_version", message: "expectedUpdatedAt must be a full ISO 8601 date-time with a time and a zone." } };
const CONFLICT = { error: { code: "version_conflict", message: "Lead changed this task while you were editing it." } };

describe("one error shape for a task version (APL-2670)", () => {
  async function fixture() {
    const lead = await account("lead");
    const worker = await account("worker");
    const outsider = await account("outsider");
    const p = await project(lead, lead, [{ who: worker }]);
    const id = await task(lead, p.id, { title: "Original" });
    // T0 is whatever the create saved, read back through the API.
    const t0 = (await shown(worker, id)).updatedAt;
    return { lead, worker, outsider, id, sectionId: p.doing, t0 };
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
});
