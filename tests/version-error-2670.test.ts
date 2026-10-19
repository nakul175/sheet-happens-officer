// APL-2670: a missing task version is one error shape on edit, assign, move, complete and setApprover.
// The version is expectedUpdatedAt (the updatedAt the editor saw). "Unchanged at version 3" means that token does not move.
import { describe, expect, it } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client";
import { account, BASE, patchTask, project, task, type Account } from "./helpers";

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

  it("AC1: setting or clearing Blocked with no expectedUpdatedAt is version_required and changes nothing", async () => {
    const s = await setup();
    const before = await stamp(s.worker, s.t);
    for (const blocked of [true, false]) {
      const r = await s.worker.c.patch(`/api/tasks/${s.t}`, { blocked });
      expect(r.status, String(blocked)).toBe(400);
      expectVersionError(r.json, "version_required");
      expect((r.json as { error: { message: string } }).error.message).toBe("expectedUpdatedAt is required");
    }
    expect(await stamp(s.worker, s.t)).toEqual(before);
  });

  it("AC1: session, then access, then version, then the rest of the body", async () => {
    const s = await setup();
    const viewer = await account("viewer");
    await s.lead.c.post(`/api/projects/${s.p.id}/members`, { userId: viewer.id, role: "VIEWER" });
    const raw = async (cookie: string, body: string) => {
      const res = await fetch(BASE + `/api/tasks/${s.t}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
        body,
      });
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : null };
    };
    const signedOut = await raw("", "{");
    expect(signedOut.status).toBe(401);
    expect(signedOut.json).toEqual({ error: "Not signed in" });

    const viewerBad = await viewer.c.patch(`/api/tasks/${s.t}`, { title: "", expectedUpdatedAt: "abc" });
    expect(viewerBad.status).toBe(403);
    expect(viewerBad.json).toEqual({ error: "Viewers cannot make changes." });

    const missingVersion = await s.worker.c.patch(`/api/tasks/${s.t}`, { title: "" });
    expect(missingVersion.status).toBe(400);
    expectVersionError(missingVersion.json, "version_required");

    const malformed = await s.worker.c.patch(`/api/tasks/${s.t}`, { title: "", expectedUpdatedAt: "" });
    expect(malformed.status).toBe(400);
    expectVersionError(malformed.json, "invalid_version");

    const schema = await s.worker.c.patch(`/api/tasks/${s.t}`, { title: "", expectedUpdatedAt: s.seen.updatedAt });
    expect(schema.status).toBe(400);
    expect(schema.json.error).toBe("Validation failed");
    expect(schema.json.issues).toEqual([{ path: ["title"], message: "Give the task a title." }]);
  });

  it("AC2: an empty string and a non-ISO value are 400 invalid_version and change nothing", async () => {
    const s = await setup();
    const before = await stamp(s.worker, s.t);
    const logs = await db.actionLog.count({ where: { targetType: "task", targetId: s.t } });
    for (const value of ["", "abc"]) {
      const r = await s.worker.c.patch(`/api/tasks/${s.t}`, { title: "New", expectedUpdatedAt: value });
      expect(r.status, JSON.stringify(value)).toBe(400);
      expectVersionError(r.json, "invalid_version");
      expect((r.json as { error: { code: string } }).error.code).not.toBe("version_required");
    }
    expect(await stamp(s.worker, s.t)).toEqual(before);
    expect(await db.actionLog.count({ where: { targetType: "task", targetId: s.t } })).toBe(logs);
  });

  it("AC2: an empty string and a non-ISO value are invalid_version on assign, move, complete and setApprover too", async () => {
    const s = await setup();
    const before = await stamp(s.worker, s.t);
    for (const route of routes(s).filter((r) => r.name !== "edit")) {
      for (const value of ["", "abc"]) {
        const r = await route.send({ ...route.fields, expectedUpdatedAt: value });
        expect(r.status, `${route.name} ${JSON.stringify(value)}`).toBe(400);
        expectVersionError(r.json, "invalid_version");
      }
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

    const outsider = await account("outsider");
    const hidden = await outsider.c.patch(`/api/tasks/${s.t}`, { title: "New", expectedUpdatedAt: "abc" });
    const unknown = await s.worker.c.patch("/api/tasks/missing-task", { title: "New", expectedUpdatedAt: "abc" });
    const taskNotFound = { error: { code: "not_found", message: "Task not found" } };

    expect(missing.status).toBe(400);
    expect(malformed.status).toBe(400);
    expect(stale.status).toBe(409);
    expect(hidden.status).toBe(404);
    expect(unknown.status).toBe(404);
    expectVersionError(missing.json, "version_required");
    expectVersionError(malformed.json, "invalid_version");
    expectVersionError(stale.json, "version_conflict");
    expect(hidden.json).toEqual(taskNotFound);
    expect(JSON.stringify(hidden.json)).toBe(JSON.stringify(unknown.json));
    sameShape(missing.json, malformed.json);
    sameShape(malformed.json, stale.json);
    sameShape(stale.json, hidden.json);
    expect((await stamp(s.worker, s.t)).title).toBe("Theirs");

    const versionRoutes: [string, string, Record<string, unknown>][] = [
      ["POST", `/api/tasks/${s.t}/assign`, { assigneeId: "" }],
      ["POST", `/api/tasks/${s.t}/move`, { sectionId: "missing" }],
      ["POST", `/api/tasks/${s.t}/complete`, {}],
      ["PUT", `/api/tasks/${s.t}/approver`, { approverId: null }],
    ];
    for (const [method, path, body] of versionRoutes) {
      const hiddenRoute = await outsider.c.call(method, path, body);
      const missingRoute = await s.worker.c.call(method, path.replace(s.t, "missing-task"), body);
      expect(hiddenRoute.status, path).toBe(404);
      expect(hiddenRoute.json).toEqual(taskNotFound);
      expect(JSON.stringify(hiddenRoute.json)).toBe(JSON.stringify(missingRoute.json));
    }

    const flat = { error: "Task not found" };
    const otherRoutes: [string, string, Record<string, unknown> | undefined][] = [
      ["GET", `/api/tasks/${s.t}`, undefined],
      ["DELETE", `/api/tasks/${s.t}`, undefined],
      ["POST", `/api/tasks/${s.t}/reopen`, {}],
      ["POST", `/api/tasks/${s.t}/send-for-approval`, undefined],
      ["POST", `/api/tasks/${s.t}/send-back`, undefined],
      ["POST", `/api/tasks/${s.t}/collaborators`, { userId: s.lead.id }],
      ["POST", `/api/tasks/${s.t}/idea`, { isIdea: true }],
      ["POST", `/api/tasks/${s.t}/links`, {}],
      ["POST", `/api/tasks/${s.t}/convert`, {}],
    ];
    for (const [method, path, body] of otherRoutes) {
      const hiddenRoute = await outsider.c.call(method, path, body);
      const missingRoute = await s.worker.c.call(method, path.replace(s.t, "missing-task"), body);
      expect(hiddenRoute.status, path).toBe(404);
      expect(hiddenRoute.json).toEqual(flat);
      expect(JSON.stringify(hiddenRoute.json)).toBe(JSON.stringify(missingRoute.json));
    }
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
      const body = form === 0 ? { ...route.fields } : form === 1 ? { ...route.fields, expectedUpdatedAt: null } : { ...route.fields, expectedUpdatedAt: i % 2 === 0 ? "" : "abc" };
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
