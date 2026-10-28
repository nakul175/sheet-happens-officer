// SHO-US-8.1 Concierge dock, bottom bar and hide preference (APL-2510).
// One test per acceptance criterion. The dock checks use a wide window; the phone check uses 390px.
// AC5 needs a monthly cap, a weekly cap or a provider outage. Staging cannot switch those on, so the test
// runs only when the build is already in one of those states and skips otherwise.
// No model call: a quick action is enough to put one exchange in the thread (AC3).
import { test, expect } from "../support";
import { newProject } from "../g2";
import { cleanChat, quickAction } from "../helpers/jim-http";
import { conciergeLive, conciergeOff } from "../helpers/jim-gate";
import { requireConcierge, secondScreen, showConcierge } from "../helpers/jim-concierge";

test.use({ viewport: { width: 1440, height: 900 } });

test("AC1: a dock on My tasks, Projects, a project list and Team, and a bottom bar on the project board", async ({ admin, later }) => {
  await requireConcierge(admin);
  await showConcierge(admin, later);
  const project = await newProject(admin, later, { label: "us81-dock" });
  const p = admin.page;
  for (const path of ["/", "/projects", `/projects/${project.id}`, "/team"]) {
    await p.goto(path);
    await expect(p.locator("aside.cc-slot"), `dock on ${path}`).toBeVisible();
    await expect(p.locator("aside.cc-barslot"), `no bottom bar on ${path}`).toHaveCount(0);
  }
  await p.goto(`/projects/${project.id}?view=board`);
  await expect(p.locator("aside.cc-barslot")).toBeVisible();
  await expect(p.locator("aside.cc-slot")).toHaveCount(0);
});

test("AC2: hiding the concierge stays hidden after a reload and a sign-in on another session", async ({ admin, browser, later }) => {
  await requireConcierge(admin);
  await showConcierge(admin, later);
  const p = admin.page;
  await p.goto("/");
  await expect(p.locator("aside.cc-slot")).toBeVisible();
  await p.locator("aside.cc-slot").getByRole("button", { name: "Hide" }).click();
  await expect(p.locator("aside.cc-slot")).toHaveCount(0);
  await p.reload();
  await expect(p.locator("aside.cc-slot")).toHaveCount(0);
  const other = await secondScreen(browser, later);
  await other.goto("/");
  await expect(other.locator("aside.cc-slot")).toHaveCount(0);
  await expect(other.locator("nav.nav button.navbtn", { hasText: "Concierge" })).toContainText("hidden");
  await other.locator("nav.nav button.navbtn", { hasText: "Concierge" }).click();
  await expect(other.locator("aside.cc-slot")).toBeVisible();
});

test("AC3: moving from a project list to its board keeps the same conversation", async ({ admin, later }) => {
  await requireConcierge(admin);
  await showConcierge(admin, later);
  await cleanChat(admin, later);
  const project = await newProject(admin, later, { label: "us81-thread" });
  const r = await quickAction(admin, "due-week", project.id);
  expect(r.status, r.body).toBe(200);
  const marker = r.json.messages?.[0]?.text as string;
  expect(marker, "the quick action names the project, so the same line can be found on both screens").toContain(project.name);
  const p = admin.page;
  await p.goto(`/projects/${project.id}`);
  await expect(p.locator("aside.cc-slot")).toContainText(marker);
  await p.goto(`/projects/${project.id}?view=board`);
  await p.locator("aside.cc-barslot").getByRole("button", { name: "Open chat" }).click();
  await expect(p.locator("aside.cc-barslot")).toContainText(marker);
});

test("AC4: at 390 pixels a floating button opens the concierge full screen", async ({ admin, later }) => {
  await requireConcierge(admin);
  await showConcierge(admin, later);
  const p = admin.page;
  await p.setViewportSize({ width: 390, height: 844 });
  await p.goto("/");
  const fab = p.locator("button.fab");
  await expect(fab).toBeVisible();
  await expect(p.locator("aside.cc-slot")).toBeHidden();
  await fab.click();
  const sheet = p.getByRole("dialog", { name: "Concierge" });
  await expect(sheet).toBeVisible();
  const box = await sheet.boundingBox();
  expect(box && box.width > 300 && box.height > 600, "the sheet covers the phone").toBe(true);
});

test("AC5: a cap or a provider outage leaves the concierge visible but disabled, with a plain reason, and the app still works", async ({ admin, later }) => {
  const c = await conciergeLive(admin);
  test.skip(!c.live, conciergeOff(c));
  const code = (await admin.api.get("/api/concierge/state")).json.disabled?.code as string | undefined;
  test.skip(
    code !== "MONTH_CAP" && code !== "WEEK_CAP" && code !== "PROVIDER_DOWN",
    "Staging cannot switch the monthly cost cap, the weekly cap or the provider's availability. This build is not already in one of those paused states, so the disabled reason cannot be raised from a browser session.",
  );
  await showConcierge(admin, later);
  const p = admin.page;
  await p.goto("/");
  const note = p.locator("aside.cc-slot .cc-disabled");
  await expect(note).toBeVisible();
  await expect(note).not.toBeEmpty();
  if (code === "MONTH_CAP" || code === "WEEK_CAP") await expect(note).toContainText(/reset|resume|return/i);
  await expect(p.getByRole("heading", { name: "My tasks" })).toBeVisible();
  expect((await admin.api.get("/api/projects")).status).toBe(200);
});
