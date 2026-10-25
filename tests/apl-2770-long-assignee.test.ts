// APL-2770: on the project page, a long assignee name must not cover the task title. Clicking the title opens the task,
// never "Choose assignee". Real browser (playwright-core) against the local shared test server (TASKBOARD_URL).
// People, projects and tasks are made through the API (ZZ-TEST names, nakul17+ aliases) and cleaned up through it.
// Locators are role / label / text only; overlap is checked with bounding boxes. APL-2770 has no TC ids yet.
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { BASE, task, type Account } from "./helpers";
import { zzTestData } from "./zz-test-data";

const TITLE = "ZZ-TEST Fix invoice";
const zz = zzTestData("2770");
// Display names of exactly 12, 26 and 60 characters: "ZZ-TEST " plus a filler.
const FILLER: Record<number, string> = {
  12: "Abby",
  26: "Alexandra Worthing",
  60: "Maximiliana Alexandrina Worthington-Smythe Fairweath",
};
const EXAMPLES = [
  { len: 12, width: 1280, height: 800 },
  { len: 26, width: 1280, height: 800 },
  { len: 60, width: 1280, height: 800 },
  { len: 26, width: 390, height: 844 },
] as const;

type Box = { x: number; y: number; width: number; height: number };
type Case = { name: string; projectId: string; taskId: string };

let browser: Browser;
let leader: Account;
const cases: Record<number, Case> = {};

function chromePath() {
  const fromEnv = process.env.PW_CHROMIUM;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  for (const p of ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"]) {
    if (existsSync(p)) return p;
  }
  throw new Error("No Chrome/Chromium binary. Set PW_CHROMIUM.");
}

/** The Leader's project page in a fresh browser context at this size, signed in with the Leader's session cookie. */
async function openProject(c: Case, width: number, height: number) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  const [name, ...rest] = leader.c.cookie.split("=");
  await ctx.addCookies([{ name, value: rest.join("="), url: BASE }]);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/projects/${c.projectId}`);
  await title(page).waitFor({ state: "visible" });
  await assigneeButton(page, c.name).waitFor({ state: "visible" });
  return page;
}

const title = (page: Page) => page.getByText(TITLE, { exact: true });
const assigneeButton = (page: Page, name: string) => page.getByRole("button", { name: `Assignee ${name}. Change`, exact: true });
const taskDialog = (page: Page) => page.getByRole("dialog", { name: "Task", exact: true });
const chooseAssignee = (page: Page) => page.getByRole("dialog", { name: "Choose assignee", exact: true });

async function box(page: Page, what: ReturnType<typeof title>): Promise<Box> {
  const b = await what.boundingBox();
  if (!b) throw new Error("element has no bounding box");
  return b;
}

const intersects = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** The task dialog for TITLE is open: its Title field holds the task's title. */
async function expectTaskDialog(page: Page) {
  await taskDialog(page).waitFor({ state: "visible" });
  expect(await taskDialog(page).getByRole("textbox", { name: "Title" }).inputValue()).toBe(TITLE);
}

beforeAll(async () => {
  if (!/^(localhost|127\.0\.0\.1)$/.test(new URL(BASE).hostname)) throw new Error(`Refusing to run against ${BASE}: this test is local only.`);
  browser = await chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  leader = await zz.person("Leader");
  for (const len of [12, 26, 60]) {
    const who = await zz.person(FILLER[len]);
    expect(who.name).toHaveLength(len);
    const proj = await zz.project(leader);
    const added = await leader.c.post(`/api/projects/${proj.id}/members`, { userId: who.id, role: "EDITOR" });
    expect(added.status, JSON.stringify(added.json)).toBe(201);
    const taskId = await task(leader, proj.id, { dueDate: "2031-03-20", title: TITLE, assigneeId: who.id });
    cases[len] = { name: who.name, projectId: proj.id, taskId };
  }
}, 120_000);

afterAll(async () => {
  await browser?.close();
  const problems = await zz.cleanUp();
  expect(problems, problems.join("\n")).toEqual([]);
}, 60_000);

describe("qa:TC missing APL-2770: a long assignee name does not cover the task title on the project page", () => {
  for (const ex of EXAMPLES) {
    it(`qa:TC missing AC1: clicking the centre of the title opens the task, not Choose assignee (${ex.len} characters, ${ex.width}x${ex.height})`, async () => {
      const c = cases[ex.len];
      const page = await openProject(c, ex.width, ex.height);
      try {
        const t = await box(page, title(page));
        // A real pointer click at the title's centre, so whatever is on top there receives it.
        await page.mouse.click(t.x + t.width / 2, t.y + t.height / 2);
        await expectTaskDialog(page);
        expect(await chooseAssignee(page).count()).toBe(0);
      } finally {
        await page.context().close();
      }
    });
  }

  it("qa:TC missing AC2: the 60-character assignee is truncated beside the title, and the full name stays available (1280x800)", async () => {
    const c = cases[60];
    const page = await openProject(c, 1280, 800);
    try {
      const t = await box(page, title(page));
      const a = await box(page, assigneeButton(page, c.name));
      expect(intersects(t, a), `title ${JSON.stringify(t)} vs assignee ${JSON.stringify(a)}`).toBe(false);
      // On main the name took its full width and squeezed the title to ~32 px, one or two letters per line (114 px tall).
      // One line of title text is 19 px tall.
      expect(t.height, `title ${JSON.stringify(t)}`).toBeLessThan(30);
      // Truncated: the name's text is wider than the control that shows it.
      expect(await assigneeButton(page, c.name).evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
      // Full name: in the accessible name (found above by its exact name) and the title attribute (hover).
      expect(await assigneeButton(page, c.name).getAttribute("title")).toBe(c.name);
    } finally {
      await page.context().close();
    }
  });

  it("qa:TC missing AC3: the assignee control, row selection, keyboard open and the complete tick behave as on main (60 characters, 1280x800)", async () => {
    const c = cases[60];
    const page = await openProject(c, 1280, 800);
    try {
      await assigneeButton(page, c.name).click();
      await chooseAssignee(page).waitFor({ state: "visible" });
      expect(await taskDialog(page).count()).toBe(0);
      await page.keyboard.press("Escape");
      await chooseAssignee(page).waitFor({ state: "detached" });

      const select = page.getByRole("checkbox", { name: `Select "${TITLE}"`, exact: true });
      await select.check();
      expect(await select.isChecked()).toBe(true);
      expect(await taskDialog(page).count()).toBe(0);
      await select.uncheck();

      const row = page.getByRole("link", { name: new RegExp(TITLE) });
      await row.focus();
      await page.keyboard.press("Enter");
      await expectTaskDialog(page);
      await page.keyboard.press("Escape");
      await taskDialog(page).waitFor({ state: "detached" });

      await page.getByRole("button", { name: `Complete "${TITLE}"`, exact: true }).click();
      await page.getByRole("button", { name: `Reopen "${TITLE}"`, exact: true }).waitFor({ state: "visible" });
      expect(await taskDialog(page).count()).toBe(0);
      const done = await leader.c.get(`/api/tasks/${c.taskId}`);
      expect(done.json.task.completedAt).toBeTruthy();
    } finally {
      await page.context().close();
    }
  });
});
