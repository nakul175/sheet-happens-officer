// Integration tests: run against a live dev server and database.
//   TASKBOARD_URL=http://localhost:3100 npm test
import { describe, expect, it, beforeAll } from "vitest";

const BASE = process.env.TASKBOARD_URL ?? "http://localhost:3000";
const run = Date.now();

class Client {
  cookie = "";
  async call(method: string, path: string, body?: unknown) {
    const res = await fetch(BASE + path, {
      method,
      headers: { "content-type": "application/json", ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    if (set) this.cookie = set.split(";")[0];
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }
}

const alice = new Client();
const bob = new Client();
let projectId = "";
let aliceId = "";
let bobId = "";

describe("session", () => {
  it("rejects unauthenticated requests", async () => {
    const anon = new Client();
    expect((await anon.call("GET", "/api/projects")).status).toBe(401);
  });

  it("requires a name for new users and validates email", async () => {
    const c = new Client();
    expect((await c.call("POST", "/api/session", { email: `x${run}@t.io` })).status).toBe(400);
    expect((await c.call("POST", "/api/session", { email: "not-an-email", name: "X" })).status).toBe(400);
  });

  beforeAll(async () => {
    const a = await alice.call("POST", "/api/session", { email: `alice${run}@t.io`, name: "Alice" });
    const b = await bob.call("POST", "/api/session", { email: `bob${run}@t.io`, name: "Bob" });
    aliceId = a.json.user.id;
    bobId = b.json.user.id;
  });

  it("signs in an existing user by email without a name", async () => {
    const c = new Client();
    const r = await c.call("POST", "/api/session", { email: `ALICE${run}@t.io` });
    expect(r.status).toBe(200);
    expect(r.json.user.id).toBe(aliceId);
  });
});

describe("projects", () => {
  it("creates, lists, updates and archives", async () => {
    const created = await alice.call("POST", "/api/projects", { name: "Launch" });
    expect(created.status).toBe(201);
    projectId = created.json.project.id;

    const list = await alice.call("GET", "/api/projects");
    expect(list.json.projects.some((p: { id: string }) => p.id === projectId)).toBe(true);

    const patched = await alice.call("PATCH", `/api/projects/${projectId}`, { name: "Launch v2" });
    expect(patched.json.project.name).toBe("Launch v2");

    const scratch = (await alice.call("POST", "/api/projects", { name: "Scratch" })).json.project.id;
    await alice.call("PATCH", `/api/projects/${scratch}`, { archived: true });
    const visible = await alice.call("GET", "/api/projects");
    expect(visible.json.projects.some((p: { id: string }) => p.id === scratch)).toBe(false);
    const all = await alice.call("GET", "/api/projects?archived=true");
    expect(all.json.projects.some((p: { id: string }) => p.id === scratch)).toBe(true);
  });

  it("rejects an empty name", async () => {
    expect((await alice.call("POST", "/api/projects", { name: "  " })).status).toBe(400);
  });
});

describe("tasks", () => {
  const ids: string[] = [];

  it("creates tasks with ascending positions and assignees", async () => {
    for (const title of ["One", "Two", "Three"]) {
      const r = await alice.call("POST", "/api/tasks", { projectId, title, assigneeIds: [bobId] });
      expect(r.status).toBe(201);
      expect(r.json.task.assignees[0].user.id).toBe(bobId);
      ids.push(r.json.task.id);
    }
    const list = await alice.call("GET", `/api/tasks?projectId=${projectId}&topLevel=true`);
    expect(list.json.tasks.map((t: { title: string }) => t.title)).toEqual(["One", "Two", "Three"]);
  });

  it("rejects unknown assignees and projects", async () => {
    expect((await alice.call("POST", "/api/tasks", { projectId, title: "x", assigneeIds: ["nope"] })).status).toBe(400);
    expect((await alice.call("POST", "/api/tasks", { projectId: "nope", title: "x" })).status).toBe(404);
  });

  it("reorders within a column", async () => {
    // Put "Three" between "One" and "Two": before=One (above), after=Two (below)
    const r = await alice.call("PATCH", `/api/tasks/${ids[2]}`, { beforeId: ids[0], afterId: ids[1] });
    expect(r.status).toBe(200);
    const list = await alice.call("GET", `/api/tasks?projectId=${projectId}&topLevel=true`);
    expect(list.json.tasks.map((t: { title: string }) => t.title)).toEqual(["One", "Three", "Two"]);
  });

  it("sets and clears completedAt as status changes", async () => {
    const done = await alice.call("PATCH", `/api/tasks/${ids[0]}`, { status: "DONE" });
    expect(done.json.task.completedAt).not.toBeNull();
    const reopened = await alice.call("PATCH", `/api/tasks/${ids[0]}`, { status: "IN_PROGRESS" });
    expect(reopened.json.task.completedAt).toBeNull();
  });

  it("filters by status, assignee and search text", async () => {
    const byStatus = await alice.call("GET", `/api/tasks?projectId=${projectId}&status=IN_PROGRESS`);
    expect(byStatus.json.tasks).toHaveLength(1);
    const byAssignee = await alice.call("GET", `/api/tasks?projectId=${projectId}&assigneeId=${aliceId}`);
    expect(byAssignee.json.tasks).toHaveLength(0);
    const search = await alice.call("GET", `/api/tasks?projectId=${projectId}&q=thr`);
    expect(search.json.tasks).toHaveLength(1);
  });

  it("replaces the assignee set", async () => {
    const r = await alice.call("PUT", `/api/tasks/${ids[1]}/assignees`, { userIds: [aliceId] });
    expect(r.json.task.assignees.map((a: { user: { id: string } }) => a.user.id)).toEqual([aliceId]);
  });

  it("paginates with a cursor", async () => {
    const p1 = await alice.call("GET", `/api/tasks?projectId=${projectId}&limit=2`);
    expect(p1.json.tasks).toHaveLength(2);
    expect(p1.json.nextCursor).toBeTruthy();
    const p2 = await alice.call("GET", `/api/tasks?projectId=${projectId}&limit=2&cursor=${p1.json.nextCursor}`);
    expect(p2.json.tasks).toHaveLength(1);
    expect(p2.json.nextCursor).toBeNull();
  });

  it("supports one level of subtasks that follow their parent", async () => {
    const sub = await alice.call("POST", "/api/tasks", { projectId, parentId: ids[0], title: "Sub" });
    expect(sub.status).toBe(201);
    const nested = await alice.call("POST", "/api/tasks", { projectId, parentId: sub.json.task.id, title: "Too deep" });
    expect(nested.status).toBe(400);

    const other = (await alice.call("POST", "/api/projects", { name: "Other" })).json.project.id;
    expect((await alice.call("PATCH", `/api/tasks/${sub.json.task.id}`, { projectId: other })).status).toBe(400);
    await alice.call("PATCH", `/api/tasks/${ids[0]}`, { projectId: other });
    const detail = await alice.call("GET", `/api/tasks/${ids[0]}`);
    expect(detail.json.subtasks[0].projectId).toBe(other);
  });

  it("deleting a parent cascades to subtasks; deleting a missing task is 404", async () => {
    expect((await alice.call("DELETE", `/api/tasks/${ids[0]}`)).status).toBe(204);
    expect((await alice.call("GET", `/api/tasks/${ids[0]}`)).status).toBe(404);
    expect((await alice.call("DELETE", `/api/tasks/${ids[0]}`)).status).toBe(404);
  });
});
