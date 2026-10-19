// APL-2694 story spec: Improve my prompt in the real concierge dock, in a browser, at desktop and phone width.
// Pam left no qa:TC id on the issue; each title says "qa:TC missing".
// Gate: SHO_QA_PASS (the password of the pre-provisioned, verified nakul17+ alias). Without it the file is skipped,
// so `npm test` in CI skips it. Nothing here signs up an account (APL-2748): the alias must already exist.
// Production hosts are refused. Point TASKBOARD_URL at a local server or at staging, never at production.
//
// AC4 runs first: the improve response is intercepted in the browser (503, then 429), so the dock's error path is
// checked without a real outage and without spending a model call.
// AC1/AC3 then use the real /api/concierge/improve. The target must have a working model: the concierge must be
// available and the call must return 200 with a new text. The APL-2694 bug was exactly "available, but improve
// returns 503", so that fails here. Text sent to the model is a ZZ-TEST sentence only.
import { mkdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import { assertStoryTargetAllowed } from "../base-url";
import { BASE } from "../../helpers";

// The target is TASKBOARD_URL (BASE). Pass it in, so the guard checks it without reading the process image.
assertStoryTargetAllowed(process.env, BASE);

const QA_PASS = process.env.SHO_QA_PASS ?? "";
const SLOT = (process.env.QA_SLOT || "local").toLowerCase();
const EMAIL = `nakul17+zz-qa-${SLOT}-1@aplyd.com`;
const SHOTS = "test-results/APL-2694";
// Loose wording on purpose, so a working model has something to rewrite.
const DRAFT = "ZZ-TEST um can u move budget thing to monday and like tell the team or whatever";
const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "phone", width: 390, height: 844 },
] as const;
const FAILURES = [
  { status: 503, error: "The concierge cannot reach its language service right now. The rest of the app works normally; try again in a minute." },
  { status: 429, error: "You have used your 200 concierge messages for this week." },
] as const;

type Improve = { status: number; improved: string | null; error: string | null };

let browser: Browser;
let ctx: BrowserContext;

const basic = process.env.STAGING_USER ? { username: process.env.STAGING_USER, password: process.env.STAGING_PASS ?? "" } : undefined;

async function conciergeState() {
  const r = await ctx.request.get(new URL("/api/concierge/state", BASE).href);
  expect(r.status()).toBe(200);
  return (await r.json()) as { available: boolean; disabled?: { code: string; message: string }; messages: unknown[] };
}

