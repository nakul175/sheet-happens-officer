// APL-2681 staging mail sink. Live story spec: the running app, through the browser and API.
// The only skip is the file-level beforeAll below. It names APL-2681 when SHO_QA_PASS or the mail sink is missing.
import { readFileSync } from "node:fs";
import { test, expect, RUN } from "../support";
import { alias, BASE_URL, PASS, waitForQaMail } from "./qa";

function screenSize(): { width: number; height: number } {
  return process.env.PW_VIEWPORT === "390x844" ? { width: 390, height: 844 } : { width: 1280, height: 720 };
}

test.describe("APL-2681 staging mail sink", () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeAll(() => {
    test.skip(!PASS || !process.env.MAIL_SINK_TOKEN, "APL-2681: SHO_QA_PASS or the mail sink is missing");
  });

  test.beforeEach(async ({ admin }) => {
    await admin.page.setViewportSize(screenSize());
  });

  // qa:TC missing
  test("AC1: staging mail is captured for a ZZ test account within 60 seconds and does not leave to a real mailbox", async ({ admin, later }) => {
    const email = alias("2681", "ac1");
    const created = await admin.api.post("/api/team", { firstName: "ZZ-TEST", lastName: `sink ${RUN}`, email, role: "MEMBER" });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    later(() => admin.api.post(`/api/team/${created.json.person.id}/deactivate`, { reassign: "leaders" }));
    const started = Date.now();
    const mail = await waitForQaMail(email, "Your Sheet Happens Officer account", { baseUrl: BASE_URL, timeoutMs: 60_000 });
    expect(Date.now() - started).toBeLessThanOrEqual(60_000);
    expect(mail.to.toLowerCase()).toBe(email.toLowerCase());
    expect(mail.text).toMatch(/^Password: .+$/m);
    const other = await fetch(new URL(`/api/qa/mail?to=${encodeURIComponent("not-a-zz-recipient@example.com")}`, BASE_URL), {
      headers: { "x-qa-token": process.env.MAIL_SINK_TOKEN ?? "" },
    });
    expect(other.status).toBe(400);
  });

  // qa:TC missing
  test("AC2: with the sink live the mailbox-dependent sign-in runs instead of skipping", async ({ admin, browser, later }) => {
    const email = alias("2681", "ac2");
    const created = await admin.api.post("/api/team", { firstName: "ZZ-TEST", lastName: `run ${RUN}`, email, role: "MEMBER" });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    later(() => admin.api.post(`/api/team/${created.json.person.id}/deactivate`, { reassign: "leaders" }));
    const mail = await waitForQaMail(email, "Your Sheet Happens Officer account", { baseUrl: BASE_URL });
    const password = mail.text.match(/^Password: (.+)$/m)?.[1];
    expect(password, "emailed temporary password").toBeTruthy();
    const ctx = await browser.newContext({
      baseURL: BASE_URL,
      viewport: screenSize(),
      httpCredentials: process.env.STAGING_USER ? { username: process.env.STAGING_USER, password: process.env.STAGING_PASS ?? "" } : undefined,
    });
    try {
      const signed = await ctx.request.post("/api/auth/signin", { data: { email, password } });
      expect(signed.ok(), `sign in (${signed.status()})`).toBe(true);
      const page = await ctx.newPage();
      await page.goto("/");
      await expect(page).not.toHaveURL(/\/signin/);
      await expect(page.locator("#main")).toBeVisible();
    } finally {
      await ctx.close();
    }
  });

  // qa:TC missing
  test("AC3: a missing or wrong sink token is refused and the token is not in the response", async () => {
    const token = process.env.MAIL_SINK_TOKEN ?? "";
    const url = new URL("/api/qa/mail", BASE_URL);
    url.searchParams.set("to", alias("2681", "ac3"));
    const missing = await fetch(url);
    const missingBody = await missing.text();
    expect(missing.status).toBe(401);
    expect(missingBody.includes(token)).toBe(false);
    const wrong = await fetch(url, { headers: { "x-qa-token": `${token}x` } });
    const wrongBody = await wrong.text();
    expect(wrong.status).toBe(401);
    expect(wrongBody.includes(token)).toBe(false);
  });

  // qa:TC missing
  test("AC3 @static: the sink token is not written in the repo @static", () => {
    const token = process.env.MAIL_SINK_TOKEN ?? "";
    expect(token.length).toBeGreaterThan(0);
    for (const file of [".env.example", "tests/e2e/stories/qa.ts", "tests/e2e/stories/APL-2681.spec.ts", "tests/e2e/stories/APL-2624.spec.ts"]) {
      expect(readFileSync(file, "utf8").includes(token), file).toBe(false);
    }
  });
});
