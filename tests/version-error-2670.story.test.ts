// APL-2670 Playwright story: the gherkin cases, driven through Playwright's request client.
// The version token is expectedUpdatedAt. setApprover is PUT /api/tasks/:id/approver.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { request, type APIRequestContext } from "playwright-core";
import { BASE, account, project, task, type Account } from "./helpers";

type Body = Record<string, unknown>;

function expectVersionError(json: unknown, code: string) {
  expect(json).toEqual({ error: { code, message: expect.any(String) } });
  const body = json as { error: Record<string, unknown> };
  expect(Object.keys(body)).toEqual(["error"]);
  expect(Object.keys(body.error).sort()).toEqual(["code", "message"]);
  expect(typeof body.error.message).toBe("string");
  expect(String(body.error.message).length).toBeGreaterThan(0);
}

describe("APL-2670 story: a missing task version always gives one error shape", () => {
  let worker: Account;
  let other: Account;
  let lead: Account;
  let taskId: string;
  let doing: string;
  let version: string;
  let api: APIRequestContext;

  beforeAll(async () => {
    lead = await account("lead");
    worker = await account("worker");
    other = await account("other");
    const p = await project(lead, lead, [{ who: worker }, { who: other }]);
    taskId = await task(worker, p.id, { title: "T1" });
    doing = p.doing;
    version = (await worker.c.get(`/api/tasks/${taskId}`)).json.task.updatedAt as string;
    api = await request.newContext({
      baseURL: BASE,
      extraHTTPHeaders: { cookie: worker.c.cookie, accept: "application/json" },
    });
  });

  afterAll(async () => {
    await api?.dispose();
  });

  async function send(method: "PATCH" | "POST" | "PUT", path: string, data: Body) {
    const res = await api.fetch(path, { method, data, headers: { "content-type": "application/json" } });
    const json: unknown = await res.json();
    return { status: res.status(), json };
  }

  async function unchanged() {
    const res = await api.get(`/api/tasks/${taskId}`);
    const row = (await res.json()).task;
    expect(row.updatedAt).toBe(version);
    expect(row.title).toBe("T1");
    expect(row.completedAt).toBeNull();
  }

  it("AC1 edit absent", async () => {
    const r = await send("PATCH", `/api/tasks/${taskId}`, { title: "New" });
    expect(r.status).toBe(400);
    expectVersionError(r.json, "version_required");
    await unchanged();
  });

  it("AC1 edit null", async () => {
    const r = await send("PATCH", `/api/tasks/${taskId}`, { title: "New", expectedUpdatedAt: null });
    expect(r.status).toBe(400);
    expectVersionError(r.json, "version_required");
    await unchanged();
  });

  it("AC1 assign absent", async () => {
    const r = await send("POST", `/api/tasks/${taskId}/assign`, { assigneeId: other.id });
    expect(r.status).toBe(400);
    expectVersionError(r.json, "version_required");
    await unchanged();
  });

  it("AC1 move absent", async () => {
    const r = await send("POST", `/api/tasks/${taskId}/move`, { sectionId: doing });
    expect(r.status).toBe(400);
    expectVersionError(r.json, "version_required");
    await unchanged();
  });

  it("AC1 complete absent", async () => {
    const r = await send("POST", `/api/tasks/${taskId}/complete`, {});
    expect(r.status).toBe(400);
    expectVersionError(r.json, "version_required");
    await unchanged();
  });

  it("AC1 setApprover absent", async () => {
    const r = await send("PUT", `/api/tasks/${taskId}/approver`, { approverId: lead.id });
    expect(r.status).toBe(400);
    expectVersionError(r.json, "version_required");
    await unchanged();
  });

  it("AC2 empty-string version is invalid_version", async () => {
    const r = await send("PATCH", `/api/tasks/${taskId}`, { title: "New", expectedUpdatedAt: "" });
    expect(r.status).toBe(400);
    expectVersionError(r.json, "invalid_version");
    await unchanged();
  });

  it("AC3 missing, malformed and stale bodies have the same keys", async () => {
    const missing = await send("PATCH", `/api/tasks/${taskId}`, { title: "New" });
    const malformed = await send("PATCH", `/api/tasks/${taskId}`, { title: "New", expectedUpdatedAt: "" });
    expect((await other.c.patch(`/api/tasks/${taskId}`, { title: "Theirs", expectedUpdatedAt: version })).status).toBe(200);
    const fresh = (await worker.c.get(`/api/tasks/${taskId}`)).json.task.updatedAt as string;
    const stale = await send("PATCH", `/api/tasks/${taskId}`, { title: "Mine", expectedUpdatedAt: version });

    expect(missing.status).toBe(400);
    expect(malformed.status).toBe(400);
    expect(stale.status).toBe(409);
    expectVersionError(missing.json, "version_required");
    expectVersionError(malformed.json, "invalid_version");
    expectVersionError(stale.json, "version_conflict");
    const shape = (json: unknown) => {
      const body = json as { error: Record<string, unknown> };
      return Object.keys(body).sort().join(",") + "|" + Object.keys(body.error).sort().join(",");
    };
    expect(shape(missing.json)).toBe("error|code,message");
    expect(shape(malformed.json)).toBe(shape(missing.json));
    expect(shape(stale.json)).toBe(shape(missing.json));
    const row = (await (await api.get(`/api/tasks/${taskId}`)).json()).task;
    expect(row.title).toBe("Theirs");
    expect(row.updatedAt).toBe(fresh);
  });
});