/** The concierge panel for this width: the right-hand dock on a wide list screen, the full-screen sheet on a phone. */
async function openPanel(page: Page, vp: (typeof VIEWPORTS)[number]) {
  await page.setViewportSize({ width: vp.width, height: vp.height });
  await page.goto(new URL("/", BASE).href);
  if (vp.width >= 1280) {
    // The dock is <aside aria-label="Concierge">: the complementary landmark of that name.
    const dock = page.getByRole("complementary", { name: "Concierge", exact: true });
    await dock.waitFor({ state: "visible" });
    return dock;
  }
  await page.getByRole("button", { name: "Concierge", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Concierge" });
  await sheet.waitFor({ state: "visible" });
  return sheet;
}

/** Type the draft, press Improve my prompt and return what the improve call answered. */
async function clickImprove(page: Page, panel: Locator, text: string): Promise<Improve> {
  await panel.getByRole("textbox", { name: "Message the concierge" }).fill(text);
  const answer = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/concierge/improve" && r.request().method() === "POST");
  await panel.getByRole("button", { name: "Improve my prompt" }).click();
  const res = await answer;
  const body = (await res.json().catch(() => ({}))) as { improved?: string; error?: string };
  return { status: res.status(), improved: body.improved ?? null, error: body.error ?? null };
}

/** The concierge has to be usable for either test. Say why when it is not, rather than passing on a dead dock. */
async function mustBeAvailable() {
  const s = await conciergeState();
  expect(s.available, `the concierge is off on ${BASE} (${s.disabled?.code ?? "?"}: ${s.disabled?.message ?? ""}); Improve my prompt cannot be checked`).toBe(true);
  return s;
}

describe.skipIf(!QA_PASS)("qa:TC missing APL-2694: Improve my prompt in the concierge dock", () => {
  beforeAll(async () => {
    mkdirSync(SHOTS, { recursive: true });
    browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined, args: ["--no-sandbox"] });
    ctx = await browser.newContext({ httpCredentials: basic });
    const signed = await ctx.request.post(new URL("/api/auth/signin", BASE).href, { data: { email: EMAIL, password: QA_PASS } });
    const text = await signed.text();
    expect(text.includes(QA_PASS), "the sign-in reply never echoes the password").toBe(false);
    expect(signed.status(), `${EMAIL} must be a provisioned, verified alias (APL-2748)`).toBe(200);
    const shown = await ctx.request.patch(new URL("/api/concierge/preferences", BASE).href, { data: { hidden: false } });
    expect(shown.status()).toBe(200);
  }, 60_000);

  afterAll(async () => {
    await ctx?.close();
    await browser?.close();
  });

  for (const vp of VIEWPORTS) {
    it(`qa:TC missing AC4: at ${vp.name} width a 503 or 429 from improve is a visible alert, the typed text stays and no rewrite is offered`, async () => {
      const before = (await mustBeAvailable()).messages.length;
      const page = await ctx.newPage();
      try {
        const panel = await openPanel(page, vp);
        const box = panel.getByRole("textbox", { name: "Message the concierge" });
        const group = panel.getByRole("group", { name: "Suggested rewrite" });
        for (const f of FAILURES) {
          await page.route("**/api/concierge/improve", (route) =>
            route.fulfill({ status: f.status, contentType: "application/json", body: JSON.stringify({ error: f.error }) }));
          const got = await clickImprove(page, panel, DRAFT);
          await page.unroute("**/api/concierge/improve");
          expect(got.status).toBe(f.status);
          const alert = panel.getByRole("alert").filter({ hasText: f.error.slice(0, 40) });
          await alert.waitFor({ state: "visible" });
          await page.screenshot({ path: `${SHOTS}/${vp.name}-${f.status}.png` });
          expect(await box.inputValue()).toBe(DRAFT);
          expect(await group.count()).toBe(0);
          await alert.getByRole("button", { name: "Dismiss" }).click();
        }
        expect((await conciergeState()).messages.length).toBe(before);
      } finally {
        await page.close();
      }
    }, 90_000);
  }

  for (const vp of VIEWPORTS) {
    it(`qa:TC missing AC1, AC3: at ${vp.name} width the real model's rewrite is offered; Keep mine and Use it work; nothing is posted`, async () => {
      const before = (await mustBeAvailable()).messages.length;
      const page = await ctx.newPage();
      try {
        const panel = await openPanel(page, vp);
        const box = panel.getByRole("textbox", { name: "Message the concierge" });
        const group = panel.getByRole("group", { name: "Suggested rewrite" });

        // The APL-2694 bug: available, yet improve came back 503 and no rewrite was shown. That must fail here.
        const first = await clickImprove(page, panel, DRAFT);
        await page.screenshot({ path: `${SHOTS}/${vp.name}-rewrite.png` });
        expect(first.status, `improve returned ${first.status}: ${first.error ?? ""}`).toBe(200);
        expect(first.improved?.trim(), "a non-empty rewrite").toBeTruthy();
        expect(first.improved!.trim(), "a rewrite that differs from the typed text").not.toBe(DRAFT);
        await group.waitFor({ state: "visible" });
        expect(await box.inputValue()).toBe(first.improved);

        // Keep mine puts the typed text back exactly and removes the offer.
        await group.getByRole("button", { name: "Keep mine" }).click();
        expect(await box.inputValue()).toBe(DRAFT);
        expect(await group.count()).toBe(0);

        // Use it keeps the rewrite in the box and removes the offer.
        const second = await clickImprove(page, panel, DRAFT);
        expect(second.status, `improve returned ${second.status}: ${second.error ?? ""}`).toBe(200);
        expect(second.improved!.trim()).not.toBe(DRAFT);
        await group.waitFor({ state: "visible" });
        await group.getByRole("button", { name: "Use it" }).click();
        expect(await group.count()).toBe(0);
        expect(await box.inputValue()).toBe(second.improved);

        // AC3: Improve my prompt never posts to the thread.
        expect((await conciergeState()).messages.length).toBe(before);
      } finally {
        await page.close();
      }
    }, 90_000);
  }
});
