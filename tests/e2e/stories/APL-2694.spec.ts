// APL-2694 story spec: Improve my prompt in the real concierge dock, in a browser, at desktop and phone width.
// Pam left no qa:TC id on the issue; each title says "qa:TC missing".
// Gate: SHO_QA_PASS (the password of the pre-provisioned, verified nakul17+ alias). Without it the file is skipped,
// so `npm test` in CI skips it. Nothing here signs up an account (APL-2748): the alias must already exist.
// Production hosts are refused. Point TASKBOARD_URL at a local server or at staging, never at production.
// The click goes to the real /api/concierge/improve, and the spec checks the dock against what that call returned:
//   200 with a new text  -> Suggested rewrite is shown; Keep mine restores the typed text exactly; Use it keeps the rewrite (AC1)
//   200 with the same text -> no rewrite is offered (an empty model reply comes back as the original)
//   429 or 503           -> a visible alert, the typed text is kept, no rewrite group (AC4)
//   concierge off        -> no usable box or Improve my prompt, and the reason is shown (a cap, or the provider
//                           marked down for a minute after a failed call)
// Either way nothing is posted to the thread until Send (AC3). Text sent to the model is a ZZ-TEST sentence only.
import { mkdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { assertStoryTargetAllowed } from "../base-url";
import { BASE } from "../../helpers";

// The target is TASKBOARD_URL (BASE). Pass it in, so the guard checks it without reading the process image.
assertStoryTargetAllowed(process.env, BASE);

const QA_PASS = process.env.SHO_QA_PASS ?? "";
const SLOT = (process.env.QA_SLOT || "local").toLowerCase();
const EMAIL = `nakul17+zz-qa-${SLOT}-1@aplyd.com`;
const SHOTS = "test-results/APL-2694";
const DRAFT = "ZZ-TEST move the budget task to monday and tell the team";
const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "phone", width: 390, height: 844 },
] as const;

type Improve = { status: number; improved: string | null; error: string | null };

let browser: Browser;
let ctx: BrowserContext;

const basic = process.env.STAGING_USER ? { username: process.env.STAGING_USER, password: process.env.STAGING_PASS ?? "" } : undefined;

async function messageCount() {
  const r = await ctx.request.get(new URL("/api/concierge/state", BASE).href);
  expect(r.status()).toBe(200);
  return ((await r.json()).messages as unknown[]).length;
}

/** The concierge panel for this width: the right-hand dock on a wide list screen, the full-screen sheet on a phone. */
async function openPanel(page: Page, width: number) {
  await page.setViewportSize({ width, height: width < 800 ? 844 : 800 });
  await page.goto(new URL("/", BASE).href);
  if (width >= 1280) {
    const dock = page.locator("aside.cc-slot");
    await dock.waitFor({ state: "visible" });
    return dock;
  }
  await page.getByRole("button", { name: "Concierge", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Concierge" });
  await sheet.waitFor({ state: "visible" });
  return sheet;
}

/** Type the draft, press Improve my prompt and return what the real improve call answered. */
async function clickImprove(page: Page, panel: ReturnType<Page["locator"]>, text: string): Promise<Improve> {
  const box = panel.getByRole("textbox", { name: "Message the concierge" });
  await box.fill(text);
  const answer = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/concierge/improve" && r.request().method() === "POST");
  await panel.getByRole("button", { name: "Improve my prompt" }).click();
  const res = await answer;
  const body = (await res.json().catch(() => ({}))) as { improved?: string; error?: string };
  return { status: res.status(), improved: body.improved ?? null, error: body.error ?? null };
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
    it(`qa:TC missing AC1, AC3, AC4: at ${vp.name} width the dock offers the rewrite or shows the error, and posts nothing`, async () => {
      const page = await ctx.newPage();
      try {
        const before = await messageCount();
        const panel = await openPanel(page, vp.width);
        const box = panel.getByRole("textbox", { name: "Message the concierge" });
        const group = panel.getByRole("group", { name: "Suggested rewrite" });
        const state = await (await ctx.request.get(new URL("/api/concierge/state", BASE).href)).json();
        if (!state.available) {
          // The concierge is off (a cap, or the provider marked down after a failed call): there is no usable box or
          // Improve my prompt, the reason is on screen, and no rewrite can be offered.
          await page.screenshot({ path: `${SHOTS}/${vp.name}-off.png` });
          const improve = panel.getByRole("button", { name: "Improve my prompt" });
          expect((await box.count()) === 0 || (await box.isDisabled())).toBe(true);
          expect((await improve.count()) === 0 || (await improve.isDisabled())).toBe(true);
          expect(await panel.innerText()).toContain(String(state.disabled?.message ?? "").slice(0, 40));
          expect(await group.count()).toBe(0);
          expect(await messageCount()).toBe(before);
          return;
        }
        const first = await clickImprove(page, panel, DRAFT);
        await page.screenshot({ path: `${SHOTS}/${vp.name}-after-improve.png` });

        if (first.status === 200 && first.improved && first.improved.trim() !== DRAFT) {
          // AC1: the model's text replaces the draft, and Keep mine puts the typed text back exactly.
          await group.waitFor({ state: "visible" });
          expect(await box.inputValue()).toBe(first.improved);
          await group.getByRole("button", { name: "Keep mine" }).click();
          expect(await box.inputValue()).toBe(DRAFT);
          expect(await group.count()).toBe(0);
          // Use it keeps the rewrite in the box and removes the offer.
          const second = await clickImprove(page, panel, DRAFT);
          expect(second.status, second.error ?? "").toBe(200);
          if (second.improved && second.improved.trim() !== DRAFT) {
            await group.waitFor({ state: "visible" });
            await group.getByRole("button", { name: "Use it" }).click();
            expect(await group.count()).toBe(0);
            expect(await box.inputValue()).toBe(second.improved);
          }
        } else if (first.status === 200) {
          // The reply was only the typed text again (an empty model reply): nothing is offered.
          expect(await group.count()).toBe(0);
          expect(await box.inputValue()).toBe(DRAFT);
        } else {
          // AC4: a cap or an outage is a visible alert, the typed text stays, and no rewrite is offered.
          expect([429, 503]).toContain(first.status);
          const alert = panel.getByRole("alert");
          await alert.first().waitFor({ state: "visible" });
          expect(await alert.first().innerText()).toContain((first.error ?? "").slice(0, 40));
          expect(await box.inputValue()).toBe(DRAFT);
          expect(await group.count()).toBe(0);
        }
        // AC3: Improve my prompt never posts to the thread.
        expect(await messageCount()).toBe(before);
      } finally {
        await page.close();
      }
    }, 90_000);
  }
});
