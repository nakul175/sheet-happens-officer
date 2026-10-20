// APL-2669 v1.3: expectedUpdatedAt stays an ISO timestamp.
// Anything that is not a full ISO 8601 date-time with a time and a zone is 400 invalid_version.
// A different instant is 409 version_conflict. The same instant saves.
// Someone who cannot see the task gets the missing-task answer, 404 { error: "Task not found" },
// before the timestamp is looked at (F8, Dwight): the two bodies are byte-identical.
// T0 is the task's real updatedAt, read back after a save through the API. No test writes the database.
import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { classifyExpectedUpdatedAt } from "@/lib/task-version";
import { ApiError } from "@/lib/http";
import { account, BASE, project, task, type Account } from "./helpers";

/** +05:30 wall clock for the same instant. */
function plus0530(iso: string) {
  return new Date(Date.parse(iso) + 5.5 * 3600_000).toISOString().replace(/Z$/, "+05:30");
}

const T0 = "2026-10-18T10:00:00.000Z"; // unit tests of the parser only
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
  it("qa:TC missing APL-2669 AC3 AC5 (parser): a full ISO date-time, with Z, an offset or no fraction, is read as one instant", () => {
    const instant = Date.parse(T0);
    expect(classifyExpectedUpdatedAt(T0)).toBe(instant);
    expect(classifyExpectedUpdatedAt("2026-10-18T10:00:00Z")).toBe(instant);
    expect(classifyExpectedUpdatedAt("2026-10-18T15:30:00.000+05:30")).toBe(instant);
  });

  it("qa:TC missing APL-2669 AC1 (parser): an invalid or empty timestamp throws 400 invalid_version", () => {
    for (const v of MALFORMED) {
      expect(() => classifyExpectedUpdatedAt(v)).toThrowError(
        expect.objectContaining({ status: 400, code: "invalid_version" }),
      );
    }
  });

  it("qa:TC missing APL-2670 AC1 (parser): a missing or null timestamp throws 400 version_required", () => {
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
    // T0 is whatever the create saved, read back through the API.
    const t0 = (await shown(worker, id)).updatedAt;
    return { lead, worker, outsider, id, projectId: p.id, t0 };
  }

  async function shown(worker: Account, id: string) {
    const row = (await worker.c.get(`/api/tasks/${id}`)).json.task as { title: string; updatedAt: string; blocked: boolean };
    return { title: row.title, updatedAt: row.updatedAt };
  }

  const updatedRows = (id: string) =>
    db.actionLog.count({ where: { targetType: "task", targetId: id, action: "task.updated" } });

  it("AC1: an invalid or empty expectedUpdatedAt is 400 invalid_version and writes nothing (qa:TC-APL2669-0a0899e4@v4) (qa:TC-APL2669-6d7d7c6a@v4) (qa:TC-APL2669-0a13b349@v2)", async () => {
    const { worker, id, t0 } = await fixture();
    const rows = await updatedRows(id);
    for (const expectedUpdatedAt of MALFORMED) {
      const r = await worker.c.patch(`/api/tasks/${id}`, { title: "New", expectedUpdatedAt });
      expect(r.status, JSON.stringify({ expectedUpdatedAt, body: r.json })).toBe(400);
      expect(r.json).toEqual({
        error: { code: "invalid_version", message: "expectedUpdatedAt must be a full ISO 8601 date-time with a time and a zone." },
      });
    }
    expect(await shown(worker, id)).toEqual({ title: "Original", updatedAt: t0 });
    expect(await updatedRows(id)).toBe(rows);
  });

  it("AC2: a valid timestamp that is not the current instant is 409 version_conflict (qa:TC-APL2669-6219e8a1@v4)", async () => {
    const { worker, id, t0 } = await fixture();
    const ms = Date.parse(t0);
    for (const expectedUpdatedAt of [new Date(ms - 1000).toISOString(), new Date(ms + 1000).toISOString()]) {
      const r = await worker.c.patch(`/api/tasks/${id}`, { title: "New", expectedUpdatedAt });
      expect(r.status).toBe(409);
      expect(r.json).toEqual({
        error: { code: "version_conflict", message: "Lead changed this task while you were editing it." },
      });
      expect(await shown(worker, id)).toEqual({ title: "Original", updatedAt: t0 });
    }
  });

  it("AC3: the current timestamp saves and updatedAt moves forward (qa:TC-APL2669-6d6dc297@v4)", async () => {
    const { worker, id, t0 } = await fixture();
    const rows = await updatedRows(id);
    const r = await worker.c.patch(`/api/tasks/${id}`, { title: "New", expectedUpdatedAt: t0 });
    expect(r.status).toBe(200);
    expect(r.json.task.title).toBe("New");
    expect(Date.parse(r.json.task.updatedAt)).toBeGreaterThan(Date.parse(t0));
    expect((await shown(worker, id)).title).toBe("New");
    expect(await updatedRows(id)).toBe(rows + 1);
  });

  it("AC4: a user who cannot see the task gets the same 404 Task not found as a missing id, before the timestamp is checked (qa:TC-APL2669-d26a2659@v4)", async () => {
    const { worker, outsider, id, t0 } = await fixture();
    const raw = (path: string, expectedUpdatedAt: string) =>
      fetch(BASE + path, { method: "PATCH", headers: { "content-type": "application/json", cookie: outsider.c.cookie }, body: JSON.stringify({ title: "New", expectedUpdatedAt }) });
    const hidden = await raw(`/api/tasks/${id}`, "abc");
    const current = await raw(`/api/tasks/${id}`, t0);
    const missing = await raw("/api/tasks/does-not-exist", "abc");
    const [hiddenText, currentText, missingText] = await Promise.all([hidden.text(), current.text(), missing.text()]);
    expect([hidden.status, current.status, missing.status]).toEqual([404, 404, 404]);
    expect(JSON.parse(missingText)).toEqual({ error: "Task not found" });
    // F8: byte-identical bodies, so an outsider cannot tell a hidden task from a missing one.
    expect(hiddenText).toBe(missingText);
    expect(currentText).toBe(missingText);
    expect(await shown(worker, id)).toEqual({ title: "Original", updatedAt: t0 });
    expect(await updatedRows(id)).toBe(0);
  });

  it("AC5: the same instant succeeds with Z or an offset, and a no-fraction form is compared as an instant (qa:TC-APL2669-efd03389@v1)", async () => {
    const { worker, id } = await fixture();
    const forms: Array<(iso: string) => string> = [(iso) => iso, plus0530, (iso) => iso.replace(/Z$/, "+00:00")];
    for (const [i, form] of forms.entries()) {
      const t0 = (await shown(worker, id)).updatedAt;
      const r = await worker.c.patch(`/api/tasks/${id}`, { title: `New ${i}`, expectedUpdatedAt: form(t0) });
      expect(r.status, JSON.stringify({ expectedUpdatedAt: form(t0), body: r.json })).toBe(200);
      expect(Date.parse(r.json.task.updatedAt)).toBeGreaterThan(Date.parse(t0));
    }
    // Without the fraction the string names the whole second. A live updatedAt carries milliseconds the API
    // cannot choose, so this is the same instant only when they are .000; otherwise it is a different instant.
    // The parser test above covers the .000 case exactly.
    const t0 = (await shown(worker, id)).updatedAt;
    const whole = t0.replace(/\.\d{3}Z$/, "Z");
    const r = await worker.c.patch(`/api/tasks/${id}`, { title: "Whole", expectedUpdatedAt: whole });
    expect(r.status).toBe(Date.parse(whole) === Date.parse(t0) ? 200 : 409);
  });

  it("qa:TC missing APL-2670 AC1 v1.4 (Pam D2): a Blocked-only body gets no exemption: null is version_required, other bad values invalid_version, absent version_required", async () => {
    const { worker, id, t0 } = await fixture();
    const blockedNow = async () => ((await worker.c.get(`/api/tasks/${id}`)).json.task as { blocked: boolean }).blocked;
    const required = await worker.c.patch(`/api/tasks/${id}`, { blocked: true, expectedUpdatedAt: null });
    expect(required.status).toBe(400);
    expect(required.json).toEqual({ error: { code: "version_required", message: "expectedUpdatedAt is required" } });
    for (const expectedUpdatedAt of ["", 1760781600000, true, {}]) {
      const r = await worker.c.patch(`/api/tasks/${id}`, { blocked: true, expectedUpdatedAt });
      expect(r.status, JSON.stringify({ expectedUpdatedAt, body: r.json })).toBe(400);
      expect(r.json).toEqual({
        error: { code: "invalid_version", message: "expectedUpdatedAt must be a full ISO 8601 date-time with a time and a zone." },
      });
    }
    expect(await blockedNow()).toBe(false);
    expect((await shown(worker, id)).updatedAt).toBe(t0);
    // Absent is not stamped either (APL-2670 AC1 v1.4): 400 version_required, and nothing is saved.
    const absent = await worker.c.patch(`/api/tasks/${id}`, { blocked: true });
    expect(absent.status).toBe(400);
    expect(absent.json).toEqual({ error: { code: "version_required", message: "expectedUpdatedAt is required" } });
    expect(await blockedNow()).toBe(false);
    // With the current version it saves.
    const saved = await worker.c.patch(`/api/tasks/${id}`, { blocked: true, expectedUpdatedAt: t0 });
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    expect(await blockedNow()).toBe(true);
  });
});
