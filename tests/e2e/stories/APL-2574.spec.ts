// SHO-US-14.15 Concierge discoverability (APL-2574).
import { randomUUID } from "node:crypto";
import { test, expect, zz, BASE_URL } from "../support";
import { localPgPool, schemaFromDatabaseUrl } from "../helpers/local-db-pool";
import { showConcierge } from "../helpers/jim-concierge";
import { settledConciergeContent } from "../helpers/concierge-readiness";

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
  const dock = admin.page.getByRole("complementary", { name: "Concierge" });
  await expect(dock).toBeVisible();
  // The landmark arrives before async state. A transient missing disabled notice is not proof that chips are ready.
  const content = await settledConciergeContent(dock);
  test.skip(content.kind === "disabled" && /not switched on yet/i.test(content.reason), "The concierge is not switched on in this environment, so it shows no suggested chips.");
  const quick = dock.getByRole("group", { name: "Quick actions" });
  await expect(quick.getByRole("button", { name: "Show overdue here" })).toBeVisible();
  await expect(quick.getByRole("button", { name: /Blocked here/ })).toBeVisible();
  await admin.page.goto("/projects");
  await expect(admin.page.getByRole("button", { name: "Show overdue here" })).toHaveCount(0); // generic chips elsewhere
});

test("AC3: when paused, one line says why and when it returns, with no disabled controls beside it", async ({ admin, later }) => {
  const database = process.env.DATABASE_URL;
  const schema = database ? schemaFromDatabaseUrl(database) : undefined;
  expect(["127.0.0.1", "localhost"]).toContain(new URL(BASE_URL).hostname);
  expect(schema, "A dedicated owned local schema is required for budget fixtures").toMatch(/^sho_2708_[a-z0-9_]+$/);
  expect(process.env.SHO_OWNED_TEST_SCHEMA).toBe(schema);
  const initial = await admin.api.get("/api/concierge/state");
  expect(initial.json.disabled, "Use the owned enabled app; no provider call is made by this case").toBeUndefined();
  const usage = await admin.api.get("/api/usage");
  expect(usage.status).toBe(200);
  const cap = usage.json.ceiling.weeklyMessageCap as number;
  expect(cap).toBeGreaterThan(0);
  expect(cap, "Bound synthetic fixture size").toBeLessThanOrEqual(1000);
  const ids = Array.from({ length: cap }, () => randomUUID().replaceAll("-", ""));
  const pool = localPgPool(database);
  try {
    const actor = await pool.query('SELECT email FROM "User" WHERE id=$1', [admin.user.id]);
    expect(actor.rows[0]?.email).toBe(admin.user.email);
    await pool.query('INSERT INTO "ModelUsage"(id,"userId",model,"inputTokens","outputTokens","costUsd",counted,"createdAt") SELECT id,$2,$3,0,0,0,true,NOW() FROM unnest($1::text[]) AS id', [ids, admin.user.id, "ZZ-TEST paused-UI"]);
    const state = await admin.api.get("/api/concierge/state");
    expect(state.json.disabled?.code).toBe("WEEK_CAP");
    expect(Date.parse(state.json.disabled.resumesAt)).toBeGreaterThan(Date.now());
    await showConcierge(admin, later);
    await admin.page.goto("/");
    const dock = admin.page.getByRole("complementary", { name: "Concierge" });
    const notice = dock.locator(".cc-disabled");
    await expect(notice).toHaveCount(1);
    await expect(notice).toContainText(state.json.disabled.message);
    await expect(notice).toContainText(/resets.*India time/);
    await expect(dock.locator("button:disabled, input:disabled, textarea:disabled")).toHaveCount(0);
    await expect(dock.getByLabel("Message the concierge")).toHaveCount(0);
    test.info().annotations.push({ type: "evidence-scope", description: "Real budget pause from owned local ledger rows; no provider call and no mocked browser response." });
  } finally {
    await pool.query('DELETE FROM "ModelUsage" WHERE id=ANY($1::text[]) AND "userId"=$2', [ids, admin.user.id]);
    await pool.end();
  }
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
