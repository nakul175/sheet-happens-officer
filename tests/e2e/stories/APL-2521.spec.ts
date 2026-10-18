// APL-2521 · SHO-US-6.5 Organisation audit log for the Super Admin
// Acceptance criteria: AC1 one row per listed event, AC2 only the Super Admin, AC3 no secrets, AC4 retention and no hand editing,
// AC5 five failed sign-ins and the lockout, AC6 IP only on sign-in events, AC7 task delete/restore/purge, Undo anyway, approver.
// Data: every project and task is named "ZZ-TEST ..."; the person created for AC5 is "ZZ-TEST ..." at example.invalid (no inbox) and is
// deactivated afterwards. AC2 briefly makes the Member an Admin and puts the role back in a finally block.
import { test, expect, zz, RUN } from "../support";

async function proj(admin: any, label: string, later: (f: () => Promise<unknown>) => void) {
  const r = await admin.api.post("/api/projects", { name: zz(label), leaderId: admin.user.id });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = r.json.project.id as string;
  later(() => admin.api.post(`/api/projects/${id}/archive`));
  return id;
}
const mk = async (admin: any, p: string, title: string, extra: Record<string, unknown> = {}) => {
  const r = await admin.api.post(`/api/projects/${p}/tasks`, { title, ...extra });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.task.id as string;
};
type Row = { id: string; at: string; who: string | null; email: string | null; event: string; ip: string | null; channel: string; target: string | null };
const audit = async (admin: any, q: string) => (await admin.api.get(`/api/audit?${q}`)).json.items as Row[];

test("AC1: listed events each leave a row with time, actor, event, target and channel", async ({ admin, member, later }) => {
  // Remember the rows that exist now, so a row left by an earlier run cannot satisfy this test.
  const EVENTS = ["PROJECT_CREATED", "MEMBER_ADDED", "TASK_DELETED", "TASK_RESTORED"];
  const seen = new Set<string>();
  for (const event of EVENTS) for (const r of await audit(admin, `event=${event}&person=${admin.user.id}`)) seen.add(r.id);
  const p = await proj(admin, "audit-rows", later);
  expect((await admin.api.post(`/api/projects/${p}/members`, { userId: member.user.id, role: "EDITOR" })).status).toBe(201);
  later(() => admin.api.del(`/api/projects/${p}/members/${member.user.id}?handoverTo=${admin.user.id}`));
  const t = await mk(admin, p, zz("audited"));
  expect((await admin.api.del(`/api/tasks/${t}`)).status).toBe(204);
  expect((await admin.api.post(`/api/tasks/${t}/restore`)).status).toBe(200);
  // What each new row must name. A project's creator may also be logged as a member, so MEMBER_ADDED is matched on the Member's name.
  const names: Record<string, string> = {
    PROJECT_CREATED: zz("audit-rows"),
    MEMBER_ADDED: `"${member.user.name}"`,
    TASK_DELETED: zz("audited"),
    TASK_RESTORED: zz("audited"),
  };
  for (const event of EVENTS) {
    const rows = (await audit(admin, `event=${event}&person=${admin.user.id}`)).filter((r) => !seen.has(r.id) && (r.target ?? "").includes(names[event]));
    expect(rows, `exactly one new ${event} row from this test`).toHaveLength(1);
    const row = rows[0];
    expect(row.who).toBe(admin.user.name);
    expect(row.channel).toBe("Screen");
    expect(Number.isNaN(Date.parse(row.at))).toBe(false);
    expect(row.target, `${event} names its target`).toBeTruthy();
  }
  // exactly one row for one deletion of this task
  const deleted = (await audit(admin, `event=TASK_DELETED&person=${admin.user.id}`)).filter((r) => (r.target ?? "").includes(zz("audited")));
  expect(deleted).toHaveLength(1);
  // the screen shows the columns
  await admin.page.goto("/audit");
  await expect(admin.page.getByRole("columnheader")).toContainText(["When (IST)", "Who", "Event", "IP", "How", "Target"]);
});

test("AC2: nobody but the Super Admin can open or query the audit log, Admins included", async ({ admin, member }) => {
  expect((await member.api.get("/api/audit")).status).toBe(404);
  await member.page.goto("/audit");
  await expect(member.page.getByText("This page isn't available").first()).toBeVisible();
  // an Admin: promote the Member for the length of the check, then put the role back
  expect((await admin.api.patch(`/api/team/${member.user.id}`, { orgRole: "ADMIN" })).status).toBe(200);
  try {
    expect((await member.api.get("/api/audit")).status).toBe(404);
    await member.page.goto("/audit");
    await expect(member.page.getByText("This page isn't available").first()).toBeVisible();
  } finally {
    await admin.api.patch(`/api/team/${member.user.id}`, { orgRole: "MEMBER" });
  }
});

