// APL-2721 story spec. One test per acceptance criterion.
// Local only: production hosts are refused, and so is any host but localhost or 127.0.0.1.
// The guard is given TASKBOARD_URL as the base, so it never reads the process image for BASE_URL.
// Thrown-away people and projects use ZZ-TEST names and a nakul17+ alias. afterAll hands each project
// to the Super Admin, archives it and deactivates the person, all through the API (tests/zz-test-data.ts).
// No qa:TC id is assigned on the issue, so every title says qa:TC missing.
// Playwright (APL-2911): ci.yml runs it against the CI server after npm test. People, projects, tasks and cleanup go
// through ../local-api, the same calls as tests/helpers.ts and tests/zz-test-data.ts without a vitest import.
import { expect, test, type Browser, type Page } from "@playwright/test";
import { assertStoryTargetAllowed } from "../base-url";
import { BASE, PW, task, withVersion, zzTestData, type Account, type ZzProject } from "../local-api";

assertStoryTargetAllowed(process.env, BASE);

const zz = zzTestData("2721e2e");

let browser: Browser;
let lead: Account;

// The browser is Playwright's own (playwright.config.ts: PW_CHROMIUM or the installed Chromium).
test.beforeAll(async ({ browser: b }) => {
  test.setTimeout(180000);
  if (!/^(localhost|127\.0\.0\.1)$/.test(new URL(BASE).hostname)) {
    throw new Error(`Refusing to run against ${BASE}: this spec is local only.`);
  }
  browser = b;
  lead = await zz.person("lead");
});

test.afterAll(async () => {
  test.setTimeout(120000);
  const problems = await zz.cleanUp();
  expect(problems, problems.join("\n")).toEqual([]);
});

const zzProject = (): Promise<ZzProject> => zz.project(lead);

/**
 * Signs in through the form. A click before React has hydrated the form does a native submit
 * instead of the API call, so wait until React has attached its props to the form first.
 */
async function signIn(page: Page) {
  await page.goto("/signin", { waitUntil: "domcontentloaded", timeout: 120000 });
  const button = page.getByRole("button", { name: "Sign in" });
  await button.waitFor({ state: "visible", timeout: 120000 });
  await page.waitForFunction(
    (el) => Object.keys((el as HTMLButtonElement).form ?? {}).some((k) => k.startsWith("__reactProps")),
    await button.elementHandle(),
    { timeout: 120000 },
  );
  await page.getByLabel("Work email").fill(lead.email);
  await page.getByLabel("Password").fill(PW);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/signin"), { timeout: 120000 });
}

