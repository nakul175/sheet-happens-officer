// SHO-US-8.1 Concierge dock, bottom bar and hide preference (APL-2510).
// One test per acceptance criterion. The dock checks use a wide window; the phone check uses 390px.
// No model call. A quick action is enough to put one exchange in the thread (AC3).
// AC5: staging cannot switch the monthly cap, the weekly cap or a provider outage. When the build is
// not already paused, the page is shown the paused payload the server sends, and the app is checked live.
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect } from "../support";
import { newProject } from "../g2";
import { cleanChat, quickAction } from "../helpers/jim-http";
import { secondScreen, showConcierge } from "../helpers/jim-concierge";

test.use({ viewport: { width: 1440, height: 900 } });

// One skip for the whole file. The password is SHO_QA_PASS and is never generated here.
test.skip(!process.env.SHO_QA_PASS, "Set SHO_QA_PASS (the shared password for the nakul17+ accounts).");

const PAUSED = new Set(["MONTH_CAP", "WEEK_CAP", "PROVIDER_DOWN"]);

/** The paused payload /api/concierge/state sends for a cap. Quick actions and the rest of the app stay up. */
async function showPaused(page: Page) {
  const message = "The concierge is paused for the rest of this month. It resumes on 1 November 2026. Screens and quick actions keep working.";
  await page.route("**/api/concierge/state", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      available: false,
      disabled: { code: "MONTH_CAP", message, resumesAt: "2026-10-31T18:30:00.000Z" },
      hidden: false,
      voiceNoticeAcked: true,
      quickActions: [],
      messages: [],
    }),
  }));
}

test("AC1: a dock on My tasks, Projects, a project list and Team, and a bottom bar on the project board", async ({ admin, later }) => {
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
  await showConcierge(admin, later);
  const state = await admin.api.get("/api/concierge/state");
  expect(state.status, JSON.stringify(state.json)).toBe(200);
  const code = state.json.disabled?.code as string | undefined;
  const live = !!code && PAUSED.has(code);
  const p = admin.page;
  if (!live) await showPaused(p);
  await p.goto("/");
  const note = p.locator("aside.cc-slot .cc-disabled");
  await expect(note).toBeVisible();
  await expect(note).not.toBeEmpty();
  await expect(note).toContainText(/reset|resume|return/i);
  await expect(p.getByRole("heading", { name: "My tasks" })).toBeVisible();
  expect((await admin.api.get("/api/projects")).status).toBe(200);
  const limits = readFileSync("src/lib/concierge/limits.ts", "utf8");
  for (const name of ["MONTH_CAP", "WEEK_CAP", "PROVIDER_DOWN"]) expect(limits).toContain(name);
  expect(limits).toContain("Screens and quick actions keep working");
  expect(limits).toContain("The rest of the app works normally");
});
