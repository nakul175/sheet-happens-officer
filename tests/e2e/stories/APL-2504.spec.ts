// APL-2504 · SHO-US-6.3 Action log with before-state
// Acceptance criteria: AC1 one row per write with who/what/before/after, AC2 "via concierge" tag, AC3 visibility by role,
// AC4 Activity screen newest first, AC5 12-month retention, AC6 "Too old to undo" after 30 days.
// AC4 text says an Editor must not reach the screen; SHO-US-14.14 later let Editors see rows for their own tasks. The tests follow
// the live 14.14 behaviour (Editor: own tasks only; Viewer: refused) and say so.
// Data: every project and task is named "ZZ-TEST ..."; projects are archived afterwards.
import { test, expect, zz } from "../support";

async function proj(admin: any, label: string, later: (f: () => Promise<unknown>) => void, leaderId?: string) {
  const r = await admin.api.post("/api/projects", { name: zz(label), leaderId: leaderId ?? admin.user.id });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = r.json.project.id as string;
  later(() => admin.api.post(`/api/projects/${id}/archive`));
  return id;
}
const mk = async (who: any, p: string, title: string, extra: Record<string, unknown> = {}) => {
  const r = await who.api.post(`/api/projects/${p}/tasks`, { title, ...extra });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.task.id as string;
};
const rows = async (who: any, p: string) => (await who.api.get(`/api/projects/${p}/activity`)).json.items as { what: string; who: string; via: string; undo: string }[];

test("AC1: each write leaves one row with who, what, and the before and after values", async ({ admin, later }) => {
  const p = await proj(admin, "log-rows", later);
  const t = await mk(admin, p, zz("old name"));
  expect((await admin.api.patch(`/api/tasks/${t}`, { priority: "HIGH" })).status).toBe(200);
  expect((await admin.api.del(`/api/tasks/${t}`)).status).toBe(204);
  const items = await rows(admin, p);
  const text = items.map((i) => i.what);
  expect(text.some((w) => /created the project/.test(w))).toBe(true);
  expect(text.some((w) => /added ".*" to To do/.test(w))).toBe(true);
  expect(text.filter((w) => /changed priority from Medium to High/.test(w))).toHaveLength(1); // before and after
  expect(text.filter((w) => /moved ".*" to Trash/.test(w))).toHaveLength(1);
  for (const i of items) expect(i.who).toBe(admin.user.name);
});

test.skip("AC2: a change made through the concierge carries a 'via concierge' tag — needs the concierge to write, which needs the model switched on for staging (MODEL_DATA_APPROVED and a model key); not reachable from a browser session without a model", async () => {});

test("AC3: a Member cannot read another project's rows; a Leader reads their own project's rows; an Admin reads all", async ({ admin, member, later }) => {
  const mine = await proj(admin, "log-led", later, member.user.id); // the member leads this project
  const other = await proj(admin, "log-other", later); // the member is not in this one
  await mk(admin, mine, zz("led task"));
  await mk(admin, other, zz("other task"));
  expect((await member.api.get(`/api/projects/${mine}/activity`)).status).toBe(200);
  expect((await rows(member, mine)).some((r) => r.what.includes(zz("led task")))).toBe(true);
  expect((await member.api.get(`/api/projects/${other}/activity`)).status).toBe(404);
  expect((await admin.api.get(`/api/projects/${other}/activity`)).status).toBe(200);
  expect((await admin.api.get(`/api/projects/${mine}/activity`)).status).toBe(200);
});

test("AC4: a Leader or Admin opens Activity and sees the project's rows newest first; a Viewer is refused", async ({ admin, member, later }) => {
  const p = await proj(admin, "log-screen", later);
  const t = await mk(admin, p, zz("screen task"));
  expect((await admin.api.patch(`/api/tasks/${t}`, { priority: "HIGH" })).status).toBe(200);
  await admin.page.goto(`/projects/${p}/activity`);
  // SHO-US-14.14 turned the When/Who/What/How table into one sentence per row (who, what, local date, channel chip, Undo).
  const rowsUi = admin.page.locator(".item.act");
  await expect(rowsUi.first()).toContainText(`${admin.user.name} changed priority from Medium to High`); // newest first
  await expect(rowsUi.first().locator("small")).toContainText(/\d{1,2} \w{3}, /); // local date and time
  await expect(rowsUi.last()).toContainText("created the project");
  // Viewer: no Activity link and the API refuses
  expect((await admin.api.post(`/api/projects/${p}/members`, { userId: member.user.id, role: "VIEWER" })).status).toBe(201);
  later(() => admin.api.del(`/api/projects/${p}/members/${member.user.id}?handoverTo=${admin.user.id}`));
  await member.page.goto(`/projects/${p}`);
  await expect(member.page.getByRole("tab", { name: "List" })).toBeVisible();
  await expect(member.page.getByRole("link", { name: "Activity" })).toHaveCount(0);
  expect((await member.api.get(`/api/projects/${p}/activity`)).status).toBe(403);
  await member.page.goto(`/projects/${p}/activity`);
  await expect(member.page.getByText("Only people who work on this project can see Activity.")).toBeVisible();
});

test("AC4 (Editor, per SHO-US-14.14): an Editor sees only rows about their own tasks", async ({ admin, member, later }) => {
  const p = await proj(admin, "log-editor", later);
  expect((await admin.api.post(`/api/projects/${p}/members`, { userId: member.user.id, role: "EDITOR" })).status).toBe(201);
  later(() => admin.api.del(`/api/projects/${p}/members/${member.user.id}?handoverTo=${admin.user.id}`));
  await mk(admin, p, zz("leader's task"));
  await mk(member, p, zz("editor's task"));
  const seen = (await rows(member, p)).map((r) => r.what).join(" | ");
  expect(seen).toContain(zz("editor's task"));
  expect(seen).not.toContain(zz("leader's task"));
});

test.skip("AC5: rows older than 12 months are removed — needs a row aged 12 months and the purge-old job; not reachable from a browser session", async () => {});
test.skip("AC6: Undo is disabled with 'Too old to undo' after 30 days — needs a row aged 30 days; not reachable from a browser session", async () => {});
