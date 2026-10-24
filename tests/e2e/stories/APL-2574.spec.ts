// SHO-US-14.15 Concierge discoverability (APL-2574).
import { test, expect, zz } from "../support";

test.use({ viewport: { width: 1440, height: 900 } });

test("AC1: the concierge is reachable from the sidebar in one click on any main screen", async ({ admin }) => {
  const p = admin.page;
  for (const path of ["/", "/projects", "/team"]) {
    await p.goto(path);
    const entry = p.getByRole("navigation").getByRole("button", { name: /^Concierge/ }).first();
    await expect(entry, `Concierge entry on ${path}`).toBeVisible();
  }
  await p.goto("/projects");
  await p.getByRole("navigation").getByRole("button", { name: /^Concierge/ }).first().click();
  // one click brings the concierge up: the docked panel, or the full-screen sheet where a screen has no dock
  await expect(p.getByRole("complementary", { name: "Concierge" }).or(p.getByRole("dialog", { name: "Concierge" })).first()).toBeVisible();
});

test("AC2: on a project the suggested chips refer to that project", async ({ admin, later }) => {
  const r = await admin.api.post("/api/projects", { name: zz("chips"), leaderId: admin.user.id });
  expect(r.status).toBe(201);
  const id = r.json.project.id as string;
  later(() => admin.api.post(`/api/projects/${id}/archive`));
  await admin.page.goto(`/projects/${id}`);
  await expect(admin.page.getByRole("complementary", { name: "Concierge" })).toBeVisible();
  // When the concierge is not switched on (MODEL_DATA_APPROVED off) it shows no chips at all, so there is nothing to check.
  test.skip(await admin.page.getByText("not switched on yet").isVisible(), "The concierge is not switched on in this environment, so it shows no suggested chips.");
  const quick = admin.page.getByRole("group", { name: "Quick actions" }).first();
  await expect(quick.getByRole("button", { name: "Show overdue here" })).toBeVisible();
  await expect(quick.getByRole("button", { name: /Blocked here/ })).toBeVisible();
  await admin.page.goto("/projects");
  await expect(admin.page.getByRole("button", { name: "Show overdue here" })).toHaveCount(0); // generic chips elsewhere
});

test.skip("AC3: when paused, one line says why and when it returns, with no disabled controls beside it", async () => {
  // The paused state is produced by the monthly ceiling, the weekly cap or MODEL_DATA_APPROVED being off on the server.
  // A browser test cannot switch those settings on staging; tests/ux-orientation.test.ts and tests/concierge-limits.test.ts cover the wording.
});

test("AC4: after Hide, no floating Show button covers a row or a button; Show lives in the sidebar", async ({ admin, later }) => {
  const r = await admin.api.post("/api/projects", { name: zz("hidden"), leaderId: admin.user.id });
  const id = r.json.project.id as string;
  later(() => admin.api.post(`/api/projects/${id}/archive`));
  await admin.api.post(`/api/projects/${id}/tasks`, { title: zz("row") });
  const p = admin.page;
  await p.goto(`/projects/${id}`);
  // The dock panel is the concierge landmark that offers Hide; the page keeps other concierge regions.
  const dock = p.getByRole("complementary", { name: "Concierge" }).filter({ has: p.getByRole("button", { name: "Hide" }) });
  await dock.getByRole("button", { name: "Hide" }).click();
  await expect(dock).toHaveCount(0);
  // The floating pill SHO-US-14.15 AC4 removed: no button by that name anywhere on the page.
  await expect(p.getByRole("button", { name: "Show concierge" })).toHaveCount(0);
  await expect(p.getByRole("navigation").getByRole("button", { name: /^Concierge/ }).first()).toContainText("hidden");
  await p.getByRole("navigation").getByRole("button", { name: /^Concierge/ }).first().click(); // leave the person's setting as we found it
  await expect(p.getByRole("complementary", { name: "Concierge" })).toBeVisible();
});

test.skip("AC5: pressing the accepted shortcut focuses the concierge input", async () => {
  // The story says "given a shortcut is accepted by the owner". No concierge shortcut is accepted or built
  // (the shortcut list of SHO-US-14.6 has none), so there is nothing to press.
});
