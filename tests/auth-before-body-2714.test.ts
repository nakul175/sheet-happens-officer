// APL-2714: projects/[id], tasks/[id]/assign and team/[id]/deactivate check the session and access before the body.
import { describe, expect, it } from "vitest";
import { account, admin, BASE, Client, project, superAdmin, task, versionNow, type Account } from "./helpers";
import { db } from "../src/lib/db";

type Res = { status: number; json: { error?: string; issues?: { path: unknown; message: string }[]; [k: string]: unknown } | null };

/** Sends the body exactly as given, so "{" reaches the server as malformed JSON. */
async function raw(method: string, path: string, body: string, cookie = ""): Promise<Res> {
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body,
  });
  const text = await res.text();
  const json = text && res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : null;
  return { status: res.status, json };
}

const MALFORMED = "{";
const hit = (c: Client, method: string, path: string, body: object | typeof MALFORMED) =>
  (body === MALFORMED ? raw(method, path, MALFORMED, c.cookie) : c.call(method, path, body)) as Promise<Res>;

function expectNoValidation(r: Res) {
  expect(JSON.stringify(r.json)).not.toMatch(/Validation failed|"issues"|Body must be valid JSON/);
}

function expectAnswer(r: Res, status: number, error: string) {
  expect(r.status, JSON.stringify(r.json)).toBe(status);
  expect(r.json).toEqual({ error });
  expectNoValidation(r);
}

function expectValidation(r: Res) {
  expect(r.status, JSON.stringify(r.json)).toBe(400);
  expect(Object.keys(r.json ?? {}).sort()).toEqual(["error", "issues"]);
  expect(r.json!.error).toBe("Validation failed");
  expect(r.json!.issues!.length).toBeGreaterThan(0);
  for (const issue of r.json!.issues!) {
    expect(Object.keys(issue).sort()).toEqual(["message", "path"]);
    expect(Array.isArray(issue.path)).toBe(true);
    expect(typeof issue.message).toBe("string");
  }
}

function expectBadJson(r: Res) {
  expect(r.status).toBe(400);
  expect(r.json).toEqual({ error: "Body must be valid JSON" });
}

// Schema-invalid body per route. Assign is a version route: since APL-2670 AC1 v1.4 the version is checked before
// the schema, so its invalid body carries a well-formed expectedUpdatedAt to still reach "Validation failed".
const INVALID = {
  project: { name: "" },
  assign: { assigneeId: "", expectedUpdatedAt: "2026-01-01T00:00:00.000Z" },
  deactivate: { reassign: "" },
} as const;

async function setup() {
  const sa = await superAdmin();
  const lead = await account("lead");
  const editor = await account("ed");
  const viewer = await account("view");
  const outsider = await account("out");
  const other = await account("other");
  const orgAdmin = await admin(sa, "orgad");
  const admin2 = await admin(sa, "orgadtwo");
  const p = await project(lead, lead, [{ who: editor }, { who: viewer, role: "VIEWER" }]);
  const t1 = await task(lead, p.id, { dueDate: "2031-03-20" });
  return { sa, lead, editor, viewer, outsider, other, orgAdmin, admin2, p, t1 };
}

const paths = (projectId: string, taskId: string, personId: string) => ({
  project: `/api/projects/${projectId}`,
  assign: `/api/tasks/${taskId}/assign`,
  deactivate: `/api/team/${personId}/deactivate`,
});

