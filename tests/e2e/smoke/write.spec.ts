// @write release checks. Staging only.
//
// Each test signs in as a ZZ-TEST nakul17+ account (ZZ_TEST_01 / ZZ_TEST_06, or SHARD_*/PEER_*).
// The password and the address are never printed. Projects created here are named with the
// ZZ-TEST prefix and archived afterwards, including when an assertion fails. Tasks are deleted
// (moved to Trash) before the project is archived. The session is revoked on the way out.
import { test, expect, zz } from "./guard";
import type { Api } from "./guard";

async function project(api: Api, leaderId: string, label: string, projects: string[]) {
  const created = await api.post("/api/projects", { name: zz(label), leaderId });
  expect(created.status, "create ZZ-TEST project").toBe(201);
  const id = created.json.project.id as string;
  projects.push(id);
  return id;
}

test("sign-in for a ZZ-TEST nakul17+ user", { tag: "@write" }, async ({ admin }) => {
  expect(admin.user.orgRole).toBe("SUPER_ADMIN");
  const me = await admin.api.get("/api/auth/me");
  expect(me.status).toBe(200);
  expect(me.json.user.id).toBe(admin.user.id);
  expect(me.json.user.orgRole).toBe("SUPER_ADMIN");
  const body = JSON.stringify(me.json);
  expect(body.includes("password")).toBe(false);
});

test("dashboard and project list load", { tag: "@write" }, async ({ admin }) => {
  await admin.page.goto("/");
  await expect(admin.page.getByRole("heading", { name: "My tasks" })).toBeVisible();
  await admin.page.goto("/projects");
  await expect(admin.page.getByRole("heading", { name: "Projects" })).toBeVisible();
  const list = await admin.api.get("/api/projects");
  expect(list.status).toBe(200);
  expect(Array.isArray(list.json.projects)).toBe(true);
});

test("opening a project renders its tasks", { tag: "@write" }, async ({ admin }) => {
  const title = zz("visible task");
  const id = await project(admin.api, admin.user.id, "visible project", admin.projects);
  const created = await admin.api.post(`/api/projects/${id}/tasks`, { title });
  expect(created.status).toBe(201);
  admin.tasks.push(created.json.task.id as string);
  await admin.page.goto(`/projects/${id}`);
  await expect(admin.page.getByRole("region", { name: "To do" })).toBeVisible();
  await expect(admin.page.locator(".ttl", { hasText: title })).toBeVisible();
});

test("create, edit, complete, and delete a ZZ-TEST task", { tag: "@write" }, async ({ admin }) => {
  const title = zz("task");
  const edited = zz("task edited");
  const id = await project(admin.api, admin.user.id, "task project", admin.projects);
  const created = await admin.api.post(`/api/projects/${id}/tasks`, { title });
  expect(created.status).toBe(201);
  const taskId = created.json.task.id as string;
  admin.tasks.push(taskId);
  await admin.page.goto(`/projects/${id}`);
  await expect(admin.page.locator(".ttl", { hasText: title })).toBeVisible();

  const patched = await admin.api.patch(`/api/tasks/${taskId}`, { title: edited });
  expect(patched.status).toBe(200);
  expect(patched.json.task.title).toBe(edited);
  await admin.page.reload();
  await expect(admin.page.locator(".ttl", { hasText: edited })).toBeVisible();

  const done = await admin.api.post(`/api/tasks/${taskId}/complete`);
  expect(done.status).toBe(200);
  const after = await admin.api.get(`/api/tasks/${taskId}`);
  expect(after.status).toBe(200);
  expect(after.json.task.completedAt).toBeTruthy();

  const removed = await admin.api.del(`/api/tasks/${taskId}`);
  expect(removed.status).toBe(204);
  const gone = await admin.api.get(`/api/tasks/${taskId}`);
  expect(gone.status).toBe(404);
  await admin.page.reload();
  await expect(admin.page.locator(".ttl", { hasText: edited })).toHaveCount(0);
});

test("a Member is refused on admin pages", { tag: "@write" }, async ({ member }) => {
  expect(member.user.orgRole).toBe("MEMBER");
  await member.page.goto("/team");
  await expect(member.page.getByRole("heading", { name: "Team" })).toBeVisible();
  await expect(member.page.getByRole("button", { name: /Add person/ })).toHaveCount(0);

  await member.page.goto("/usage");
  await expect(member.page.getByText("Only the Super Admin can see usage.")).toBeVisible();
  await member.page.goto("/audit");
  await expect(member.page.getByText("Only the Super Admin can see the audit log.")).toBeVisible();

  const usage = await member.api.get("/api/usage");
  expect(usage.status).toBe(404);
  const audit = await member.api.get("/api/audit");
  expect(audit.status).toBe(404);
  const team = await member.api.get("/api/team");
  expect(team.status).toBe(200);
  expect(Array.isArray(team.json.people)).toBe(true);
});

