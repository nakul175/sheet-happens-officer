// APL-2670: a missing task version is one error shape on edit, assign, move, complete and setApprover.
// The version is expectedUpdatedAt (the updatedAt the editor saw). "Unchanged at version 3" means that token does not move.
import { describe, expect, it } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client";
import { account, patchTask, project, task, type Account } from "./helpers";

const db = new PrismaClient();

type Send = (body: Record<string, unknown>) => Promise<{ status: number; json: unknown }>;

function expectVersionError(json: unknown, code: string) {
  expect(json).toEqual({ error: { code, message: expect.any(String) } });
  const body = json as { error: { code: string; message: string } };
  expect(Object.keys(body)).toEqual(["error"]);
  expect(Object.keys(body.error)).toEqual(["code", "message"]);
  expect(body.error.message.length).toBeGreaterThan(0);
}

function sameShape(a: unknown, b: unknown) {
  const keys = (json: unknown) => {
    const body = json as { error: Record<string, unknown> };
    return [Object.keys(body).sort().join(","), Object.keys(body.error).sort().join(",")].join("|");
  };
  expect(keys(a)).toBe("error|code,message");
  expect(keys(a)).toBe(keys(b));
}

describe("missing task version (APL-2670)", () => {
  async function setup() {
    const lead = await account("lead");
    const worker = await account("worker");
    const other = await account("other");
    const p = await project(lead, lead, [{ who: worker }, { who: other }]);
    const t = await task(worker, p.id, { title: "T1", priority: "LOW" });
    const seen = (await worker.c.get(`/api/tasks/${t}`)).json.task;
    return { lead, worker, other, p, t, seen };
  }

  function routes(s: Awaited<ReturnType<typeof setup>>): { name: string; send: Send; fields: Record<string, unknown> }[] {
    return [
      { name: "edit", send: (b) => s.worker.c.patch(`/api/tasks/${s.t}`, b), fields: { title: "New" } },
      { name: "assign", send: (b) => s.worker.c.post(`/api/tasks/${s.t}/assign`, b), fields: { assigneeId: s.other.id } },
      { name: "move", send: (b) => s.worker.c.post(`/api/tasks/${s.t}/move`, b), fields: { sectionId: s.p.doing } },
      { name: "complete", send: (b) => s.worker.c.post(`/api/tasks/${s.t}/complete`, b), fields: {} },
      { name: "setApprover", send: (b) => s.worker.c.put(`/api/tasks/${s.t}/approver`, b), fields: { approverId: s.lead.id } },
    ];
  }

  async function stamp(who: Account, id: string) {
    const row = (await who.c.get(`/api/tasks/${id}`)).json.task;
    return {
      title: row.title as string,
      priority: row.priority as string,
      updatedAt: row.updatedAt as string,
      sectionId: row.section.id as string,
      assigneeId: row.assignee.id as string,
      completedAt: row.completedAt as string | null,
      approverId: (row.approver?.id ?? null) as string | null,
    };
  }

  it("AC1: absent or null version is 400 version_required on every mutation route, and the task stays put", async () => {
    const s = await setup();
    const before = await stamp(s.worker, s.t);
    const logs = await db.actionLog.count({ where: { targetType: "task", targetId: s.t } });
    for (const route of routes(s)) {
      for (const form of ["absent", "null"] as const) {
        const body = form === "absent" ? { ...route.fields } : { ...route.fields, expectedUpdatedAt: null };
        const r = await route.send(body);
        expect(r.status, `${route.name} ${form}`).toBe(400);
        expectVersionError(r.json, "version_required");
        expect((r.json as { error: { message: string } }).error.message).toBe("expectedUpdatedAt is required");
      }
    }
    expect(await stamp(s.worker, s.t)).toEqual(before);
    expect(await db.actionLog.count({ where: { targetType: "task", targetId: s.t } })).toBe(logs);
  });

  it("AC2: an empty-string version on edit is 400 invalid_version and changes nothing", async () => {
    const s = await setup();
    const before = await stamp(s.worker, s.t);
    const logs = await db.actionLog.count({ where: { targetType: "task", targetId: s.t } });
    const r = await s.worker.c.patch(`/api/tasks/${s.t}`, { title: "New", expectedUpdatedAt: "" });
    expect(r.status).toBe(400);
    expectVersionError(r.json, "invalid_version");
    expect(r.json.error.code).not.toBe("version_required");
    expect(await stamp(s.worker, s.t)).toEqual(before);
    expect(await db.actionLog.count({ where: { targetType: "task", targetId: s.t } })).toBe(logs);
  });

  it("AC2: an empty-string version is invalid_version on assign, move, complete and setApprover too", async () => {
    const s = await setup();
    const before = await stamp(s.worker, s.t);
    for (const route of routes(s).filter((r) => r.name !== "edit")) {
      const r = await route.send({ ...route.fields, expectedUpdatedAt: "" });
      expect(r.status, route.name).toBe(400);
      expectVersionError(r.json, "invalid_version");
    }
    expect(await stamp(s.worker, s.t)).toEqual(before);
  });

  it("AC3: missing, malformed and stale version errors share one structure and no other keys", async () => {
    const s = await setup();
    const seen = s.seen.updatedAt as string;
    const missing = await s.worker.c.patch(`/api/tasks/${s.t}`, { title: "New" });
    const malformed = await s.worker.c.patch(`/api/tasks/${s.t}`, { title: "New", expectedUpdatedAt: "" });
    expect((await patchTask(s.other, s.t, { title: "Theirs" })).status).toBe(200);
    const stale = await s.worker.c.patch(`/api/tasks/${s.t}`, { title: "Mine", expectedUpdatedAt: seen });

    expect(missing.status).toBe(400);
    expect(malformed.status).toBe(400);
    expect(stale.status).toBe(409);
    expectVersionError(missing.json, "version_required");
    expectVersionError(malformed.json, "invalid_version");
    expectVersionError(stale.json, "version_conflict");
    sameShape(missing.json, malformed.json);
    sameShape(malformed.json, stale.json);
    expect((await stamp(s.worker, s.t)).title).toBe("Theirs");
  });

  it("a bad title with a real version is still a validation error, not a version error", async () => {
    const s = await setup();
    const r = await s.worker.c.patch(`/api/tasks/${s.t}`, { title: "", expectedUpdatedAt: s.seen.updatedAt });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("Validation failed");
    expect(r.json.issues?.length).toBeGreaterThan(0);
  });

  it("load: 48 concurrent missing, null and empty versions all refuse and leave the task unchanged", async () => {
    const s = await setup();
    const before = await stamp(s.worker, s.t);
    const calls: Promise<{ status: number; json: unknown }>[] = [];
    for (let i = 0; i < 48; i++) {
      const route = routes(s)[i % 5];
      const form = i % 3;
      const body = form === 0 ? { ...route.fields } : form === 1 ? { ...route.fields, expectedUpdatedAt: null } : { ...route.fields, expectedUpdatedAt: "" };
      calls.push(route.send(body));
    }
    const results = await Promise.all(calls);
    expect(results).toHaveLength(48);
    for (const r of results) {
      expect(r.status).toBe(400);
      const code = (r.json as { error: { code: string } }).error.code;
      expect(code === "version_required" || code === "invalid_version").toBe(true);
      expectVersionError(r.json, code);
    }
    expect(await stamp(s.worker, s.t)).toEqual(before);
  }, 60_000);

  it("load: 40 concurrent stale versions conflict and do not overwrite the task", async () => {
    const s = await setup();
    const seen = s.seen.updatedAt as string;
    expect((await patchTask(s.other, s.t, { title: "Theirs" })).status).toBe(200);
    const after = await stamp(s.worker, s.t);
    const results = await Promise.all(
      Array.from({ length: 40 }, () => s.worker.c.patch(`/api/tasks/${s.t}`, { title: "Mine", expectedUpdatedAt: seen })),
    );
    expect(results).toHaveLength(40);
    for (const r of results) {
      expect(r.status).toBe(409);
      expectVersionError(r.json, "version_conflict");
    }
    expect(await stamp(s.worker, s.t)).toEqual(after);
  }, 60_000);
});