describe("qa:TC missing APL-2714 auth before body", () => {
  it("qa:TC missing AC1: no session gets 401 whatever the body, on every route", async () => {
    const { p, t1, editor } = await setup();
    const anon = new Client();
    const r = paths(p.id, t1, editor.id);
    for (const [method, path, invalid] of [
      ["PATCH", r.project, INVALID.project],
      ["POST", r.assign, INVALID.assign],
      ["POST", r.deactivate, INVALID.deactivate],
    ] as const) {
      for (const body of [invalid, MALFORMED] as const) {
        expectAnswer(await hit(anon, method, path, body), 401, "Not signed in");
      }
    }
  });

  it("qa:TC missing AC2: a caller without access gets the access answer, not 400, and nothing is stored", async () => {
    const { sa, lead, editor, viewer, outsider, other, orgAdmin, admin2, p, t1 } = await setup();
    const before = {
      project: await db.project.findUniqueOrThrow({ where: { id: p.id } }),
      task: await db.task.findUniqueOrThrow({ where: { id: t1 } }),
      actionRows: await db.actionLog.count({ where: { targetId: { in: [p.id, t1] } } }),
      auditRows: await db.auditLog.count({ where: { targetId: { in: [other.id, admin2.id] } } }),
    };
    const rows: [Account, string, string, object, number, string][] = [
      [outsider, "PATCH", `/api/projects/${p.id}`, INVALID.project, 404, "Project not found"],
      [editor, "PATCH", `/api/projects/${p.id}`, INVALID.project, 403, "Only the project Leader or an Admin can do this."],
      // APL-2875 supersedes the assign row of APL-2714 AC2 v1.1: an outsider gets the missing-id answer.
      [outsider, "POST", `/api/tasks/${t1}/assign`, INVALID.assign, 404, "Task not found"],
      [viewer, "POST", `/api/tasks/${t1}/assign`, INVALID.assign, 403, "Viewers cannot make changes."],
      [editor, "POST", `/api/team/${other.id}/deactivate`, INVALID.deactivate, 403, "You cannot deactivate this person."],
      [orgAdmin, "POST", `/api/team/${admin2.id}/deactivate`, INVALID.deactivate, 403, "You cannot deactivate this person."],
    ];
    for (const [who, method, path, invalid, status, error] of rows) {
      for (const body of [invalid, MALFORMED] as const) {
        expectAnswer(await hit(who.c, method, path, body), status, error);
      }
    }
    // A missing resource is still the route's not-found answer, before the body.
    for (const body of [INVALID.assign, MALFORMED] as const) {
      expectAnswer(await hit(lead.c, "POST", "/api/tasks/missing-task/assign", body), 404, "Task not found");
    }
    for (const body of [INVALID.deactivate, MALFORMED] as const) {
      expectAnswer(await hit(sa.c, "POST", "/api/team/missing-person/deactivate", body), 404, "Person not found");
    }

    const after = await db.project.findUniqueOrThrow({ where: { id: p.id } });
    expect({ name: after.name, description: after.description }).toEqual({ name: before.project.name, description: before.project.description });
    const t = await db.task.findUniqueOrThrow({ where: { id: t1 } });
    expect(t.assigneeId).toBe(before.task.assigneeId);
    expect(t.updatedAt.toISOString()).toBe(before.task.updatedAt.toISOString());
    expect(await db.actionLog.count({ where: { targetId: { in: [p.id, t1] } } })).toBe(before.actionRows);
    expect(await db.auditLog.count({ where: { targetId: { in: [other.id, admin2.id] } } })).toBe(before.auditRows);
    for (const id of [other.id, admin2.id]) {
      expect((await db.user.findUniqueOrThrow({ where: { id } })).deactivatedAt).toBeNull();
    }
  });

  it("qa:TC missing AC3: an allowed caller still gets today's 400 shapes on every route", async () => {
    const { sa, lead, other, p, t1 } = await setup();
    const r = paths(p.id, t1, other.id);
    for (const [who, method, path, invalid] of [
      [lead, "PATCH", r.project, INVALID.project],
      [lead, "POST", r.assign, INVALID.assign],
      [sa, "POST", r.deactivate, INVALID.deactivate],
    ] as const) {
      expectValidation(await hit(who.c, method, path, invalid));
      expectBadJson(await hit(who.c, method, path, MALFORMED));
    }
    expect((await db.user.findUniqueOrThrow({ where: { id: other.id } })).deactivatedAt).toBeNull();
  });

  it("qa:TC missing AC4: a valid body behaves as before and the change is stored", async () => {
    const { sa, lead, editor, other, p, t1 } = await setup();

    const name = `Renamed ${Date.now()}`;
    const renamed = await lead.c.patch(`/api/projects/${p.id}`, { name });
    expect(renamed.status).toBe(200);
    expect(renamed.json).toEqual({ status: "ok" });
    expect((await db.project.findUniqueOrThrow({ where: { id: p.id } })).name).toBe(name);
    expect(await db.actionLog.count({ where: { targetId: p.id, action: "project.updated" } })).toBe(1);

    const assigned = await lead.c.post(`/api/tasks/${t1}/assign`, { assigneeId: editor.id, expectedUpdatedAt: await versionNow(lead, t1) });
    expect(assigned.status).toBe(200);
    expect(assigned.json).toEqual({ status: "ok" });
    expect((await db.task.findUniqueOrThrow({ where: { id: t1 } })).assigneeId).toBe(editor.id);
    expect(await db.actionLog.count({ where: { targetId: t1, action: "task.assigned" } })).toBe(1);

    const off = await sa.c.post(`/api/team/${other.id}/deactivate`, { reassign: "leaders" });
    expect(off.status).toBe(200);
    expect(off.json).toEqual({ moved: 0, fellBack: [] });
    expect((await db.user.findUniqueOrThrow({ where: { id: other.id } })).deactivatedAt).not.toBeNull();
    const on = await sa.c.post(`/api/team/${other.id}/reactivate`);
    expect(on.status).toBe(200);
    expect((await db.user.findUniqueOrThrow({ where: { id: other.id } })).deactivatedAt).toBeNull();
  });
});
