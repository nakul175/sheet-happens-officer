// APL-2669: a task version that is not a positive integer is 400 invalid_version.
// A different positive integer is 409 version_conflict. The current one saves and becomes the next integer.
// Someone who cannot see the task gets 404 before the version is looked at, with one body for every case.
import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { classifyTaskVersion } from "@/lib/task-version";
import { ApiError } from "@/lib/http";
import { account, project, task, BASE } from "./helpers";

const MALFORMED = ["abc", "", " 3 ", "3", 0, -1, 1.5, true, [], {}] as const;

describe("classifyTaskVersion (APL-2669)", () => {
  it("accepts only a positive integer", () => {
    expect(classifyTaskVersion(1)).toBe(1);
    expect(classifyTaskVersion(3)).toBe(3);
    for (const v of MALFORMED) {
      expect(() => classifyTaskVersion(v)).toThrowError(expect.objectContaining({ status: 400, extra: { code: "invalid_version" } }));
    }
    expect(() => classifyTaskVersion(1e309)).toThrowError(expect.objectContaining({ extra: { code: "invalid_version" } }));
    for (const v of [undefined, null]) {
      expect(() => classifyTaskVersion(v)).toThrowError(expect.objectContaining({ status: 400, extra: { code: "version_required" } }));
    }
  });

  it("does not treat the thrown error as an ApiError of any other status", () => {
    try {
      classifyTaskVersion("abc");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(400);
    }
  });
});

describe("PATCH /api/tasks/:id version (APL-2669)", () => {
  async function fixture() {
    const lead = await account("lead");
    const worker = await account("worker");
    const outsider = await account("outsider");
    const p = await project(lead, lead, [{ who: worker }]);
    const id = await task(lead, p.id, { title: "Original" });
    await db.task.update({ where: { id }, data: { version: 3 } });
    return { worker, outsider, id };
  }

  const shown = async (worker: Awaited<ReturnType<typeof fixture>>["worker"], id: string) => {
    const task = (await worker.c.get(`/api/tasks/${id}`)).json.task as { title: string; version: number };
    return { title: task.title, version: task.version };
  };

  const updatedRows = (id: string) => db.actionLog.count({ where: { targetType: "task", targetId: id, action: "task.updated" } });

  it("a missing or null version is 400 version_required and writes nothing", async () => {
    const { worker, id } = await fixture();
    const rows = await updatedRows(id);
    const absent = await worker.c.patch(`/api/tasks/${id}`, { title: "New" });
    const nil = await worker.c.patch(`/api/tasks/${id}`, { title: "New", version: null });
    expect(absent.status).toBe(400);
    expect(absent.json.code).toBe("version_required");
    expect(nil.status).toBe(400);
    expect(nil.json.code).toBe("version_required");
    expect(await shown(worker, id)).toEqual({ title: "Original", version: 3 });
    expect(await updatedRows(id)).toBe(rows);
  });

  it("AC1: any version that is not a positive integer is 400 invalid_version and writes nothing", async () => {
    const { worker, id } = await fixture();
    const rows = await updatedRows(id);
    for (const v of MALFORMED) {
      const r = await worker.c.patch(`/api/tasks/${id}`, { title: "New", version: v });
      expect(r.status, JSON.stringify({ v, body: r.json })).toBe(400);
      expect(r.json.code).toBe("invalid_version");
    }
    const raw = await fetch(`${BASE}/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: worker.c.cookie },
      body: '{"title":"New","version":1e309}',
    });
    const overflow = await raw.json() as { code?: string };
    expect(raw.status).toBe(400);
    expect(overflow.code).toBe("invalid_version");
    expect(await shown(worker, id)).toEqual({ title: "Original", version: 3 });
    expect(await updatedRows(id)).toBe(rows);
  });

  it("AC2: a well-formed version that is not the current one is 409 version_conflict", async () => {
    const { worker, id } = await fixture();
    for (const v of [2, 4]) {
      const r = await worker.c.patch(`/api/tasks/${id}`, { title: "New", version: v });
      expect(r.status, JSON.stringify(r.json)).toBe(409);
      expect(r.json.code).toBe("version_conflict");
      expect(await shown(worker, id)).toEqual({ title: "Original", version: 3 });
    }
  });

  it("AC3: the current version saves and the task is at the next version", async () => {
    const { worker, id } = await fixture();
    const rows = await updatedRows(id);
    const r = await worker.c.patch(`/api/tasks/${id}`, { title: "New", version: 3 });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.task.title).toBe("New");
    expect(r.json.task.version).toBe(4);
    expect(await shown(worker, id)).toEqual({ title: "New", version: 4 });
    expect(await updatedRows(id)).toBe(rows + 1);
  });

  it("AC4: a user who cannot see the task gets the same 404 before the version is checked", async () => {
    const { worker, outsider, id } = await fixture();
    const hidden = await outsider.c.patch(`/api/tasks/${id}`, { title: "New", version: "abc" });
    const current = await outsider.c.patch(`/api/tasks/${id}`, { title: "New", version: 3 });
    const missing = await outsider.c.patch("/api/tasks/does-not-exist", { title: "New", version: "abc" });
    expect(hidden.status).toBe(404);
    expect(current.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(current.json).toEqual(hidden.json);
    expect(missing.json).toEqual(hidden.json);
    expect(hidden.json).toEqual({ error: "Task not found" });
    expect(JSON.stringify(hidden.json)).not.toMatch(/Original|invalid_version|version_conflict|does-not-exist/);
    expect(await shown(worker, id)).toEqual({ title: "Original", version: 3 });
    expect(await updatedRows(id)).toBe(0);
  });
});
