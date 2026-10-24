// APL-2521 · SHO-US-6.5 Organisation audit log for the Super Admin
// Acceptance criteria: AC1 one row per listed event, AC2 only the Super Admin, AC3 no secrets, AC4 retention and no hand editing,
// AC5 five failed sign-ins and the lockout, AC6 IP only on the specified authentication security events (APL-2742 adds verification), AC7 task delete/restore/purge, Undo anyway, approver.
// Data: every project and task is named "ZZ-TEST ..."; the person created for AC5 is "ZZ-TEST ..." at example.invalid (no inbox) and is
// deactivated afterwards. AC2 briefly makes the Member an Admin and puts the role back in a finally block.
import { test, expect, zz, RUN, login, type Who } from "../support";
import { verifiedUser, deactivate } from "./qa";
import { auditEventMayCarryIp } from "../helpers/audit-ip-contract";
import { patchCurrent } from "../helpers/jim-http";
import { localSql, runLocalJob, sourceOf, sqlId } from "../helpers/local-clock";

test.beforeAll(() => {
  test.skip(!process.env.SHO_QA_PASS, "Set SHO_QA_PASS (the shared password for the nakul17+ accounts).");
});

async function proj(admin: Who, label: string, later: (f: () => Promise<unknown>) => void) {
  const r = await admin.api.post("/api/projects", { name: zz(label), leaderId: admin.user.id });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = r.json.project.id as string;
  later(() => admin.api.post(`/api/projects/${id}/archive`));
  return id;
}
const mk = async (admin: Who, p: string, title: string, extra: Record<string, unknown> = {}) => {
  const r = await admin.api.post(`/api/projects/${p}/tasks`, { title, ...extra });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.task.id as string;
};
type Row = { id: string; at: string; who: string | null; email: string | null; event: string; ip: string | null; channel: string; target: string | null };
const audit = async (admin: Who, q: string) => (await admin.api.get(`/api/audit?${q}`)).json.items as Row[];

// qa:TC missing
test("AC1: listed events each leave a row with time, actor, event, target and channel", async ({ admin, member, later }) => {
  test.info().annotations.push({ type: "qa:TC", description: "qa:TC missing" });
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
  // the screen shows the columns. Below 1024px the table stacks and hides its header, so each cell carries its own label.
  await admin.page.goto("/audit");
  const wide = (admin.page.viewportSize()?.width ?? 1280) >= 1024;
  if (wide) {
    await expect(admin.page.getByRole("columnheader")).toContainText(["When (IST)", "Who", "Event", "IP", "How", "Target"]);
  } else {
    const row = admin.page.getByRole("row").filter({ hasText: "TASK_DELETED" }).filter({ hasText: zz("audited") });
    await expect(row).toHaveCount(1);
    await expect(row.getByRole("cell", { name: /^When/ })).toBeVisible();
    await expect(row.getByRole("cell", { name: /^Who/ })).toContainText(admin.user.name);
    await expect(row.getByRole("cell", { name: /^Event/ })).toContainText("TASK_DELETED");
    await expect(row.getByRole("cell", { name: /^How/ })).toContainText("on screen");
    await expect(row.getByRole("cell", { name: /^Target/ })).toContainText(zz("audited"));
    await expect(admin.page.getByRole("cell", { name: /^IP/ })).not.toHaveCount(0);
  }
});

// qa:TC missing
test("AC2: nobody but the Super Admin can open or query the audit log, Admins included", async ({ admin, member }) => {
  test.info().annotations.push({ type: "qa:TC", description: "qa:TC missing" });
  expect((await member.api.get("/api/audit")).status).toBe(404);
  await member.page.goto("/audit");
  await expect(member.page.getByRole("heading", { name: "This page isn't available" })).toBeVisible();
  // an Admin: promote the Member for the length of the check, then put the role back
  expect((await admin.api.patch(`/api/team/${member.user.id}`, { orgRole: "ADMIN" })).status).toBe(200);
  try {
    expect((await member.api.get("/api/audit")).status).toBe(404);
    await member.page.goto("/audit");
    await expect(member.page.getByRole("heading", { name: "This page isn't available" })).toBeVisible();
  } finally {
    await admin.api.patch(`/api/team/${member.user.id}`, { orgRole: "MEMBER" });
  }
});