test("search returns the ZZ-TEST task", { tag: "@write" }, async ({ admin }) => {
  const token = `srch${zz("mark").split(" ").pop()}`;
  const title = zz(token);
  const id = await project(admin.api, admin.user.id, "search project", admin.projects);
  const created = await admin.api.post(`/api/projects/${id}/tasks`, { title });
  expect(created.status).toBe(201);
  const taskId = created.json.task.id as string;
  admin.tasks.push(taskId);
  const found = await admin.api.get(`/api/search?q=${encodeURIComponent(token)}`);
  expect(found.status).toBe(200);
  const tasks = found.json.tasks as { id: string; title: string }[];
  expect(tasks.some((t) => t.id === taskId && t.title === title)).toBe(true);

  await admin.page.goto("/search");
  await admin.page.getByLabel("Search").fill(token);
  await expect(admin.page.getByRole("link", { name: title })).toBeVisible();

  expect((await admin.api.del(`/api/tasks/${taskId}`)).status).toBe(204);
  const after = await admin.api.get(`/api/search?q=${encodeURIComponent(token)}`);
  expect(after.status).toBe(200);
  const left = after.json.tasks as { title: string }[];
  expect(left.some((t) => t.title === title)).toBe(false);
});

test("concierge chat responds", { tag: "@write" }, async ({ admin }) => {
  test.setTimeout(60_000);
  const state = await admin.api.get("/api/concierge/state");
  expect(state.status).toBe(200);
  await admin.page.goto("/projects");
  await expect(admin.page.getByRole("heading", { name: "Projects" })).toBeVisible();

  if (state.json.disabled) {
    const message = String(state.json.disabled.message ?? "");
    expect(message.length).toBeGreaterThan(0);
    if (!state.json.hidden) await expect(admin.page.getByRole("status").filter({ hasText: message })).toBeVisible();
    return;
  }

  const sent = await admin.api.post("/api/concierge/messages", {
    text: "Reply with the single word ready. Do not change any records.",
  });
  expect(sent.status).toBe(200);
  const messages = (sent.json.messages ?? []) as { role?: string; text?: string }[];
  // A disabled concierge returns no rows and stores nothing. Clear only a thread this test wrote.
  if (messages.length === 0) {
    expect(String(sent.json.disabled?.message ?? "").length).toBeGreaterThan(0);
    return;
  }
  try {
    const reply = messages.find((m) => m.role === "ASSISTANT" && (m.text ?? "").trim().length > 0);
    expect(reply, "assistant reply").toBeTruthy();
    if (!state.json.hidden) {
      await admin.page.reload();
      await expect(admin.page.getByRole("log", { name: "Conversation" })).toContainText(reply!.text!);
    }
  } finally {
    const cleared = await admin.api.del("/api/concierge/messages");
    expect(cleared.status).toBe(200);
  }
});

test("notifications bell loads", { tag: "@write" }, async ({ admin }) => {
  const notes = await admin.api.get("/api/notifications");
  expect(notes.status).toBe(200);
  expect(typeof notes.json.unread).toBe("number");
  expect(Array.isArray(notes.json.items)).toBe(true);
  await admin.page.goto("/");
  await admin.page.getByRole("button", { name: /^Notifications/ }).click();
  await expect(admin.page.getByRole("dialog", { name: "Notifications" })).toBeVisible();
});

test("usage page loads for a Super Admin", { tag: "@write" }, async ({ admin }) => {
  expect(admin.user.orgRole).toBe("SUPER_ADMIN");
  const usage = await admin.api.get("/api/usage");
  expect(usage.status).toBe(200);
  expect(typeof usage.json.month?.calls).toBe("number");
  await admin.page.goto("/usage");
  await expect(admin.page.getByRole("heading", { name: "Usage" })).toBeVisible();
  await expect(admin.page.getByText("Only the Super Admin can see usage.")).toHaveCount(0);
});

test("sign-out returns to the sign-in page", { tag: "@write" }, async ({ admin }) => {
  await admin.page.goto("/profile");
  await admin.page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(admin.page).toHaveURL(/\/signin$/);
  const me = await admin.page.request.get("/api/auth/me");
  expect(me.status()).toBe(401);
});