async function openProject(page: Page, id: string) {
  await page.goto(`/projects/${id}`, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.getByRole("region", { name: "To do", exact: true }).waitFor({ state: "visible", timeout: 120000 });
}

function region(page: Page, name: string) {
  return page.getByRole("region", { name, exact: true });
}

/** Clicks Treat as done on a section and waits until that section shows the done mark. */
async function treatAsDone(page: Page, name: string) {
  const box = region(page, name);
  await box.getByRole("button", { name: `Section menu for ${name}` }).click();
  await page.getByRole("menuitem", { name: "Treat as done" }).click();
  await box.getByText("(done)").waitFor({ state: "visible", timeout: 20000 });
}

async function openTask(page: Page, title: string) {
  await page.getByRole("link", { name: title }).click();
  await page.getByRole("dialog", { name: "Task" }).waitFor({ state: "visible", timeout: 20000 });
  return page.getByRole("dialog", { name: "Task" });
}

test.describe("qa:TC missing APL-2721 done flag on the project page", { tag: "@local-only" }, () => {
  test.describe.configure({ timeout: 180000 });
  test("qa:TC missing cascaded subtasks reopen with their parent", async () => {
    const proj = await zzProject();
    const parent = await task(lead, proj.id, { title: "ZZ-TEST Parent P", sectionId: proj.doing });
    await task(lead, proj.id, { title: "ZZ-TEST Sub A", parentId: parent });
    await task(lead, proj.id, { title: "ZZ-TEST Sub B", parentId: parent });
    expect((await lead.c.patch(`/api/projects/${proj.id}/sections/${proj.doing}`, { isDone: true })).status).toBe(200);

    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, baseURL: BASE });
    try {
      await signIn(page);
      await openProject(page, proj.id);
      await region(page, "In progress").getByText("(done)").waitFor({ state: "visible", timeout: 20000 });
      await treatAsDone(page, "To do");
      await region(page, "In progress").getByText("(done)").waitFor({ state: "hidden", timeout: 20000 });
      await region(page, "In progress").getByRole("button", { name: 'Complete "ZZ-TEST Parent P"' }).waitFor({ state: "visible", timeout: 20000 });

      const dialog = await openTask(page, "ZZ-TEST Parent P");
      await dialog.getByRole("checkbox", { name: 'Mark "ZZ-TEST Sub A" done' }).waitFor({ state: "visible" });
      expect(await dialog.getByRole("checkbox", { name: 'Mark "ZZ-TEST Sub A" done' }).isChecked()).toBe(false);
      expect(await dialog.getByRole("checkbox", { name: 'Mark "ZZ-TEST Sub B" done' }).isChecked()).toBe(false);
      await dialog.getByRole("button", { name: "Mark complete" }).waitFor({ state: "visible", timeout: 20000 });
    } finally {
      await page.close();
    }
  });

  test("qa:TC missing a subtask ticked done on its own stays done", async () => {
    const flag = await zzProject();
    const parent = await task(lead, flag.id, { title: "ZZ-TEST Parent flag", sectionId: flag.doing });
    await task(lead, flag.id, { title: "ZZ-TEST Sub A flag", parentId: parent });
    const own = await task(lead, flag.id, { title: "ZZ-TEST Sub C flag", parentId: parent });
    expect((await lead.c.post(`/api/tasks/${own}/complete`, await withVersion(lead, own))).status).toBe(200);
    expect((await lead.c.patch(`/api/projects/${flag.id}/sections/${flag.doing}`, { isDone: true })).status).toBe(200);

    const hand = await zzProject();
    const parent2 = await task(lead, hand.id, { title: "ZZ-TEST Parent hand", sectionId: hand.doing });
    await task(lead, hand.id, { title: "ZZ-TEST Sub A hand", parentId: parent2 });
    const own2 = await task(lead, hand.id, { title: "ZZ-TEST Sub C hand", parentId: parent2 });
    expect((await lead.c.post(`/api/tasks/${own2}/complete`, await withVersion(lead, own2))).status).toBe(200);
    expect((await lead.c.post(`/api/tasks/${parent2}/complete`, await withVersion(lead, parent2, { completeAll: true }))).status).toBe(200);

    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, baseURL: BASE });
    try {
      await signIn(page);
      await openProject(page, flag.id);
      await treatAsDone(page, "To do");
      const flagDialog = await openTask(page, "ZZ-TEST Parent flag");
      expect(await flagDialog.getByRole("checkbox", { name: 'Mark "ZZ-TEST Sub A flag" done' }).isChecked()).toBe(false);
      expect(await flagDialog.getByRole("checkbox", { name: 'Mark "ZZ-TEST Sub C flag" not done' }).isChecked()).toBe(true);

      await openProject(page, hand.id);
      const handDialog = await openTask(page, "ZZ-TEST Parent hand");
      await handDialog.getByRole("button", { name: "Reopen" }).click();
      await handDialog.getByRole("button", { name: "Mark complete" }).waitFor({ state: "visible", timeout: 20000 });
      expect(await handDialog.getByRole("checkbox", { name: 'Mark "ZZ-TEST Sub A hand" done' }).isChecked()).toBe(false);
      expect(await handDialog.getByRole("checkbox", { name: 'Mark "ZZ-TEST Sub C hand" not done' }).isChecked()).toBe(true);
    } finally {
      await page.close();
    }
  });

  test("qa:TC missing a trashed parent stays complete in its original section", async () => {
    const proj = await zzProject();
    const title = "ZZ-TEST Parent T";
    const trashed = await task(lead, proj.id, { title, sectionId: proj.doing });
    expect((await lead.c.patch(`/api/projects/${proj.id}/sections/${proj.doing}`, { isDone: true })).status).toBe(200);
    expect((await lead.c.del(`/api/tasks/${trashed}`)).status).toBe(204);

    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, baseURL: BASE });
    try {
      await signIn(page);
      await openProject(page, proj.id);
      await treatAsDone(page, "To do");
      await page.getByRole("link", { name: "Trash" }).click();
      await page.getByRole("button", { name: "Restore" }).waitFor({ state: "visible", timeout: 20000 });
      expect(await page.getByText(title).count()).toBeGreaterThan(0);
      await page.getByRole("button", { name: "Restore" }).click();
      await page.getByText("Trash is empty.").waitFor({ state: "visible", timeout: 20000 });

      await openProject(page, proj.id);
      await region(page, "In progress").getByText("(done)").waitFor({ state: "hidden", timeout: 20000 });
      await region(page, "To do").getByText("(done)").waitFor({ state: "visible", timeout: 20000 });
      await region(page, "In progress").getByRole("button", { name: `Reopen "${title}"` }).waitFor({ state: "visible", timeout: 20000 });
      const dialog = await openTask(page, title);
      const section = dialog.getByRole("combobox", { name: "Section" });
      await section.waitFor({ state: "visible" });
      expect(await section.inputValue()).toBe(proj.doing);
      await dialog.getByRole("button", { name: "Reopen" }).waitFor({ state: "visible" });
    } finally {
      await page.close();
    }
  });
});
