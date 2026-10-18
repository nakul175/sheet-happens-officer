import { expect, test } from "@playwright/test";

// NJ's production smoke tag is @readonly. Sign-in is the only write.

test("production health and version @readonly", async ({ request }) => {
  const health = await request.get("/api/health");
  expect(health.ok()).toBeTruthy();
  const version = await request.get("/api/version");
  expect(version.ok()).toBeTruthy();
  const body = await version.json();
  expect(body).toEqual({
    sha: process.env.RELEASE || null,
    digest: process.env.ARTIFACT_SHA256 || null,
  });
  expect(JSON.stringify(body)).not.toMatch(/postgres(ql)?:\/\//);
});

test("smoke account can sign in and read @readonly", async ({ request }) => {
  const email = process.env.SMOKE_EMAIL;
  const password = process.env.SMOKE_PASSWORD;
  expect(email, "SMOKE_EMAIL is required").toBeTruthy();
  expect(password, "SMOKE_PASSWORD is required").toBeTruthy();
  const sign = await request.post("/api/auth/signin", { data: { email, password } });
  expect(sign.ok()).toBeTruthy();
  const mine = await request.get("/api/my-tasks");
  expect(mine.ok()).toBeTruthy();
});

test("writes stay off production @write", async () => {
  const target = `${process.env.TASKBOARD_URL ?? ""} ${process.env.BASE_URL ?? ""} ${process.env.APP_URL ?? ""}`;
  if (target.includes("app.sheethappensofficer.com")) {
    throw new Error("@write tests must not run against production");
  }
});
