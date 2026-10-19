// APL-2669 v1.3: expectedUpdatedAt stays an ISO timestamp.
// Anything that is not a full ISO 8601 date-time with a time and a zone is 400 invalid_version.
// A different instant is 409 version_conflict. The same instant saves.
// Someone who cannot see the task gets 404 { error: "Project not found" } before the timestamp is looked at.
import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { classifyExpectedUpdatedAt } from "@/lib/task-version";
import { ApiError } from "@/lib/http";
import { account, project, task } from "./helpers";

const T0 = "2026-10-18T10:00:00.000Z";
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

describe("classifyExpectedUpdatedAt (APL-2669)", () => {
  it("accepts a full ISO date-time and compares it as an instant (qa:TC missing)", () => {
    const instant = Date.parse(T0);
    expect(classifyExpectedUpdatedAt(T0)).toBe(instant);
    expect(classifyExpectedUpdatedAt("2026-10-18T10:00:00Z")).toBe(instant);
    expect(classifyExpectedUpdatedAt("2026-10-18T15:30:00.000+05:30")).toBe(instant);
  });

  it("refuses an invalid timestamp and an empty one with 400 invalid_version (qa:TC missing)", () => {
    for (const v of MALFORMED) {
      expect(() => classifyExpectedUpdatedAt(v)).toThrowError(
        expect.objectContaining({ status: 400, code: "invalid_version" }),
      );
    }
  });

  it("refuses a missing or null timestamp with 400 version_required (qa:TC missing)", () => {
    for (const v of [undefined, null]) {
      try {
        classifyExpectedUpdatedAt(v);
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(ApiError);
        expect((e as ApiError).status).toBe(400);
        expect((e as ApiError).code).toBe("version_required");
        expect((e as ApiError).message).toBe("expectedUpdatedAt is required");
      }
    }
  });
});

describe("PATCH /api/tasks/:id expectedUpdatedAt (APL-2669)", () => {
  async function fixture() {
    const lead = await account("lead");
    const worker = await account("worker");
    const outsider = await account("outsider");
    const p = await project(lead, lead, [{ who: worker }]);
    const id = await task(lead, p.id, { title: "Original" });
    await db.task.update({ where: { id }, data: { updatedAt: new Date(T0) } });
    return { lead, worker, outsider, id, projectId: p.id };
  }

  const shown = async (worker: Awaited<ReturnType<typeof fixture>>["worker"], id: string) => {
    const row = (await worker.c.get(`/api/tasks/${id}`)).json.task as { title: string; updatedAt: string };
    return { title: row.title, updatedAt: row.updatedAt };
  };

  const updatedRows = (id: string) =>
    db.actionLog.count({ where: { targetType: "task", targetId: id, action: "task.updated" } });

  it("AC1: an invalid or empty expectedUpdatedAt is 400 invalid_version and writes nothing (qa:TC-APL2669-0a0899e4@v4) (qa:TC-APL2669-6d7d7c6a@v4) (qa:TC-APL2669-0a13b349@v2)", async () => {
    const { worker, id } = await fixture();
    const rows = await updatedRows(id);
    for (const expectedUpdatedAt of MALFORMED) {
      const r = await worker.c.patch(`/api/tasks/${id}`, { title: "New", expectedUpdatedAt });
      expect(r.status, JSON.stringify({ expectedUpdatedAt, body: r.json })).toBe(400);
      expect(r.json).toEqual({
        error: { code: "invalid_version", message: "expectedUpdatedAt must be a full ISO 8601 date-time with a time and a zone." },
      });
    }
    expect(await shown(worker, id)).toEqual({ title: "Original", updatedAt: T0 });
    expect(await updatedRows(id)).toBe(rows);
  });

  it("AC2: a valid timestamp that is not the current instant is 409 version_conflict (qa:TC-APL2669-6219e8a1@v4)", async () => {
    const { worker, id } = await fixture();
    for (const expectedUpdatedAt of ["2026-10-18T09:59:59.000Z", "2026-10-18T10:00:01.000Z"]) {
      const r = await worker.c.patch(`/api/tasks/${id}`, { title: "New", expectedUpdatedAt });
      expect(r.status).toBe(409);
      expect(r.json).toEqual({
        error: { code: "version_conflict", message: "Lead changed this task while you were editing it." },
      });
      expect(await shown(worker, id)).toEqual({ title: "Original", updatedAt: T0 });
    }
  });

  it("AC3: the current timestamp saves and updatedAt moves forward (qa:TC-APL2669-6d6dc297@v4)", async () => {
    const { worker, id } = await fixture();
    const rows = await updatedRows(id);
    const r = await worker.c.patch(`/api/tasks/${id}`, { title: "New", expectedUpdatedAt: T0 });
    expect(r.status).toBe(200);
    expect(r.json.task.title).toBe("New");
    expect(Date.parse(r.json.task.updatedAt)).toBeGreaterThan(Date.parse(T0));
    expect((await shown(worker, id)).title).toBe("New");
    expect(await updatedRows(id)).toBe(rows + 1);
  });

  it("AC4: a user who cannot see the task gets 404 Project not found before the timestamp is checked (qa:TC-APL2669-d26a2659@v4)", async () => {
    const { worker, outsider, id } = await fixture();
    const hidden = await outsider.c.patch(`/api/tasks/${id}`, { title: "New", expectedUpdatedAt: "abc" });
    const current = await outsider.c.patch(`/api/tasks/${id}`, { title: "New", expectedUpdatedAt: T0 });
    const missing = await outsider.c.patch("/api/tasks/does-not-exist", { title: "New", expectedUpdatedAt: "abc" });
    expect(hidden.status).toBe(404);
    expect(current.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(hidden.json).toEqual({ error: "Project not found" });
    expect(current.json).toEqual({ error: "Project not found" });
    expect(missing.json).toEqual({ error: { code: "not_found", message: "Task not found" } });
    expect(JSON.stringify(hidden.json)).not.toMatch(/Original|invalid_version|version_conflict|does-not-exist/);
    expect(await shown(worker, id)).toEqual({ title: "Original", updatedAt: T0 });
    expect(await updatedRows(id)).toBe(0);
  });

  it("AC5: the same instant succeeds with Z, an offset, or no fractional seconds (qa:TC-APL2669-efd03389@v1)", async () => {
    const { worker, id } = await fixture();
    for (const expectedUpdatedAt of [T0, "2026-10-18T15:30:00.000+05:30", "2026-10-18T10:00:00Z"]) {
      await db.task.update({ where: { id }, data: { title: "Original", updatedAt: new Date(T0) } });
      const r = await worker.c.patch(`/api/tasks/${id}`, { title: "New", expectedUpdatedAt });
      expect(r.status, JSON.stringify({ expectedUpdatedAt, body: r.json })).toBe(200);
      expect(r.json.task.title).toBe("New");
      expect(Date.parse(r.json.task.updatedAt)).toBeGreaterThan(Date.parse(T0));
    }
  });
});
