// SHO-BUG-12 Slow load shows 'Could not reach the server' because in-flight status 0 is treated as a network failure (Linear APL-2647, PR #12).
// The issue's four unnumbered acceptance criteria are taken in order as AC1 to AC4.
// Slow and failed loads are simulated in the browser (route interception), so nothing on the server is touched.
// The file skips only when SHO_QA_PASS is unset. Slow loads expect the skeleton (the fix is on main).
import type { Page } from "@playwright/test";
import { test, expect, zz } from "../support";
import { newProject, newTask, type Who } from "../g2";
import { PASS, passwordOk } from "./qa";

// Pam has not published a TC hash. The marker is the literal "qa:TC missing".
const tag = (id: string) => ({ annotation: [{ type: "ac", description: id }, { type: "qa:TC", description: "qa:TC missing" }] });

// The status role's accessible name is empty: "Loading" is only text inside it. There is no aria-label.
// The grey bars are aria-hidden and have no role, name, or text, so the skeleton is the status plus that text.
const skeleton = (page: Page) => page.getByRole("status").filter({ hasText: "Loading" });
const skeletonRows = (page: Page) => skeleton(page).getByText("Loading", { exact: true });

test.beforeAll(() => {
  test.skip(!PASS, "Set SHO_QA_PASS (the password for nakul17+ aliases).");
  if (!passwordOk(PASS)) throw new Error("SHO_QA_PASS must be at least 8 characters with a letter and a number.");
});

const DELAY = 2500;
const LOAD_FAILED = "Could not reach the server.";

type Screen = { name: string; path: (ids: Ids) => string; api: (ids: Ids) => RegExp };
type Ids = { project: string; person: string };

// Each screen and the API reads its first paint waits on (same matchers as tests/viewport/loading.test.ts in PR #12).
const SCREENS: Screen[] = [
  { name: "ProjectView", path: (i) => `/projects/${i.project}`, api: (i) => new RegExp(`/api/projects/${i.project}(/tasks)?$`) },
  { name: "Activity", path: (i) => `/projects/${i.project}/activity`, api: (i) => new RegExp(`/api/projects/${i.project}/activity$`) },
  { name: "Members", path: (i) => `/projects/${i.project}/members`, api: (i) => new RegExp(`/api/projects/${i.project}$`) },
  { name: "Trash", path: (i) => `/projects/${i.project}/trash`, api: (i) => new RegExp(`/api/projects/${i.project}(/trash)?$`) },
  { name: "Person", path: (i) => `/team/${i.person}`, api: (i) => new RegExp(`/api/team/${i.person}$`) },
];

/** A ZZ-TEST project with one task; the person page is the Super Admin's own, so no person is created. */
async function ids(admin: Who, later: (fn: () => Promise<unknown>) => void): Promise<Ids> {
  const p = await newProject(admin, later, { label: "bug12 loading" });
  await newTask(admin, p.id);
  return { project: p.id, person: admin.user.id as string };
}

async function open(page: Page, path: string, api: RegExp, handle: Parameters<Page["route"]>[1]) {
  await page.route((url) => api.test(url.pathname), handle);
  await page.goto(path, { waitUntil: "commit" });
}

test.describe("SHO-BUG-12 / APL-2647", () => {
  test("AC1: a request still in flight is never shown as a network failure (ProjectView)", tag("APL-2647 AC1"), async ({ admin, later }) => {
    const i = await ids(admin, later);
    const page = admin.page;
    await open(page, SCREENS[0].path(i), SCREENS[0].api(i), async (r) => { await new Promise((x) => setTimeout(x, DELAY)); await r.continue(); });
    await expect(skeletonRows(page)).not.toHaveCount(0);
    await expect(page.getByRole("alert", { name: LOAD_FAILED })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
  });

  for (const s of SCREENS) {
    test(`AC2 and AC4 (${s.name}): a first load slower than 400 ms shows the shared Skeleton, not LoadFailed or "Loading…"`, tag(`APL-2647 AC2 AC4 ${s.name}`), async ({ admin, later }) => {
      const i = await ids(admin, later);
      const page = admin.page;
      await open(page, s.path(i), s.api(i), async (r) => { await new Promise((x) => setTimeout(x, DELAY)); await r.continue(); });
      await expect(skeletonRows(page)).not.toHaveCount(0, { timeout: DELAY - 500 });
      await expect(page.getByText(LOAD_FAILED)).toHaveCount(0);
      await expect(page.getByText("Loading…")).toHaveCount(0);
      await expect(skeleton(page)).toHaveCount(0, { timeout: 15_000 }); // gone once the answer arrives
      await expect(page.getByText(LOAD_FAILED)).toHaveCount(0);
    });
  }

  for (const s of SCREENS) {
    test(`AC3 and AC4 (${s.name}): a real network error still shows "Could not reach the server." with Retry`, tag(`APL-2647 AC3 AC4 ${s.name}`), async ({ admin, later }) => {
      const i = await ids(admin, later);
      const page = admin.page;
      await open(page, s.path(i), s.api(i), (r) => r.abort("internetdisconnected"));
      await expect(page.getByText(LOAD_FAILED)).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    });
  }

  test("AC3 (5xx, ProjectView): a 503 shows LoadFailed, and Retry loads the project once the server answers", tag("APL-2647 AC3"), async ({ admin, later }) => {
    const i = await ids(admin, later);
    const page = admin.page;
    let fail = true;
    await open(page, SCREENS[0].path(i), SCREENS[0].api(i), (r) => (fail ? r.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Service unavailable" }) }) : r.continue()));
    await expect(page.getByText(LOAD_FAILED)).toBeVisible({ timeout: 15_000 });
    fail = false;
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByText(LOAD_FAILED)).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByRole("checkbox", { name: `Select "${zz("task")}"`, exact: true })).toBeVisible();
  });
});
