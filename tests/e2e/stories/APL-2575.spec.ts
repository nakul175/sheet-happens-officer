// SHO-US-14.16 Approvals view (APL-2575). Needs the optional Member account: the Member sends, the Super Admin approves.
// AC3 uses a nakul17+ approver who starts with nothing waiting, then deactivates that person.
// The file skips only when SHO_QA_PASS is unset.
import type { APIRequestContext, Browser } from "@playwright/test";
import { test, expect, zz, type Api, type Later, type Who } from "../support";
import { PASS, alias, deactivate, passwordOk, signInAs, signUp, sinkToken } from "./qa";

// Pam has not published a TC hash. The marker is the literal "qa:TC missing".
const tag = (id: string) => ({ annotation: [{ type: "ac", description: id }, { type: "qa:TC", description: "qa:TC missing" }] });

test.beforeAll(() => {
  test.skip(!PASS, "Set SHO_QA_PASS (the password for nakul17+ aliases).");
  if (!passwordOk(PASS)) throw new Error("SHO_QA_PASS must be at least 8 characters with a letter and a number.");
});

async function freshPerson(browser: Browser, request: APIRequestContext, adminApi: Api, later: (fn: () => Promise<unknown>) => void, tagName: string) {
  const email = alias("2575", tagName, "aplyd.com");
  const name = zz(tagName);
  const signed = await signUp(request, name, email);
  expect(signed.status, signed.body).toBe(201);
  const token = await sinkToken(email, "Verify", 8000);
  expect(token, `verification mail for ${email}`).toBeTruthy();
  const verified = await request.post("/api/auth/verify", { data: { token } });
  expect(verified.ok(), await verified.text()).toBe(true);
  const who = await signInAs(browser, email, PASS);
  later(() => who.ctx.close());
  later(() => deactivate(adminApi, who.user.id as string));
  return who;
}

async function held(admin: Who, member: Who, later: Later, label: string) {
  const r = await admin.api.post("/api/projects", { name: zz("approvals"), leaderId: admin.user.id });
  expect(r.status).toBe(201);
  const id = r.json.project.id as string;
  later(() => admin.api.post(`/api/projects/${id}/archive`));
  expect((await admin.api.post(`/api/projects/${id}/members`, { userId: member.user.id, role: "EDITOR" })).status).toBe(201);
  const title = zz(label);
  const t = (await admin.api.post(`/api/projects/${id}/tasks`, { dueDate: "2026-11-03", title, assigneeId: member.user.id, approverId: admin.user.id })).json.task.id as string;
  expect((await member.api.post(`/api/tasks/${t}/send-for-approval`)).status).toBe(200);
  return { id, t, title };
}
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

test("AC1: tasks awaiting my approval sit in a group at the top of My tasks with their age in days", tag("APL-2575 AC1"), async ({ admin, member, later }) => {
  const { t, title } = await held(admin, member, later, "waiting");
  const p = admin.page;
  await p.goto("/");
  const group = p.getByRole("region", { name: "Waiting on me" });
  await expect(group).toBeVisible();
  await expect(group.getByText(title)).toBeVisible();
  await expect(group.getByRole("link", { name: title }).getByText("Waiting since today", { exact: true })).toBeVisible();
  // at the top of the task groups (the first-run Start guide card, when shown, sits above all groups)
  const labels = await p.getByRole("main").getByRole("region").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")).filter((l) => l !== "Start guide"));
  expect(labels[0]).toBe("Waiting on me");
  expect((await admin.api.get("/api/my-tasks")).json.waitingOnMe.map((x: { id: string }) => x.id)).toContain(t);
});

test("AC2: Close in the row closes the task in one step and offers Undo", tag("APL-2575 AC2"), async ({ admin, member, later }) => {
  const { t, title } = await held(admin, member, later, "close");
  const p = admin.page;
  await p.goto("/");
  await p.getByRole("button", { name: `Close "${title}"` }).click();
  await expect(p.getByRole("button", { name: `Close "${title}"` })).toHaveCount(0);
  expect((await admin.api.get(`/api/tasks/${t}`)).json.task.completedAt).toBeTruthy();
  await expect(p.getByRole("status").filter({ has: p.getByRole("button", { name: "Undo", exact: true }) }).getByRole("button", { name: "Undo", exact: true })).toBeVisible();
});

test("AC3: with nothing waiting, the group is absent", tag("APL-2575 AC3"), async ({ admin, member, browser, request, later }) => {
  const approver = await freshPerson(browser, request, admin.api, later, "approver");
  const made = await admin.api.post("/api/projects", { name: zz("approvals-empty"), leaderId: admin.user.id });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  const id = made.json.project.id as string;
  later(() => admin.api.post(`/api/projects/${id}/archive`));
  expect((await admin.api.post(`/api/projects/${id}/members`, { userId: member.user.id, role: "EDITOR" })).status).toBe(201);
  expect((await admin.api.post(`/api/projects/${id}/members`, { userId: approver.user.id, role: "EDITOR" })).status).toBe(201);
  const title = zz("gone");
  const t = (await admin.api.post(`/api/projects/${id}/tasks`, { dueDate: "2026-11-03", title, assigneeId: member.user.id, approverId: approver.user.id })).json.task.id as string;
  expect((await member.api.post(`/api/tasks/${t}/send-for-approval`)).status).toBe(200);
  expect((await approver.api.post(`/api/tasks/${t}/send-back`)).status).toBe(200);
  const rest = (await approver.api.get("/api/my-tasks")).json.waitingOnMe as unknown[];
  expect(rest, "this approver started with nothing waiting").toEqual([]);
  await approver.page.goto("/");
  await expect(approver.page.getByRole("region", { name: "Waiting on me" })).toHaveCount(0);
  await expect(approver.page.getByText(title)).toHaveCount(0);
  void id;
});

test("AC4: a task I sent for approval appears under 'Waiting on others' and not under mine", tag("APL-2575 AC4"), async ({ admin, member, later }) => {
  const { t, title } = await held(admin, member, later, "others");
  const mine = (await member.api.get("/api/my-tasks")).json;
  expect(ids(mine.waitingOnOthers)).toContain(t);
  expect([...mine.overdue, ...mine.next7, ...mine.later, ...(mine.waitingOnMe ?? [])].some((x: { id: string }) => x.id === t)).toBe(false);
  const p = member.page;
  await p.goto("/");
  await expect(p.getByRole("region", { name: "Waiting on others" }).getByText(title)).toBeVisible();
  await expect(p.getByRole("region", { name: "Waiting on me" }).getByText(title)).toHaveCount(0);
});
