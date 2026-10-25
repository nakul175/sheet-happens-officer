// APL-2652 story: a deep link opened while signed out comes back after sign-in.
// Runs with the phone checks (npm run test:viewport) against a local server and a test database.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { account, BASE, OUTBOX, project, PW, superAdmin, task } from "../helpers";

let browser: Browser;
let memberEmail = "";
let outsiderEmail = "";
let forcedEmail = "";
let forcedPassword = "";
let visibleId = "";
let visibleTitle = "";
let hiddenId = "";
let hiddenTitle = "";
let hiddenDetail = "";

const origin = () => new URL(BASE).origin;

function signInMailPassword(email: string) {
  const files = readdirSync(OUTBOX).sort();
  const mails = files.map((f) => JSON.parse(readFileSync(path.join(OUTBOX, f), "utf8"))).filter((m) => m.to === email && /Your Sheet Happens Officer account/.test(m.subject));
  return ((mails.at(-1)?.text ?? "") as string).match(/Password: (\S+)/)?.[1] ?? "";
}

async function signedOutPage() {
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 800 }, baseURL: BASE });
  const page = await ctx.newPage();
  return { ctx, page };
}

async function signIn(page: Page, email: string, password: string) {
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/** The asked-for task, still on /tasks/<id>, with the query that was opened. */
async function landedOnTask(page: Page, id: string, title: string, search = "") {
  const titleBox = page.getByRole("textbox", { name: "Title", exact: true });
  await titleBox.waitFor({ state: "visible", timeout: 20000 });
  expect(await titleBox.inputValue()).toBe(title);
  const url = new URL(page.url());
  expect(url.origin).toBe(origin());
  expect(url.pathname, page.url()).toBe(`/tasks/${id}`);
  expect(url.search, page.url()).toBe(search);
  expect(url.hash, page.url()).toBe("");
  expect(url.hostname).not.toBe("evil.example");
}

beforeAll(async () => {
  if (!/^(localhost|127\.0\.0\.1)$/.test(new URL(BASE).hostname)) throw new Error(`Refusing to run the return-to story against ${BASE}: use a local server with a test database.`);
  browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
  const root = await superAdmin();
  const member = await account("returnmember");
  const outsider = await account("returnoutsider");
  memberEmail = member.email;
  outsiderEmail = outsider.email;
  const p = await project(root, root, [{ who: member }]);
  const stamp = Date.now();
  visibleTitle = `ZZ-TEST APL2652 visible ${stamp}`;
  hiddenTitle = `ZZ-TEST APL2652 hidden ${stamp}`;
  hiddenDetail = `ZZ-TEST APL2652 secret detail ${stamp}`;
  visibleId = await task(root, p.id, { dueDate: "2031-03-20", title: visibleTitle, description: "Visible to a member of the project." });
  hiddenId = await task(root, p.id, { dueDate: "2031-03-20", title: hiddenTitle, description: hiddenDetail });
  forcedEmail = `zz-test-returnforced${stamp}@aplyd.com`;
  const added = await root.c.post("/api/team", { firstName: "Rita", lastName: `Return${stamp}`, email: forcedEmail, role: "MEMBER" });
  expect(added.status, JSON.stringify(added.json)).toBe(201);
  forcedPassword = signInMailPassword(forcedEmail);
  expect(forcedPassword).toMatch(/^[A-Za-z0-9]{12}$/);
  expect((await root.c.post(`/api/projects/${p.id}/members`, { userId: added.json.person.id, role: "EDITOR" })).status).toBe(201);
}, 90000);

afterAll(async () => { await browser?.close(); });

describe("APL-2652 sign-in returns to the deep link", () => {
  it("AC1 a signed-out deep link comes back after a successful sign-in", async () => {
    const { ctx, page } = await signedOutPage();
    try {
      await page.goto(`/tasks/${visibleId}`);
      await page.getByRole("heading", { name: "Sign in" }).waitFor();
      const url = new URL(page.url());
      expect(url.origin).toBe(origin());
      expect(url.pathname).toBe("/signin");
      expect(url.searchParams.get("next")).toBe(`/tasks/${visibleId}`);
      await signIn(page, memberEmail, PW);
      await landedOnTask(page, visibleId, visibleTitle);
    } finally { await ctx.close(); }
  });

  it("AC1 a query is kept and the fragment is dropped", async () => {
    const { ctx, page } = await signedOutPage();
    try {
      await page.goto(`/tasks/${visibleId}?tab=comments#c9`);
      await page.getByRole("heading", { name: "Sign in" }).waitFor();
      const url = new URL(page.url());
      expect(url.pathname).toBe("/signin");
      expect(url.searchParams.get("next")).toBe(`/tasks/${visibleId}?tab=comments`);
      expect(url.hash).toBe("");
      // Random task IDs may contain c9; inspect the fragment, not an arbitrary substring of the URL.
      expect(new URL(url.searchParams.get("next")!, url.origin).hash).toBe("");
      await signIn(page, memberEmail, PW);
      await landedOnTask(page, visibleId, visibleTitle, "?tab=comments");
    } finally { await ctx.close(); }
  });

  it("AC2 off-site and malformed next values stay on the home page", async () => {
    for (const next of ["https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)"]) {
      const { ctx, page } = await signedOutPage();
      const left: string[] = [];
      page.on("request", (req) => {
        try {
          const u = new URL(req.url());
          if (u.hostname === "evil.example" || u.protocol === "javascript:") left.push(req.url());
        } catch { /* a request that is not a URL cannot be an off-site navigation */ }
      });
      try {
        await page.goto(`/signin?next=${encodeURIComponent(next)}`);
        await signIn(page, memberEmail, PW);
        await page.getByRole("heading", { name: "My tasks" }).waitFor({ timeout: 20000 });
        const url = new URL(page.url());
        expect(url.origin, next).toBe(origin());
        expect(url.pathname, next).toBe("/");
        expect(url.hostname, next).not.toBe("evil.example");
        expect(left, next).toEqual([]);
        expect(page.url(), next).not.toContain("javascript:");
      } finally { await ctx.close(); }
    }
  });

  it("AC3 a task the person cannot see shows the not-found page and no detail", async () => {
    const { ctx, page } = await signedOutPage();
    try {
      await page.goto(`/signin?next=${encodeURIComponent(`/tasks/${hiddenId}`)}`);
      await signIn(page, outsiderEmail, PW);
      await page.getByRole("heading", { name: "This task isn't available" }).waitFor({ timeout: 20000 });
      const doc = await page.request.get(`/tasks/${hiddenId}`);
      const api = await page.request.get(`/api/tasks/${hiddenId}`);
      expect(doc.status()).toBe(404);
      expect(api.status()).toBe(404);
      const body = await api.text();
      expect(body).not.toContain(hiddenTitle);
      expect(body).not.toContain(hiddenDetail);
      expect(await page.getByText(hiddenTitle).count()).toBe(0);
      expect(await page.getByText(hiddenDetail).count()).toBe(0);
      const url = new URL(page.url());
      expect(url.origin).toBe(origin());
      expect(url.pathname).toBe(`/tasks/${hiddenId}`);
    } finally { await ctx.close(); }
  });

  it("AC4 a wrong password keeps the return target for the next try", async () => {
    const { ctx, page } = await signedOutPage();
    try {
      await page.goto(`/signin?next=${encodeURIComponent(`/tasks/${visibleId}`)}`);
      await page.getByLabel("Work email").fill(memberEmail);
      await page.getByLabel("Password").fill("wrong-pass-1");
      await page.getByRole("button", { name: "Sign in" }).click();
      const alert = page.getByRole("alert").filter({ hasText: "Email or password is incorrect." });
      await alert.waitFor({ timeout: 15000 });
      expect(new URL(page.url()).searchParams.get("next")).toBe(`/tasks/${visibleId}`);
      await page.getByLabel("Password").fill(PW);
      await page.getByRole("button", { name: "Sign in" }).click();
      await landedOnTask(page, visibleId, visibleTitle);
    } finally { await ctx.close(); }
  });

  it("AC5 a temporary password must be changed before the deep link opens", async () => {
    const { ctx, page } = await signedOutPage();
    try {
      await page.goto(`/signin?next=${encodeURIComponent(`/tasks/${visibleId}`)}`);
      await signIn(page, forcedEmail, forcedPassword);
      await page.getByRole("heading", { name: "Set your own password" }).waitFor({ timeout: 20000 });
      expect(new URL(page.url()).pathname).toBe(`/tasks/${visibleId}`);
      expect(await page.getByText(visibleTitle).count()).toBe(0);
      expect(await page.getByRole("navigation", { name: "Main" }).count()).toBe(0);
      expect(await page.getByRole("heading", { name: "Sign in" }).isVisible()).toBe(false);
      // The sign-in form can stay mounted, hidden, after the client navigation. Exact labels keep these on the wall's fields.
      await page.getByLabel("Emailed password", { exact: true }).fill(forcedPassword);
      await page.getByLabel("New password", { exact: true }).fill("my-own-pass-7");
      await page.getByLabel("Confirm new password", { exact: true }).fill("my-own-pass-7");
      await page.getByRole("button", { name: "Save and continue" }).click();
      await landedOnTask(page, visibleId, visibleTitle);
      expect(await page.getByRole("heading", { name: "Set your own password" }).count()).toBe(0);
    } finally { await ctx.close(); }
  });

  it("a session that expires mid-use returns to the deep link", async () => {
    const ctx = await browser.newContext({ viewport: { width: 1024, height: 800 }, baseURL: BASE });
    const page = await ctx.newPage();
    try {
      const signed = await ctx.request.post("/api/auth/signin", { data: { email: memberEmail, password: PW } });
      expect(signed.ok()).toBe(true);
      let tripped = false;
      await page.route(`**/api/tasks/${visibleId}`, async (route) => {
        if (!tripped) {
          tripped = true;
          await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "Not signed in" }) });
          return;
        }
        await route.continue();
      });
      await page.goto(`/tasks/${visibleId}`);
      const expired = page.getByRole("alert").filter({ hasText: "Your session has expired, please sign in again" });
      await expired.waitFor({ timeout: 20000 });
      expect(await expired.innerText()).toBe("Your session has expired, please sign in again");
      const url = new URL(page.url());
      expect(url.origin).toBe(origin());
      expect(url.pathname).toBe("/signin");
      expect(url.searchParams.get("expired")).toBe("1");
      expect(url.searchParams.get("next")).toBe(`/tasks/${visibleId}`);
      // The sign-in screen must not redirect again: the query is still here when they submit.
      expect(new URL(page.url()).pathname).toBe("/signin");
      await signIn(page, memberEmail, PW);
      await landedOnTask(page, visibleId, visibleTitle);
    } finally { await ctx.close(); }
  });

  it("expired=1 and a return path show the alert until another error, then sign-in returns", async () => {
    const { ctx, page } = await signedOutPage();
    try {
      await page.goto(`/signin?expired=1&next=${encodeURIComponent(`/tasks/${visibleId}`)}`);
      const expired = page.getByRole("alert").filter({ hasText: "Your session has expired, please sign in again" });
      await expired.waitFor({ timeout: 20000 });
      expect(await expired.innerText()).toBe("Your session has expired, please sign in again");
      const opened = new URL(page.url());
      expect(opened.pathname).toBe("/signin");
      expect(opened.searchParams.get("expired")).toBe("1");
      expect(opened.searchParams.get("next")).toBe(`/tasks/${visibleId}`);

      await page.getByLabel("Work email").fill(memberEmail);
      await page.getByLabel("Password").fill("wrong-pass-1");
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.getByRole("alert").filter({ hasText: "Email or password is incorrect." }).waitFor({ timeout: 15000 });
      expect(await page.getByText("Your session has expired, please sign in again").count()).toBe(0);
      const kept = new URL(page.url());
      expect(kept.searchParams.get("expired")).toBe("1");
      expect(kept.searchParams.get("next")).toBe(`/tasks/${visibleId}`);

      await page.getByLabel("Password").fill(PW);
      await page.getByRole("button", { name: "Sign in" }).click();
      await landedOnTask(page, visibleId, visibleTitle);
    } finally { await ctx.close(); }
  });
});