// qa:TC missing
test("AC3: no password, token or email link is stored in the rows", async ({ admin }) => {
  test.info().annotations.push({ type: "qa:TC", description: "qa:TC missing" });
  const res = await admin.page.request.get("/api/audit");
  const body = await res.text();
  // A boolean on purpose: a failing `expect(body).not.toContain(secret)` prints the secret in the test report.
  expect(body.includes(login("ADMIN").password), "the Super Admin password appears in the audit log").toBe(false);
  expect(body).not.toMatch(/token=|passwordHash|"password"|\$2[aby]\$|argon2/i);
  for (const r of JSON.parse(body).items as Row[]) expect(Object.keys(r).sort()).toEqual(["at", "channel", "email", "event", "id", "ip", "target", "who"]);
});

// qa:TC missing
test("AC4: the log is read-only through the app", async ({ admin }) => {
  test.info().annotations.push({ type: "qa:TC", description: "qa:TC missing" });
  for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
    const r = await admin.page.request.fetch("/api/audit", { method, data: {} });
    expect([404, 405], `${method} /api/audit`).toContain(r.status());
  }
});
// qa:TC missing
test("AC4 (12-month removal): audit rows older than 12 months are removed by purge-old", async ({ admin, later }) => {
  test.info().annotations.push({ type: "qa:TC", description: "qa:TC missing" });
  await proj(admin, "audit-year", later);
  const rows = (await audit(admin, `event=PROJECT_CREATED&person=${admin.user.id}`)).filter((r) => (r.target ?? "").includes(zz("audit-year")));
  expect(rows, "the new project is in the audit log").toHaveLength(1);
  const row = rows[0];
  expect(Number.isNaN(Date.parse(row.at))).toBe(false);

  if (localSql(`UPDATE "AuditLog" SET "createdAt" = NOW() - INTERVAL '13 months' WHERE id = '${sqlId(row.id)}'`)) {
    const res = await runLocalJob(admin.page.request, "purge-old");
    expect(res!.status(), await res!.text()).toBe(200);
    const left = (await audit(admin, `event=PROJECT_CREATED&person=${admin.user.id}`)).filter((r) => r.id === row.id);
    expect(left, "a row older than 12 months is gone").toHaveLength(0);
  }
});

// qa:TC missing
test("APL-2521 AC4: audit rows are kept for 12 months in the source @static", async () => {
  test.info().annotations.push({ type: "qa:TC", description: "qa:TC missing" });
  expect(sourceOf("src/lib/feed.ts", "const LOG_MONTHS")).toContain("const LOG_MONTHS = 12");
  const fn = sourceOf("src/lib/feed.ts", "export async function purgeOld");
  expect(fn).toContain("cut.setMonth(cut.getMonth() - LOG_MONTHS)");
  expect(fn).toContain("auditLog.deleteMany");
  expect(fn).toContain("createdAt: { lt: cut }");
});

// qa:TC missing
test("AC5 and AC6: five failed sign-ins and the lockout are logged; only specified authentication security rows carry IP", async ({ browser, admin, anon, later }) => {
  test.info().annotations.push({ type: "qa:TC", description: "qa:TC missing" });
  // Preserve the order-sensitive trigger: a real successful verification immediately before this audit check.
  const verified = await verifiedUser(browser, anon.context().request, "2521", "verification-audit");
  later(() => verified.ctx.close());
  later(() => deactivate(admin.api, verified.user.id));
  const verificationRows = await audit(admin, `event=EMAIL_VERIFIED&person=${verified.user.id}`);
  expect(verificationRows).toHaveLength(1);
  expect(verificationRows[0].ip, "APL-2742 retains the client IP on successful verification").toBeTruthy();
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
  // AC6: task/project/member events carry no IP. APL-2742 AC4 explicitly requires IP for
  // EMAIL_VERIFIED and VERIFY_EMAIL_REQUESTED too; retain those exact exceptions, not an arbitrary prefix.
  const all = await audit(admin, "");
  expect(all.filter((r) => !auditEventMayCarryIp(r.event) && r.ip)).toHaveLength(0);
});

