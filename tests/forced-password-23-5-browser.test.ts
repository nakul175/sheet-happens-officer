// SHO-US-23.5 AC8 in a real browser (Playwright, playwright-core): the sign-in form gets mustChangePassword
// from POST /api/auth/signin and the person lands on Set your own password.
// APL-2624 has no TC ids, so every describe and test title carries the literal token qa:TC missing.
// Local server only (TASKBOARD_URL): the emailed password is read from EMAIL_OUTBOX_DIR.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { BASE, OUTBOX, PW, superAdmin, type Account } from "./helpers";

const WALL = "Set your own password";
const run = Date.now();
let n = 0;
let browser: Browser;
let sa: Account;
// ZZ-TEST people with nakul17+zz-… aliases; afterAll deactivates them.
const created: string[] = [];

function chromePath() {
  const fromEnv = process.env.PW_CHROMIUM;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  for (const p of ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"]) {
    if (existsSync(p)) return p;
  }
  throw new Error("No Chrome/Chromium binary. Set PW_CHROMIUM.");
}

function emailedPassword(email: string) {
  const mails = readdirSync(OUTBOX).sort().map((f) => JSON.parse(readFileSync(path.join(OUTBOX, f), "utf8")));
  const text = (mails.filter((m) => m.to === email && /Your Sheet Happens Officer account/.test(m.subject)).at(-1)?.text ?? "") as string;
  return text.match(/Password: (\S+)/)?.[1] ?? "";
}

/** Fills the sign-in form and returns the JSON the form got back from POST /api/auth/signin. */
async function signInThroughForm(page: Page, email: string, password: string) {
  await page.goto(`${BASE}/signin`);
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill(password);
  const answer = page.waitForResponse((r) => r.url().endsWith("/api/auth/signin") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Sign in" }).click();
  const res = await answer;
  await page.waitForURL((u) => u.pathname !== "/signin");
  return { status: res.status(), json: await res.json() };
}

beforeAll(async () => {
  if (!/^(localhost|127\.0\.0\.1)$/.test(new URL(BASE).hostname)) {
    throw new Error(`Refusing to run against ${BASE}: this test is local only.`);
  }
  browser = await chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox"] });
  sa = await superAdmin();
}, 120000);

afterAll(async () => {
  await browser?.close();
  for (const id of created) await sa?.c.post(`/api/team/${id}/deactivate`, { reassign: "leaders" });
});

describe("qa:TC missing 23.5 AC8 the sign-in form gets mustChangePassword (browser)", () => {
  it("qa:TC missing AC8: an emailed password signs in with mustChangePassword true and opens Set your own password", async () => {
    const tag = `${run}${n++}`;
    const email = `nakul17+zz-2624-ui-${tag}@aplyd.com`;
    const r = await sa.c.post("/api/team", { firstName: "ZZ-TEST", lastName: `Forcedui${tag}`, email, role: "MEMBER" });
    expect(r.status).toBe(201);
    created.push(r.json.person.id as string);
    const page = await browser.newPage();
    const s = await signInThroughForm(page, email, emailedPassword(email));
    expect(s.status).toBe(200);
    expect(s.json.user.mustChangePassword).toBe(true);
    await page.getByRole("heading", { name: WALL }).waitFor({ state: "visible" });
    await page.context().close();
  });

  it("qa:TC missing AC8: a person on their own password signs in with mustChangePassword false and no wall", async () => {
    const page = await browser.newPage();
    const s = await signInThroughForm(page, sa.email, PW);
    expect(s.status).toBe(200);
    expect(s.json.user.mustChangePassword).toBe(false);
    // The side drawer is the one aside labelled Main (the phone tab bar is a nav), so the locator is exact.
    await page.locator('aside[aria-label="Main"]').waitFor({ state: "attached" });
    expect(await page.getByRole("heading", { name: WALL }).count()).toBe(0);
    await page.context().close();
  });
});
