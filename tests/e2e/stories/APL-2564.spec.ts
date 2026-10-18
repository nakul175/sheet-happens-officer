// SHO-US-14.5 Quick add from anywhere (Linear APL-2564).
import { test, expect, zz, type Json } from "../support";

type Who = { api: import("../support").Api; user: Json; page: import("@playwright/test").Page };

async function project(admin: Who, later: (f: () => Promise<unknown>) => void, label: string) {
  const r = await admin.api.post("/api/projects", { name: zz(label), leaderId: admin.user.id });
  expect(r.status).toBe(201);
  const pid = r.json.project.id as string;
  later(() => admin.api.post(`/api/projects/${pid}/archive`));
  return { pid, name: zz(label) };
}
async function tasksOf(who: Who, pid: string) {
  const r = await who.api.get(`/api/projects/${pid}/tasks`);
  return (r.json.sections as { tasks: { id: string; title: string; assignee: { id: string } }[] }[]).flatMap((s) => s.tasks);
}
const IST = (offset: number) => new Date(Date.now() + 5.5 * 3600_000 + offset * 86400_000);
const label = (d: Date) => `${d.toLocaleString("en-GB", { weekday: "short", timeZone: "UTC" })} ${d.getUTCDate()} ${d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" })}`;

test("AC1: pressing C on a screen where I can write focuses a title field within 200 ms", async ({ admin, later }) => {
  await project(admin, later, "14.5 focus"); // the admin can write somewhere, so the shortcut is live
  const page = admin.page;
  for (const path of ["/", "/projects", "/team"]) {
    await page.goto(path);
    await expect(page.getByRole("button", { name: "+ New task" })).toBeVisible(); // the targets have loaded
    await page.evaluate(() => {
      const w = window as Window & { __t0?: number; __t1?: number };
      w.__t0 = undefined; w.__t1 = undefined;
      document.addEventListener("keydown", (e) => { if (e.key === "c" && w.__t0 === undefined) w.__t0 = performance.now(); }, true);
      document.addEventListener("focusin", (e) => { if ((e.target as HTMLElement).id === "qa-title" && w.__t1 === undefined) w.__t1 = performance.now(); }, true);
    });
    await page.keyboard.press("c");
    await expect(page.locator("#qa-title")).toBeFocused();
    const ms = await page.evaluate(() => (window as unknown as { __t1: number }).__t1 - (window as unknown as { __t0: number }).__t0);
    expect(ms, `title focused ${Math.round(ms)} ms after C on ${path}`).toBeLessThan(200);
    await page.keyboard.press("Escape");
  }
});

test("AC2: a title and Enter creates the task in the last-used project, assigned to me, with an Undo toast", async ({ admin, later }) => {
  const p = await project(admin, later, "14.5 add");
  const page = admin.page;
  const first = zz("14.5 first");
  const second = zz("14.5 second");
  await page.goto("/");
  await expect(page.getByRole("button", { name: "+ New task" })).toBeVisible();
  // First add: choose the ZZ-TEST project once, so it becomes the last-used one.
  await page.keyboard.press("c");
  await page.locator("#qa-title").fill(first);
  await page.locator("#qa-proj").selectOption({ label: p.name });
  const reloaded = page.waitForResponse((r) => r.url().includes("/api/quick-add") && r.request().method() === "GET");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "New task" })).toHaveCount(0);
  await reloaded; // the screen refreshes its list of places to add to after each add
  // Second add: three actions in total. C, type, Enter.
  await page.keyboard.press("c");
  await expect(page.locator("#qa-proj")).toHaveValue(p.pid); // last used
  await page.keyboard.type(second);
  await page.keyboard.press("Enter");
  const toast = page.locator(".undo-toast");
  await expect(toast).toContainText("Undo");
  let found: Awaited<ReturnType<typeof tasksOf>>[number] | undefined;
  await expect(async () => { found = (await tasksOf(admin, p.pid)).find((t) => t.title === second); expect(found, "the task exists in the last-used project").toBeTruthy(); }).toPass({ timeout: 8000 });
  expect(found!.assignee.id).toBe(admin.user.id); // assigned to me
  // Undo removes it again.
  await toast.getByRole("button", { name: "Undo" }).click();
  await expect(async () => { expect((await tasksOf(admin, p.pid)).some((t) => t.title === second)).toBe(false); }).toPass({ timeout: 8000 });
  later(async () => { for (const t of await tasksOf(admin, p.pid)) await admin.api.del(`/api/tasks/${t.id}`); });
});

test("AC3: 'tomorrow' and 'fri' in the date field resolve to a date that is shown before saving", async ({ admin, later }) => {
  await project(admin, later, "14.5 dates");
  const page = admin.page;
  await page.goto("/");
  await expect(page.getByRole("button", { name: "+ New task" })).toBeVisible();
  await page.keyboard.press("c");
  const note = page.locator("#qa-date-note");
  await page.locator("#qa-date").fill("tomorrow");
  await expect(note).toHaveText(`Due ${label(IST(1))}`);
  await page.locator("#qa-date").fill("fri");
  await expect(note).toHaveText(/^Due Fri \d{1,2} [A-Z][a-z]{2}$/);
  await page.locator("#qa-date").fill("not a date at all");
  await expect(note).toContainText("Not a date I know");
  await expect(page.getByRole("dialog", { name: "New task" }).getByRole("button", { name: "Add task" })).toBeDisabled();
});

test("AC4: with only Viewer roles the shortcut does nothing and the button is absent", async ({ admin, member, later }) => {
  // Real server rule: a project where the Member is only a Viewer is not offered as a place to add a task.
  const p = await project(admin, later, "14.5 viewer");
  expect((await admin.api.post(`/api/projects/${p.pid}/members`, { userId: member.user.id, role: "VIEWER" })).status).toBe(201);
  const targets = await member.api.get("/api/quick-add");
  expect((targets.json.projects as { id: string }[]).some((x) => x.id === p.pid)).toBe(false);
  // The screen with nothing to write to (simulated: this Member may be an Editor elsewhere).
  const page = member.page;
  await page.route("**/api/quick-add", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ projects: [], lastProjectId: null }) }));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "My tasks" })).toBeVisible();
  await expect(page.getByRole("button", { name: "+ New task" })).toHaveCount(0);
  await page.keyboard.press("c");
  await expect(page.getByRole("dialog", { name: "New task" })).toHaveCount(0);
});

test("AC5: C typed into a text field does not open the dialog", async ({ admin, later }) => {
  await project(admin, later, "14.5 typing");
  const page = admin.page;
  await page.goto("/projects/new");
  const field = page.locator("main input").first();
  await expect(field).toBeVisible();
  await field.click();
  await page.keyboard.type("Cabbage c");
  await expect(field).toHaveValue("Cabbage c");
  await expect(page.getByRole("dialog", { name: "New task" })).toHaveCount(0);
});
