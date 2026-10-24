// SHO-US-14.6 Keyboard shortcuts and help sheet (Linear APL-2565).
import { test, expect, zz, type Json } from "../support";
import { newProject } from "../g2";

type Who = { api: import("../support").Api; user: Json; page: import("@playwright/test").Page };

async function listProject(admin: Who, later: (f: () => Promise<unknown>) => void, label: string, n = 3) {
  const r = await admin.api.post("/api/projects", { name: zz(label), leaderId: admin.user.id });
  expect(r.status).toBe(201);
  const pid = r.json.project.id as string;
  later(() => admin.api.post(`/api/projects/${pid}/archive`));
  const ids: string[] = [];
  for (let i = 1; i <= n; i++) {
    const t = await admin.api.post(`/api/projects/${pid}/tasks`, { title: zz(`${label} task ${i}`), assigneeId: admin.user.id });
    expect(t.status).toBe(201);
    ids.push(t.json.task.id);
    later(() => admin.api.del(`/api/tasks/${t.json.task.id}`));
  }
  return { pid, ids };
}

test("AC1: pressing ? opens a sheet that lists every shortcut", async ({ admin, later }) => {
  await newProject(admin, later, { label: "14.6 shortcuts" }); // "+ New task" only renders when there is a project this person can add to
  const page = admin.page;
  await page.goto("/");
  await expect(page.getByRole("button", { name: "+ New task" })).toBeVisible(); // the page is hydrated: key handlers are attached
  await page.keyboard.press("?");
  const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(sheet).toBeVisible();
  // Every shortcut named in the story: C, /, G then M or P, J and K, Enter, X, E, and ? itself.
  for (const [key, what] of [["C", "New task"], ["/", "Search"], ["G", "Go to My tasks"], ["G", "Go to Projects"], ["J", "Next row"], ["K", "Previous row"], ["Enter", "Open the row"], ["X", "Complete the task"], ["E", "choose who it is assigned to"], ["?", "Show this list"]] as const) {
    const row = sheet.locator("dl.keys > div", { hasText: what }).first();
    await expect(row, `row for "${what}"`).toBeVisible();
    await expect(row.locator("kbd", { hasText: new RegExp(`^${key.replace(/[/?]/g, "\\$&")}$`) }).first()).toBeVisible();
  }
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
});

test("AC2: in a list, J then Enter opens the second row", async ({ admin, later }) => {
  const s = await listProject(admin, later, "14.6 jk");
  const page = admin.page;
  await page.goto(`/projects/${s.pid}`);
  const rows = page.locator("main [role=link].item");
  await expect(rows).toHaveCount(3);
  const secondTitle = (await rows.nth(1).locator(".ttl").innerText()).trim();
  await page.locator("body").click({ position: { x: 5, y: 5 } }); // nothing focused
  await page.keyboard.press("j");
  await expect(rows.nth(1)).toBeFocused();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Task" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Title")).toHaveValue(secondTitle);
  // K goes back up once the panel is closed.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await rows.nth(2).focus();
  await page.keyboard.press("k");
  await expect(rows.nth(1)).toBeFocused();
});

test("AC3: no single-key shortcut fires while focus is in an input, textarea or select", async ({ admin, later }) => {
  const s = await listProject(admin, later, "14.6 typing");
  const page = admin.page;
  const nothingFired = async () => {
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "New task" })).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "Search and commands" })).toHaveCount(0);
  };
  // An input.
  await page.goto("/search");
  const input = page.locator("main input").first();
  await input.click();
  await page.keyboard.type("c/?jkxe gm");
  await expect(input).toHaveValue("c/?jkxe gm");
  await nothingFired();
  expect(new URL(page.url()).pathname).toBe("/search");
  // A textarea: the task title in the panel.
  await page.goto(`/projects/${s.pid}?task=${s.ids[0]}`);
  const title = page.getByRole("dialog", { name: "Task" }).getByLabel("Title");
  await expect(title).toBeEditable(); // the title stays read-only until the project role has loaded
  await title.click();
  await title.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(el.value.length, el.value.length));
  await page.keyboard.type("?c");
  await expect(title).toHaveValue(/\?c$/);
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toHaveCount(0);
  await title.evaluate((el: HTMLTextAreaElement) => { el.value = el.defaultValue; }); // do not save the typed text
  // A select: the project picker in quick add. Typing a letter on a select picks an option, it must not run a shortcut.
  await page.goto("/");
  await page.getByRole("button", { name: "+ New task" }).click();
  const sel = page.locator("#qa-proj");
  await sel.focus();
  await page.keyboard.type("?");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "New task" })).toBeVisible(); // still the same dialog, nothing replaced it
});

test("AC4: browser and screen-reader keys (anything with Ctrl, Alt or Meta) are not overridden", async ({ admin, later }) => {
  await newProject(admin, later, { label: "14.6 modifiers" }); // "+ New task" only renders when there is a project this person can add to
  const page = admin.page;
  await page.goto("/");
  await expect(page.getByRole("button", { name: "+ New task" })).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { __prevented: string[] }).__prevented = [];
    // A window listener runs after the product's document listener, so it sees whether the product called preventDefault.
    window.addEventListener("keydown", (e) => { if (e.defaultPrevented) (window as unknown as { __prevented: string[] }).__prevented.push(`${e.ctrlKey ? "Ctrl+" : ""}${e.altKey ? "Alt+" : ""}${e.metaKey ? "Meta+" : ""}${e.key}`); });
  });
  for (const combo of ["Control+c", "Control+j", "Control+/", "Alt+c", "Alt+/", "Meta+c", "Meta+j", "Control+Shift+/", "Alt+g", "Control+g"]) {
    await page.keyboard.press(combo);
  }
  expect(await page.evaluate(() => (window as unknown as { __prevented: string[] }).__prevented)).toEqual([]);
  await expect(page.locator("[aria-modal='true']")).toHaveCount(0);
});