test("AC3: no password, token or email link is stored in the rows", async ({ admin }) => {
  const res = await admin.page.request.get("/api/audit");
  const body = await res.text();
  // A boolean on purpose: a failing `expect(body).not.toContain(secret)` prints the secret in the test report.
  expect(body.includes(process.env.SHO_ADMIN_PASS!), "the Super Admin password appears in the audit log").toBe(false);
  expect(body).not.toMatch(/token=|passwordHash|"password"|\$2[aby]\$|argon2/i);
  for (const r of JSON.parse(body).items as Row[]) expect(Object.keys(r).sort()).toEqual(["at", "channel", "email", "event", "id", "ip", "target", "who"]);
});

test("AC4: the log is read-only through the app", async ({ admin }) => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
    const r = await admin.page.request.fetch("/api/audit", { method, data: {} });
    expect([404, 405], `${method} /api/audit`).toContain(r.status());
  }
});
test.skip("AC4 (12-month removal): needs a row aged 12 months and the purge-old job; not reachable from a browser session", async () => {});

test("AC5 and AC6: five failed sign-ins and the lockout are logged, with the IP on those rows only", async ({ admin, anon, later }) => {
  const email = `zz-test-lock-${RUN}@example.invalid`;
  const add = await admin.api.post("/api/team", { firstName: "ZZ-TEST", lastName: `lockout ${RUN}`, email, role: "MEMBER" });
  expect(add.status, JSON.stringify(add.json)).toBe(201);
  const id = (add.json.person?.id ?? add.json.user?.id ?? add.json.id) as string;
  later(() => admin.api.post(`/api/team/${id}/deactivate`, { reassign: "leaders" }));
  for (let i = 0; i < 5; i++) {
    const r = await anon.request.post("/api/auth/signin", { data: { email, password: `wrong-${i}-ZZ-test` }, headers: { "x-forwarded-for": "203.0.113.77" } });
    expect(r.status()).toBe(401);
  }
  const failed = await audit(admin, `event=SIGN_IN_FAILED&person=${id}`);
  expect(failed).toHaveLength(5);
  const locked = await audit(admin, `event=SIGN_IN_LOCKED&person=${id}`);
  expect(locked.length, "the lockout row is written on the 5th failure").toBeGreaterThanOrEqual(1);
  for (const r of [...failed, ...locked]) expect(r.ip, "sign-in rows carry the IP").toBeTruthy();
  // AC6, the other half: no other event stores an IP
  const all = await audit(admin, "");
  expect(all.filter((r) => !/^SIGN_IN/.test(r.event) && r.ip)).toHaveLength(0);
});

test("AC7: task delete and restore, an approver being set, and 'Undo anyway' each leave an audit row", async ({ admin, member, later }) => {
  const p = await proj(admin, "audit-added", later);
  expect((await admin.api.post(`/api/projects/${p}/members`, { userId: member.user.id, role: "EDITOR" })).status).toBe(201);
  later(() => admin.api.del(`/api/projects/${p}/members/${member.user.id}?handoverTo=${admin.user.id}`));
  const t = await mk(admin, p, zz("approver task"), { assigneeId: member.user.id });
  expect((await admin.api.put(`/api/tasks/${t}/approver`, { approverId: admin.user.id })).status).toBe(200);
  const approver = (await audit(admin, `event=APPROVER_CHANGED&person=${admin.user.id}`)).filter((r) => (r.target ?? "").includes(zz("approver task")));
  expect(approver.length).toBeGreaterThanOrEqual(1);
  // Undo anyway: admin changes priority, the member changes it again, admin undoes over the member's change
  const change = await admin.page.request.patch(`/api/tasks/${t}`, { data: { priority: "HIGH" } });
  expect(change.status()).toBe(200);
  const undoId = change.headers()["x-undo-id"];
  expect(undoId).toBeTruthy();
  expect((await member.api.patch(`/api/tasks/${t}`, { priority: "LOW" })).status).toBe(200);
  expect((await admin.api.post(`/api/actions/${undoId}/undo`, { anyway: false })).status).toBe(409);
  expect((await admin.api.post(`/api/actions/${undoId}/undo`, { anyway: true })).status).toBe(200);
  expect((await audit(admin, `event=UNDO_OVERRIDE&person=${admin.user.id}`)).length).toBeGreaterThanOrEqual(1);
});
test.skip("AC7 (30-day purge): one row per purge run needs a task aged 30 days and the purge-trash job; not reachable from a browser session", async () => {});