// qa:TC missing
test("AC7: task delete and restore, an approver being set, and 'Undo anyway' each leave an audit row", async ({ admin, member, later }) => {
  test.info().annotations.push({ type: "qa:TC", description: "qa:TC missing" });
  const p = await proj(admin, "audit-added", later);
  expect((await admin.api.post(`/api/projects/${p}/members`, { userId: member.user.id, role: "EDITOR" })).status).toBe(201);
  later(() => admin.api.del(`/api/projects/${p}/members/${member.user.id}?handoverTo=${admin.user.id}`));
  const t = await mk(admin, p, zz("approver task"), { assigneeId: member.user.id });
  const seen = (await admin.api.get(`/api/tasks/${t}`)).json.task.updatedAt as string;
  expect((await admin.api.put(`/api/tasks/${t}/approver`, { approverId: admin.user.id, expectedUpdatedAt: seen })).status).toBe(200);
  const approver = (await audit(admin, `event=APPROVER_CHANGED&person=${admin.user.id}`)).filter((r) => (r.target ?? "").includes(zz("approver task")));
  expect(approver.length).toBeGreaterThanOrEqual(1);
  // Undo anyway: admin changes priority, the member changes it again, admin undoes over the member's change
  const change = await patchCurrent(admin, t, { priority: "HIGH" });
  expect(change.status).toBe(200);
  // patchCurrent uses the shared api(), which drops response headers. The undo id is the Activity row.
  const undoRow = ((await admin.api.get(`/api/projects/${p}/activity`)).json.items as { id: string; what: string }[]).find((i) => /changed priority from Medium to High/.test(i.what));
  expect(undoRow, "the priority change is in Activity").toBeTruthy();
  const undoId = undoRow!.id;
  const low = await patchCurrent(member, t, { priority: "LOW" });
  expect(low.status).toBe(200);
  expect((await admin.api.post(`/api/actions/${undoId}/undo`, { anyway: false })).status).toBe(409);
  expect((await admin.api.post(`/api/actions/${undoId}/undo`, { anyway: true })).status).toBe(200);
  expect((await audit(admin, `event=UNDO_OVERRIDE&person=${admin.user.id}`)).length).toBeGreaterThanOrEqual(1);
});

// qa:TC missing
test("AC7 (30-day purge): one TASK_PURGED row is written for a purge run", async ({ admin, later }) => {
  test.info().annotations.push({ type: "qa:TC", description: "qa:TC missing" });
  const p = await proj(admin, "audit-purge", later);
  const aged = await mk(admin, p, zz("purged task"));
  const fresh = await mk(admin, p, zz("kept task"));
  expect((await admin.api.del(`/api/tasks/${aged}`)).status).toBe(204);
  expect((await admin.api.del(`/api/tasks/${fresh}`)).status).toBe(204);
  const still = (await admin.api.get(`/api/projects/${p}/trash`)).json.items as { id: string; daysLeft: number }[];
  expect(still.find((i) => i.id === fresh)?.daysLeft).toBe(30);

  if (localSql(`UPDATE "Task" SET "deletedAt" = NOW() - INTERVAL '31 days' WHERE id = '${sqlId(aged)}'`)) {
    const before = await audit(admin, "event=TASK_PURGED");
    const res = await runLocalJob(admin.page.request, "purge-trash");
    expect(res!.status(), await res!.text()).toBe(200);
    const after = await audit(admin, "event=TASK_PURGED");
    const added = after.filter((r) => !before.some((b) => b.id === r.id));
    expect(added, "one row for the purge run, not one per task").toHaveLength(1);
    expect(added[0].event).toBe("TASK_PURGED");
    const trash = (await admin.api.get(`/api/projects/${p}/trash`)).json.items as { id: string }[];
    expect(trash.some((i) => i.id === aged)).toBe(false);
    expect(trash.some((i) => i.id === fresh)).toBe(true);
  }
});

// qa:TC missing
test("APL-2521 AC7: a purge run writes one TASK_PURGED row in the source @static", async () => {
  test.info().annotations.push({ type: "qa:TC", description: "qa:TC missing" });
  const body = sourceOf("src/lib/tasks.ts", "export async function purgeTrash", "export async function myTasks");
  expect(body).toMatch(/if \(r\.count\)\s*\{?\s*await db\.auditLog\.create/);
  expect(body).toContain('event: "TASK_PURGED"');
  expect(body).toContain("trashPurgeBefore(now)");
});
