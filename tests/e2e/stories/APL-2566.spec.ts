// SHO-US-14.7 Global search and command palette (Linear APL-2566).
import { test, expect, zz, RUN, type Json } from "../support";
import { newProject } from "../g2";

type Who = { api: import("../support").Api; user: Json; page: import("@playwright/test").Page };

async function projectWithTask(admin: Who, later: (f: () => Promise<unknown>) => void, label: string, title: string) {
  const r = await admin.api.post("/api/projects", { name: zz(label), leaderId: admin.user.id });
  expect(r.status).toBe(201);
  const pid = r.json.project.id as string;
  later(() => admin.api.post(`/api/projects/${pid}/archive`));
  const t = await admin.api.post(`/api/projects/${pid}/tasks`, { dueDate: "2031-03-20", title, assigneeId: admin.user.id });
  expect(t.status).toBe(201);
  const tid = t.json.task.id as string;
  later(() => admin.api.del(`/api/tasks/${tid}`));
  return { pid, tid, name: zz(label) };
}
const ready = (page: import("@playwright/test").Page) => expect(page.getByRole("button", { name: "+ New task" })).toBeVisible(); // hydrated: key handlers are attached
const palette = (page: import("@playwright/test").Page) => page.getByRole("dialog", { name: "Search and commands" });

test("AC1: Ctrl+K opens the palette on any screen with focus in the field", async ({ admin, later }) => {
  await newProject(admin, later, { label: "14.7 palette" }); // "+ New task" only renders when there is a project this person can add to
  const page = admin.page;
  for (const path of ["/", "/projects", "/team", "/search", "/profile"]) {
    await page.goto(path);
    await ready(page);
    await page.keyboard.press("Control+k");
    await expect(palette(page), `palette on ${path}`).toBeVisible();
    await expect(page.getByRole("combobox", { name: /Search tasks, projects, people and actions/ })).toBeFocused();
    await page.keyboard.press("Escape");
  }
});

test("AC2: two letters show matching tasks within 500 ms, with project and assignee; Enter opens the first", async ({ admin, later }) => {
  const word = `Zq${RUN}`;
  const title = `${word} palette task`;
  const s = await projectWithTask(admin, later, "14.7 find", title);
  const page = admin.page;
  await page.goto("/");
  await ready(page);
  await page.keyboard.press("Control+k");
  const box = page.getByRole("combobox", { name: /Search tasks/ });
  // Two letters: results for a task appear in well under 500 ms. Timed inside the page, from the second letter to the first result row.
  await page.evaluate(() => {
    const w = window as Window & { __t0?: number; __t1?: number };
    w.__t0 = undefined; w.__t1 = undefined;
    document.addEventListener("input", (e) => { const el = e.target as HTMLInputElement; if (el.getAttribute("role") === "combobox" && el.value.length === 2 && w.__t0 === undefined) w.__t0 = performance.now(); }, true);
    new MutationObserver(() => { if (w.__t0 !== undefined && w.__t1 === undefined && document.querySelector("[role=dialog] [role=option] small")) w.__t1 = performance.now(); }).observe(document.body, { childList: true, subtree: true });
  });
  await box.pressSequentially("Zq");
  await expect(palette(page).getByRole("option").filter({ has: page.locator("small") }).first()).toBeVisible({ timeout: 5000 });
  const ms = await page.evaluate(() => (window as unknown as { __t1: number }).__t1 - (window as unknown as { __t0: number }).__t0);
  expect(ms, "first results after the second letter").toBeLessThan(500);
  // Finish the unique word: our task is the first hit, with its project and its assignee.
  await box.pressSequentially(word.slice(2));
  const first = palette(page).getByRole("option").filter({ hasText: title }).first();
  await expect(first).toBeVisible();
  await expect(first).toContainText(s.name);
  await expect(first).toContainText(admin.user.name);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/tasks/${s.tid}`));
});

test("AC3: a task in a project I do not belong to never appears", async ({ admin, member, later }) => {
  const word = `Hidden${RUN}`;
  const s = await projectWithTask(admin, later, "14.7 secret", `${word} acquisition plan`);
  // The control: the admin finds it, the Member (not in the project) does not, in the palette or in the search API.
  const mine = await admin.api.get(`/api/search?q=${word}`);
  expect(JSON.stringify(mine.json)).toContain(word);
  const theirs = await member.api.get(`/api/search?q=${word}`);
  expect(JSON.stringify(theirs.json)).not.toContain(word);
  expect(JSON.stringify(theirs.json)).not.toContain(s.name);
  const page = member.page;
  await page.goto("/");
  // A Member with nothing to write to has no "+ New task" button to wait for, so retry the shortcut until the page has hydrated.
  await expect(async () => { await page.keyboard.press("Control+k"); await expect(palette(page)).toBeVisible({ timeout: 1000 }); }).toPass({ timeout: 10000 });
  await page.getByRole("combobox", { name: /Search tasks/ }).pressSequentially(word);
  await expect(page.getByText(/Nothing matches/)).toBeVisible();
  await expect(palette(page).getByRole("option").filter({ hasText: word })).toHaveCount(0); // (the "Nothing matches" line repeats the typed word, so look at the result rows)
});

test("AC4: typing 'new' lists New task and New project", async ({ admin, later }) => {
  await projectWithTask(admin, later, "14.7 new", zz("14.7 new task")); // the admin can write somewhere, so New task is offered
  const page = admin.page;
  await page.goto("/");
  await ready(page);
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: /Search tasks/ }).pressSequentially("new");
  await expect(palette(page).getByRole("option", { name: /^New task/ })).toBeVisible();
  await expect(palette(page).getByRole("option", { name: /^New project/ })).toBeVisible();
});

test("AC5: Escape closes the palette and returns focus to where it was", async ({ admin, later }) => {
  await newProject(admin, later, { label: "14.7 focus" }); // "+ New task" only renders when there is a project this person can add to
  const page = admin.page;
  await page.goto("/projects");
  await ready(page);
  const button = page.getByRole("button", { name: "+ New task" });
  await button.focus();
  await page.keyboard.press("Control+k");
  await expect(palette(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(palette(page)).toHaveCount(0);
  await expect(button).toBeFocused();
});
