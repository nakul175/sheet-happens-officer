// APL-2670 v1.3: a missing expectedUpdatedAt is one body on every task mutation.
// Absent and null are 400 version_required. "" and "abc" are 400 invalid_version.
// A stale instant is 409 version_conflict. An outsider PATCH on a hidden task is 404 { error: "Project not found" }.
// Each body is exactly { error: { code, message } }.
import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { account, project, task } from "./helpers";

const T0 = "2026-10-18T10:00:00.000Z";
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
    await db.task.update({ where: { id }, data: { updatedAt: new Date(T0) } });
    return { lead, worker, outsider, id, sectionId: p.doing };
  }

  const shown = async (worker: Awaited<ReturnType<typeof fixture>>["worker"], id: string) => {
    const row = (await worker.c.get(`/api/tasks/${id}`)).json.task as { title: string; updatedAt: string };
    return { title: row.title, updatedAt: row.updatedAt };
  };

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
    expect(await shown(fx.worker, fx.id)).toEqual({ title: "Original", updatedAt: T0 });
  });

  it("AC2: an empty or non-ISO value is invalid_version, not version_required (qa:TC-APL2670-7de488a3@v3)", async () => {
    const fx = await fixture();
    for (const expectedUpdatedAt of ["", "abc"]) {
      const r = await fx.worker.c.patch(`/api/tasks/${fx.id}`, { title: "New", expectedUpdatedAt });
      expect(r.status).toBe(400);
      expect(r.json).toEqual(INVALID);
    }
    expect(await shown(fx.worker, fx.id)).toEqual({ title: "Original", updatedAt: T0 });
  });

  it("AC3: missing, malformed and stale share one structure, and a hidden task is Project not found (qa:TC-APL2670-2da9e2aa@v4)", async () => {
    const fx = await fixture();
    const missing = await fx.worker.c.patch(`/api/tasks/${fx.id}`, { title: "New" });
    const malformed = await fx.worker.c.patch(`/api/tasks/${fx.id}`, { title: "New", expectedUpdatedAt: "abc" });
    const stale = await fx.worker.c.patch(`/api/tasks/${fx.id}`, { title: "New", expectedUpdatedAt: "2026-10-18T09:59:59.000Z" });
    const hidden = await fx.outsider.c.patch(`/api/tasks/${fx.id}`, { title: "New", expectedUpdatedAt: "abc" });
    expect(missing.status).toBe(400);
    expect(malformed.status).toBe(400);
    expect(stale.status).toBe(409);
    expect(hidden.status).toBe(404);
    expect(missing.json).toEqual(REQUIRED);
    expect(malformed.json).toEqual(INVALID);
    expect(stale.json).toEqual(CONFLICT);
    expect(hidden.json).toEqual({ error: "Project not found" });
    for (const body of [missing.json, malformed.json, stale.json]) {
      expect(Object.keys(body)).toEqual(["error"]);
      expect(Object.keys(body.error).sort()).toEqual(["code", "message"]);
    }
    expect(await shown(fx.worker, fx.id)).toEqual({ title: "Original", updatedAt: T0 });
  });
});
