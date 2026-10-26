// APL-2681 staging mail sink. Live story spec: the running app, through the browser and API.
// The only skip is the file-level beforeAll below. It names APL-2681 when SHO_QA_PASS or the mail sink is missing.
import { readFileSync } from "node:fs";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { waitForMail } from "../../mail-sink-client";

const PASS = process.env.SHO_QA_PASS ?? "";
const BASE = (process.env.BASE_URL || "http://127.0.0.1:3100").replace(/\/+$/, "");
const RUN = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

const zzEmail = (tag: string) => `nakul17+zz-2681-${tag}-${RUN}@gmail.com`;

async function signInAdmin(request: APIRequestContext) {
  const email = process.env.SHO_ADMIN_EMAIL;
  const password = process.env.SHO_ADMIN_PASS;
  expect(email && password, "SHO_ADMIN_EMAIL and SHO_ADMIN_PASS").toBeTruthy();
  const res = await request.post("/api/auth/signin", { data: { email, password } });
  expect(res.ok(), `admin sign-in (${res.status()})`).toBe(true);
}

test.describe("APL-2681 staging mail sink", () => {
  test.beforeAll(() => {
    test.skip(!PASS || !process.env.MAIL_SINK_TOKEN, "APL-2681: SHO_QA_PASS or the mail sink is missing");
  });

  // qa:TC missing
  test("AC1: staging mail is captured for a ZZ test account within 60 seconds and does not leave to a real mailbox", async ({ request }) => {
    await signInAdmin(request);
    const email = zzEmail("ac1");
    const created = await request.post("/api/team", { data: { firstName: "ZZ-TEST", lastName: `sink ${RUN}`, email, role: "MEMBER" } });
    const createdJson = (await created.json()) as { person?: { id: string }; error?: string };
    expect(created.ok(), JSON.stringify(createdJson)).toBe(true);
    const id = createdJson.person!.id;
    try {
      const started = Date.now();
      const mail = await waitForMail(email, "Your Sheet Happens Officer account", { baseUrl: BASE, timeoutMs: 60_000 });
      expect(Date.now() - started).toBeLessThanOrEqual(60_000);
      expect(mail.to.toLowerCase()).toBe(email.toLowerCase());
      expect(mail.text).toMatch(/^Password: .+$/m);
      const other = await fetch(new URL(`/api/qa/mail?to=${encodeURIComponent("not-a-zz-recipient@example.com")}`, BASE), {
        headers: { "x-qa-token": process.env.MAIL_SINK_TOKEN ?? "" },
      });
      expect(other.status).toBe(400);
    } finally {
      await request.post(`/api/team/${id}/deactivate`, { data: { reassign: "leaders" } });
    }
  });

  // qa:TC missing
  test("AC2: with the sink live the mailbox-dependent sign-in runs instead of skipping", async ({ request, browser }) => {
    await signInAdmin(request);
    const email = zzEmail("ac2");
    const created = await request.post("/api/team", { data: { firstName: "ZZ-TEST", lastName: `run ${RUN}`, email, role: "MEMBER" } });
    const createdJson = (await created.json()) as { person?: { id: string }; error?: string };
    expect(created.ok(), JSON.stringify(createdJson)).toBe(true);
    const id = createdJson.person!.id;
    const ctx = await browser.newContext();
    try {
      const mail = await waitForMail(email, "Your Sheet Happens Officer account", { baseUrl: BASE });
      const password = mail.text.match(/^Password: (.+)$/m)?.[1];
      expect(password, "emailed temporary password").toBeTruthy();
      const signed = await ctx.request.post("/api/auth/signin", { data: { email, password } });
      expect(signed.ok(), `sign in (${signed.status()})`).toBe(true);
      const page = await ctx.newPage();
      await page.goto("/");
      await expect(page).not.toHaveURL(/\/signin/);
      // Admin-issued credentials are intentionally temporary. A successful first
      // sign-in must reach the mandatory password wall, not the authenticated shell.
      await expect(page.getByRole("heading", { name: "Set your own password" })).toBeVisible();
    } finally {
      await ctx.close();
      await request.post(`/api/team/${id}/deactivate`, { data: { reassign: "leaders" } });
    }
  });

  // qa:TC missing
  test("AC3: a missing or wrong sink token is refused and the token is not in the response", async () => {
    const token = process.env.MAIL_SINK_TOKEN ?? "";
    const url = new URL("/api/qa/mail", BASE);
    url.searchParams.set("to", zzEmail("ac3"));
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
    for (const file of [".env.example", "tests/mail-sink-client.ts", "tests/e2e/stories/APL-2681.spec.ts", "src/lib/mail-sink.ts", "src/lib/email.ts"]) {
      expect(readFileSync(file, "utf8").includes(token), file).toBe(false);
    }
  });
});
