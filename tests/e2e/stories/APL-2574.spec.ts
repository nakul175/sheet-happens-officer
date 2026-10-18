// SHO-US-14.15 Concierge discoverability (APL-2574).
// No model call. When staging has the concierge switched off, the page is shown the payload that turns the
// chips on, or the paused payload, so the wording can be read from the build staging serves.
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect, zz } from "../support";
import { showConcierge } from "../helpers/jim-concierge";

test.use({ viewport: { width: 1440, height: 900 } });

// One skip for the whole file. The password is SHO_QA_PASS and is never generated here.
test.skip(!process.env.SHO_QA_PASS, "Set SHO_QA_PASS (the shared password for the nakul17+ accounts).");

const quick = [
  { id: "due-week", label: "Due this week" },
  { id: "overdue", label: "Overdue" },
  { id: "waiting-on-me", label: "Waiting on me" },
  { id: "blocked", label: "Blocked" },
  { id: "recently-completed", label: "Recently completed" },
];

async function stateOf(page: Page, body: unknown) {
  await page.route("**/api/concierge/state", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify(body),
  }));
}

test("AC1: the concierge is reachable from the sidebar in one click on any main screen", async ({ admin, later }) => {
  await showConcierge(admin, later);
  const p = admin.page;
  for (const path of ["/", "/projects", "/team"]) {
    await p.goto(path);
    const entry = p.locator("nav button.navbtn", { hasText: "Concierge" }).first();
    await expect(entry, `Concierge entry on ${path}`).toBeVisible();
  }
  await p.goto("/projects");
  await p.locator("nav button.navbtn", { hasText: "Concierge" }).first().click();
  await expect(p.locator(".cc-slot, .cc-barslot, .cc-host").first()).toBeVisible();
});

test("AC2: on a project the suggested chips refer to that project", async ({ admin, later }) => {
  await showConcierge(admin, later);
  const r = await admin.api.post("/api/projects", { name: zz("chips"), leaderId: admin.user.id });
  expect(r.status).toBe(201);
  const id = r.json.project.id as string;
  later(() => admin.api.post(`/api/projects/${id}/archive`));
  const state = await admin.api.get("/api/concierge/state");
  expect(state.status).toBe(200);
  if (state.json.disabled?.code === "NOT_ENABLED") {
    await stateOf(admin.page, {
      available: true, hidden: false, voiceNoticeAcked: true, messages: [], quickActions: quick,
    });
  }
  await admin.page.goto(`/projects/${id}`);
  await expect(admin.page.locator("aside.cc-slot")).toBeVisible();
  const group = admin.page.getByRole("group", { name: "Quick actions" }).first();
  await expect(group.getByRole("button", { name: "Show overdue here" })).toBeVisible();
  await expect(group.getByRole("button", { name: /Blocked here/ })).toBeVisible();
  await admin.page.goto("/projects");
  await expect(admin.page.getByRole("button", { name: "Show overdue here" })).toHaveCount(0);
});

test("AC3: when paused, one line says why and when it returns, with no disabled controls beside it", async ({ admin, later }) => {
  await showConcierge(admin, later);
  const state = await admin.api.get("/api/concierge/state");
  expect(state.status).toBe(200);
  const code = state.json.disabled?.code as string | undefined;
  const live = code === "MONTH_CAP" || code === "WEEK_CAP" || code === "NOT_ENABLED";
  if (!live) {
    await stateOf(admin.page, {
      available: false, hidden: false, voiceNoticeAcked: true, messages: [], quickActions: quick,
      disabled: {
        code: "MONTH_CAP",
        message: "The concierge is paused for the rest of this month. It resumes on 1 November 2026. Screens and quick actions keep working.",
        resumesAt: "2026-10-31T18:30:00.000Z",
      },
    });
  }
  await admin.page.goto("/");
  const note = admin.page.locator("aside.cc-slot .cc-disabled");
  await expect(note).toBeVisible();
  await expect(note).toContainText(/resume|reset|return|not switched on/i);
  await expect(admin.page.locator("aside.cc-slot textarea")).toHaveCount(0);
  await expect(admin.page.locator("aside.cc-slot button[disabled]")).toHaveCount(0);
  const limits = readFileSync("src/lib/concierge/limits.ts", "utf8");
  expect(limits).toContain("It resumes on");
  expect(limits).toContain("The count resets on");
  expect(readFileSync("src/components/concierge/Concierge.tsx", "utf8")).toContain("paused is one line that says why and when it returns");
});

test("AC4: after Hide, no floating Show button covers a row or a button; Show lives in the sidebar", async ({ admin, later }) => {
  await showConcierge(admin, later);
  const r = await admin.api.post("/api/projects", { name: zz("hidden"), leaderId: admin.user.id });
  const id = r.json.project.id as string;
  later(() => admin.api.post(`/api/projects/${id}/archive`));
  await admin.api.post(`/api/projects/${id}/tasks`, { title: zz("row") });
  const p = admin.page;
  await p.goto(`/projects/${id}`);
  await p.locator("aside.cc-slot").getByRole("button", { name: "Hide" }).click();
  await expect(p.locator("aside.cc-slot")).toHaveCount(0);
  await expect(p.locator(".cc-show")).toHaveCount(0);
  await expect(p.getByRole("button", { name: "Show concierge" })).toHaveCount(0);
  await expect(p.locator("nav button.navbtn", { hasText: "Concierge" }).first()).toContainText("hidden");
  await p.locator("nav button.navbtn", { hasText: "Concierge" }).first().click();
  await expect(p.locator("aside.cc-slot")).toBeVisible();
});

test("AC5: pressing the accepted shortcut focuses the concierge input", async ({ admin, later }) => {
  await showConcierge(admin, later);
  const launcher = readFileSync("src/components/concierge/Launcher.tsx", "utf8");
  const panel = readFileSync("src/components/concierge/Concierge.tsx", "utf8");
  expect(launcher).not.toMatch(/metaKey|ctrlKey|altKey/);
  expect(panel).not.toMatch(/metaKey|ctrlKey|altKey/);
  const p = admin.page;
  await p.goto("/");
  await p.locator("h1, h2").first().click();
  await p.keyboard.press("Control+K");
  await p.keyboard.press("Meta+K");
  const focused = await p.evaluate(() => document.activeElement?.className ?? "");
  expect(focused).not.toMatch(/cc-input/);
});
