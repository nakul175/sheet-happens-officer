// APL-2670 story: a version conflict reads the same, named sentence on every screen that saves a task.
// The five screens that read the nested { error: { code, message } } body through src/lib/version-error.ts:
// TaskModal (task page), inline cells and Move to… (ProjectView), the Tick (TaskParts) and Close (MyTasks approvals).
// No qa:TC id is published for this story, so every title carries qa:TC missing.
// Gate: SHO_QA_PASS, the password of the pre-provisioned, verified nakul17+zz-qa-<slot>-1 and -2 aliases
// (QA_SLOT, default "local"). Without it the file fails in beforeAll, by design. Nothing here signs up an account.
// Each test makes its own ZZ-TEST project through the API, so every row label is unique on its page.
// afterAll archives those projects through the API. The spec writes no database rows directly.
import { expect, request, test, type APIRequestContext, type Page } from "@playwright/test";

const QA_PASS = process.env.SHO_QA_PASS ?? "";
const SLOT = (process.env.QA_SLOT || "local").toLowerCase();
const baseURL = (process.env.BASE_URL || process.env.TASKBOARD_URL || "http://localhost:3100").replace(/\/+$/, "");
const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}`;
const httpCredentials = process.env.STAGING_USER ? { username: process.env.STAGING_USER, password: process.env.STAGING_PASS ?? "" } : undefined;

type Person = { api: APIRequestContext; id: string; name: string };
type Board = { projectId: string; taskId: string; title: string; sections: { id: string; name: string; isDone: boolean }[] };

async function signIn(email: string): Promise<Person> {
  const api = await request.newContext({ baseURL, httpCredentials });
  const r = await api.post("/api/auth/signin", { data: { email, password: QA_PASS } });
  expect(r.status(), `${email} must be a pre-provisioned, verified alias with the SHO_QA_PASS password`).toBe(200);
  const user = (await r.json()).user as { id: string; name: string };
  return { api, id: user.id, name: user.name };
}

test.describe("qa:TC missing APL-2670 a version conflict shows who saved last on every task screen", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeAll(() => { if (!QA_PASS) throw new Error("APL-2670: set SHO_QA_PASS (the password of the nakul17+zz-qa aliases)."); });

  let lead: Person;
  let other: Person;
  const projects: string[] = [];

  test.beforeAll(async () => {
    lead = await signIn(`nakul17+zz-qa-${SLOT}-1@aplyd.com`);
    other = await signIn(`nakul17+zz-qa-${SLOT}-2@aplyd.com`);
  });

  test.afterAll(async () => {
    for (const id of projects) await lead?.api.post(`/api/projects/${id}/archive`);
    await lead?.api.dispose();
    await other?.api.dispose();
  });

  /** A fresh ZZ-TEST project led by `lead`, with `other` as Editor and one task in it. */
  async function board(label: string, task: Record<string, unknown> = {}): Promise<Board> {
    const made = await lead.api.post("/api/projects", { data: { name: `ZZ-TEST APL-2670 ${label} ${RUN}`, leaderId: lead.id } });
    expect(made.status()).toBe(201);
    const projectId = (await made.json()).project.id as string;
    projects.push(projectId);
    expect((await lead.api.post(`/api/projects/${projectId}/members`, { data: { userId: other.id, role: "EDITOR" } })).status()).toBe(201);
    const sections = (await (await lead.api.get(`/api/projects/${projectId}`)).json()).project.sections as Board["sections"];
    const title = `ZZ-TEST ${label} ${RUN}`;
    const t = await lead.api.post(`/api/projects/${projectId}/tasks`, { data: { dueDate: "2026-11-03", title, ...task } });
    expect(t.status()).toBe(201);
    return { projectId, taskId: (await t.json()).task.id as string, title, sections };
  }

  const version = async (who: Person, taskId: string) => ((await (await who.api.get(`/api/tasks/${taskId}`)).json()).task as { updatedAt: string }).updatedAt;

  /** `lead` saves the task from another session, so the version the page holds is now stale. */
  async function saveElsewhere(taskId: string) {
    const r = await lead.api.patch(`/api/tasks/${taskId}`, { data: { description: `ZZ-TEST changed elsewhere ${Date.now()}`, expectedUpdatedAt: await version(lead, taskId) } });
    expect(r.status()).toBe(200);
  }

  async function signedInPage(browser: import("@playwright/test").Browser): Promise<Page> {
    const ctx = await browser.newContext({ baseURL, httpCredentials, storageState: await lead.api.storageState() });
    return ctx.newPage();
  }

  const conflict = () => `${lead.name} changed this task while you were editing it.`;

  /** The alert names who saved last, from the nested body's message, and never prints the object. */
  async function expectConflict(page: Page, text: string) {
    await expect(page.getByRole("alert").filter({ hasText: text })).toBeVisible();
    await expect(page.getByText("[object Object]")).toHaveCount(0);
  }

  test("qa:TC missing APL-2670 AC3 TaskModal: a stale save on the task page names who saved last", async ({ browser }) => {
    const b = await board("modal");
    const page = await signedInPage(browser);
    await page.goto(`/tasks/${b.taskId}`);
    const priority = page.getByRole("combobox", { name: "Priority" });
    await expect(priority).toBeEnabled();
    await saveElsewhere(b.taskId);
    await priority.selectOption("HIGH");
    await expectConflict(page, `${conflict()} Your change was not saved`);
    await page.context().close();
  });

  test("qa:TC missing APL-2670 AC3 inline cell: a stale priority change names who saved last", async ({ browser }) => {
    const b = await board("inline");
    const page = await signedInPage(browser);
    await page.goto(`/projects/${b.projectId}`);
    const cell = page.getByRole("button", { name: "Priority Medium. Change" });
    await expect(cell).toBeVisible();
    await saveElsewhere(b.taskId);
    await cell.click();
    await page.getByRole("dialog", { name: "Choose priority" }).getByRole("button", { name: "High", exact: true }).click();
    await expectConflict(page, `${lead.name} changed “${b.title}” while you were editing. Your change was not saved`);
    await page.context().close();
  });

  test("qa:TC missing APL-2670 AC3 Tick: completing a stale row names who saved last", async ({ browser }) => {
    const b = await board("tick");
    const page = await signedInPage(browser);
    await page.goto(`/projects/${b.projectId}`);
    const tick = page.getByRole("button", { name: `Complete "${b.title}"` });
    await expect(tick).toBeEnabled();
    await saveElsewhere(b.taskId);
    await tick.click();
    await expectConflict(page, conflict());
    await page.context().close();
  });

  test("qa:TC missing APL-2670 AC3 Move to: moving a stale card names who saved last", async ({ browser }) => {
    const b = await board("move");
    const target = b.sections.find((s) => !s.isDone && s.name !== b.sections[0].name)!;
    const page = await signedInPage(browser);
    await page.goto(`/projects/${b.projectId}?view=board`);
    const moveButton = page.getByRole("button", { name: `Move to… "${b.title}"` });
    await expect(moveButton).toBeVisible();
    await saveElsewhere(b.taskId);
    await moveButton.click();
    await page.getByRole("dialog").getByRole("button", { name: target.name }).click();
    await expectConflict(page, conflict());
    await page.context().close();
  });

  test("qa:TC missing APL-2670 AC3 My tasks Close: closing a stale approval names who saved last", async ({ browser }) => {
    const b = await board("approve", { assigneeId: other.id });
    const setApprover = await lead.api.put(`/api/tasks/${b.taskId}/approver`, { data: { approverId: lead.id, expectedUpdatedAt: await version(lead, b.taskId) } });
    expect(setApprover.status()).toBe(200);
    expect((await other.api.post(`/api/tasks/${b.taskId}/send-for-approval`, { data: {} })).status()).toBe(200);
    const page = await signedInPage(browser);
    await page.goto("/");
    const close = page.getByRole("button", { name: `Close "${b.title}"` });
    await expect(close).toBeEnabled();
    await saveElsewhere(b.taskId);
    await close.click();
    await expectConflict(page, conflict());
    await page.context().close();
  });
});
