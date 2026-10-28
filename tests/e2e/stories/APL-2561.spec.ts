// SHO-US-14.2 Honest loading, empty, error and offline states (Linear APL-2561).
// Network failures and slow loads are simulated in the browser (route interception), so nothing on the server is touched.
// The file skips only when SHO_QA_PASS is unset. The slow project load expects the skeleton (APL-2647 is on main).
import { test, expect, zz } from "../support";
import { newProject } from "../g2";
import { PASS, passwordOk } from "./qa";

// qa:TC uses the AC id already on the test. Pam has not published a separate hash for these cases.
const tag = (id: string) => ({ annotation: [{ type: "ac", description: id }, { type: "qa:TC", description: id }] });

// The status role's accessible name is empty: "Loading" is only text inside it. There is no aria-label.
// The grey bars are aria-hidden and have no role, name, or text, so the skeleton is the status plus that text.
const skeleton = (page: import("@playwright/test").Page) => page.getByRole("status").filter({ hasText: "Loading" });
const skeletonRows = (page: import("@playwright/test").Page) => skeleton(page).getByText("Loading", { exact: true });

test.beforeAll(() => {
  test.skip(!PASS, "Set SHO_QA_PASS (the password for nakul17+ aliases).");
  if (!passwordOk(PASS)) throw new Error("SHO_QA_PASS must be at least 8 characters with a letter and a number.");
});

async function project(admin: { api: import("../support").Api; user: { id: string } }, later: (f: () => Promise<unknown>) => void, label: string) {
  const r = await admin.api.post("/api/projects", { name: zz(label), leaderId: admin.user.id });
  expect(r.status).toBe(201);
  const id = r.json.project.id as string;
  later(() => admin.api.post(`/api/projects/${id}/archive`));
  return { id, name: zz(label) };
}

test("AC1: a load slower than 400 ms shows a skeleton of the layout (My tasks)", tag("APL-2561 AC1"), async ({ admin }) => {
  const page = admin.page;
  await page.route("**/api/my-tasks", async (r) => { await new Promise((x) => setTimeout(x, 2500)); await r.continue(); });
  await page.goto("/", { waitUntil: "commit" });
  const skel = skeleton(page);
  await expect(skel).toHaveAttribute("aria-busy", "true", { timeout: 2000 });
  await expect(skeletonRows(page)).not.toHaveCount(0, { timeout: 2000 });
  await expect(skel).toHaveCount(0, { timeout: 8000 }); // gone when the data arrives
});

test("AC1 and AC2 (project screen): a slow load shows a skeleton and does not claim the server is unreachable", tag("APL-2561 AC1 AC2"), async ({ admin, later }) => {
  const p = await project(admin, later, "14.2 slow");
  const page = admin.page;
  await page.route(new RegExp(`/api/projects/${p.id}(/tasks)?(\\?|$)`), async (r) => { await new Promise((x) => setTimeout(x, 2500)); await r.continue(); });
  await page.goto(`/projects/${p.id}`, { waitUntil: "commit" });
  await expect(skeletonRows(page)).not.toHaveCount(0);
  await expect(page.getByRole("alert", { name: "Could not reach the server." })).toHaveCount(0);
});

test("AC2: a dead network or a 5xx says 'Could not reach the server' with Retry, never 'not a member'", tag("APL-2561 AC2"), async ({ admin, later }) => {
  const p = await project(admin, later, "14.2 down");
  const page = admin.page;
  await page.route(new RegExp(`/api/projects/${p.id}(\\?|$)`), (r) => r.abort("connectionfailed"));
  await page.goto(`/projects/${p.id}`);
  await expect(page.getByText("Could not reach the server.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(page.getByText(/isn't available|not a member/i)).toHaveCount(0);
  await page.unroute(new RegExp(`/api/projects/${p.id}(\\?|$)`));
  await page.route(new RegExp(`/api/projects/${p.id}(\\?|$)`), (r) => r.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Service unavailable" }) }));
  await page.goto(`/projects/${p.id}`);
  await expect(page.getByText("Could not reach the server.")).toBeVisible();
  await expect(page.getByText(/isn't available|not a member/i)).toHaveCount(0);
});

test("AC3: a real 404 or 403 still shows the 'isn't available / not a member' message", tag("APL-2561 AC3"), async ({ admin }) => {
  const page = admin.page;
  await page.goto("/projects/zz-test-does-not-exist");
  await expect(page.getByText("This project isn't available")).toBeVisible();
  await expect(page.getByText(/not a member/i)).toBeVisible();
  await expect(page.getByText("Could not reach the server.")).toHaveCount(0);
});

test("AC3 (server 403): the same message for a project the server refuses", tag("APL-2561 AC3"), async ({ admin, later }) => {
  const p = await project(admin, later, "14.2 forbidden");
  const page = admin.page;
  await page.route(new RegExp(`/api/projects/${p.id}(\\?|$)`), (r) => r.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "Not a member." }) }));
  await page.goto(`/projects/${p.id}`);
  await expect(page.getByText("This project isn't available")).toBeVisible();
  await expect(page.getByText("Could not reach the server.")).toHaveCount(0);
});

test("AC4: an empty My tasks says what the screen is for and offers the next step", tag("APL-2561 AC4"), async ({ admin, later }) => {
  await newProject(admin, later, { label: "14.2 plate" }); // "+ New task" only renders when there is a project this person can add to
  const page = admin.page;
  await page.route("**/api/my-tasks", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ overdue: [], next7: [], later: [], waitingOnMe: [], waitingOnOthers: [] }) }));
  await page.goto("/");
  await expect(page.getByText("Nothing on your plate.")).toBeVisible();
  await expect(page.getByText(/Tasks assigned to you, or that you collaborate on, show up here/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Open a project" })).toBeVisible();
  await expect(page.getByRole("button", { name: "New task", exact: true })).toBeVisible();
});

test("AC4 (project): an empty project says so", tag("APL-2561 AC4"), async ({ admin, later }) => {
  const p = await project(admin, later, "14.2 empty");
  await admin.page.goto(`/projects/${p.id}`);
  await expect(admin.page.getByRole("region", { name: "To do" }).getByText("No tasks here.", { exact: true })).toBeVisible();
});

test("AC5: Retry succeeds and the screen loads without a full page reload", tag("APL-2561 AC5"), async ({ admin, later }) => {
  const p = await project(admin, later, "14.2 retry");
  const page = admin.page;
  const re = new RegExp(`/api/projects/${p.id}(\\?|$)`);
  await page.route(re, (r) => r.abort("connectionfailed"));
  await page.goto(`/projects/${p.id}`);
  await expect(page.getByText("Could not reach the server.")).toBeVisible();
  await page.evaluate(() => { (window as Window & { __noReload?: string }).__noReload = "still here"; });
  await page.unroute(re); // the network is back
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("heading", { level: 1, name: p.name })).toBeVisible();
  await expect(page.getByText("Could not reach the server.")).toHaveCount(0);
  expect(await page.evaluate(() => (window as Window & { __noReload?: string }).__noReload)).toBe("still here"); // same document: no reload
});
