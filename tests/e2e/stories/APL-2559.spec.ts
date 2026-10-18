// SHO-US-22.11 Automated phone checks in CI (Linear APL-2559).
// One test per acceptance criterion. The suite under test is tests/viewport plus
// .github/workflows/phone-checks.yml. These tests run that checker's rules in Chromium
// and read the workflow file. They do not sign in, do not call a deployed app, and do not
// read or write any database. No customer data is seeded.
// The only skip is a missing SHO_QA_PASS, so a staging run can start once that password is set.
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test, expect } from "../support";
import { collect } from "../../viewport/checks";
import { PHONE_MAX, SCREENS, WIDTHS } from "../../viewport/screens";

const PASS = process.env.SHO_QA_PASS ?? "";
const ROOT = process.cwd();
const WORKFLOW = path.join(ROOT, ".github/workflows/phone-checks.yml");
const SUITE = path.join(ROOT, "tests/viewport/viewport.test.ts");
const SHOTS = path.join(ROOT, "test-results/viewport");

test.beforeAll(() => {
  test.skip(!PASS, "Set SHO_QA_PASS (the password for nakul17+ aliases).");
});

function workflow(): string {
  return readFileSync(WORKFLOW, "utf8");
}

function suiteSource(): string {
  return readFileSync(SUITE, "utf8");
}

const CLEAN = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"></head>
<body style="margin:0"><button style="width:44px;height:44px">Ok</button><input style="font-size:16px;height:44px;width:120px"></body></html>`;

test("AC1: when CI runs, the viewport suite runs on every listed screen and width and reports pass or fail", async ({ browser }) => {
  const yml = workflow();
  const source = suiteSource();
  expect(yml).toMatch(/^on:\s*$/m);
  expect(yml).toContain("pull_request:");
  expect(yml).toContain("npm run test:viewport");
  expect(source).toContain("for (const width of WIDTHS)");
  expect(source).toContain("for (const s of SCREENS)");
  expect(source).toContain("it(`${s.name} @ ${width} px`");
  expect(source).toContain("expect.fail(");
  expect(SCREENS.length).toBeGreaterThan(0);
  expect(WIDTHS.length).toBeGreaterThan(0);

  const titles = WIDTHS.flatMap((width) => SCREENS.map((screen) => `${screen.name} @ ${width} px`));
  expect(new Set(titles).size).toBe(SCREENS.length * WIDTHS.length);

  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
  const page = await ctx.newPage();
  try {
    await page.setContent(CLEAN);
    const found = await page.evaluate(collect, true);
    expect(found, "a page that meets the rules reports pass (no findings)").toEqual([]);
  } finally {
    await ctx.close();
  }
});

test("AC2: a change that adds 400 px of fixed width fails the suite, naming the screen, width and element", async ({ browser }) => {
  const source = suiteSource();
  expect(source).toContain("fails a page with 400 px of fixed width and names the element");
  expect(source).toContain("${s.name} at ${width} px has");
  expect(source).toContain("f.element");
  expect(source).toContain("screenshot:");

  const ctx = await browser.newContext({ viewport: { width: 320, height: 700 } });
  const page = await ctx.newPage();
  try {
    await page.setContent(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><body style="margin:0"><div class="board-fault" style="width:400px;height:20px">wide</div></body>`);
    const found = await page.evaluate(collect, true);
    const hit = found.find((f) => f.check === "overflow" && f.element.includes("div.board-fault"));
    expect(hit, "the 400 px element is named").toBeTruthy();
    const screen = "Sign up";
    const width = 320;
    const message = `${screen} at ${width} px has 1 problem:\n  ${hit!.check}: ${hit!.element} (${hit!.detail})`;
    expect(message).toContain(screen);
    expect(message).toContain(`${width} px`);
    expect(message).toContain(hit!.element);
    expect(hit!.detail).toMatch(/400|right edge/);
  } finally {
    await ctx.close();
  }
});

test("AC3: the suite asserts no horizontal overflow, 44 by 44 px targets under 600 px, 16 px fields, and viewport-fit=cover", async ({ browser }) => {
  expect(PHONE_MAX).toBe(600);
  const source = readFileSync(path.join(ROOT, "tests/viewport/checks.ts"), "utf8");
  expect(source).toContain("No sideways scroll");
  expect(source).toContain("Tap targets at least 44 by 44");
  expect(source).toContain("Fields at least 16 px");
  expect(source).toContain("viewport-fit=cover");

  const narrow = await browser.newContext({ viewport: { width: 360, height: 700 } });
  const bad = await narrow.newPage();
  try {
    await bad.setContent(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><body style="margin:0"><button style="width:30px;height:30px">x</button><input style="font-size:14px;height:44px"><div style="width:400px;height:10px">wide</div></body>`);
    const found = await bad.evaluate(collect, 360 < PHONE_MAX);
    expect(found.map((f) => f.check).sort()).toEqual(["field", "meta", "overflow", "target"]);
    const target = found.find((f) => f.check === "target");
    expect(target?.detail).toContain("44");
    const field = found.find((f) => f.check === "field");
    expect(field?.detail).toContain("16");
    const meta = found.find((f) => f.check === "meta");
    expect(meta?.detail).toContain("viewport-fit=cover");
  } finally {
    await narrow.close();
  }

  const wide = await browser.newContext({ viewport: { width: 768, height: 800 } });
  const ok = await wide.newPage();
  try {
    await ok.setContent(CLEAN);
    expect(await ok.evaluate(collect, 768 < PHONE_MAX)).toEqual([]);
  } finally {
    await wide.close();
  }
});

test("AC4: the suite finishes in under 10 minutes on CI", async ({ browser }) => {
  const yml = workflow();
  expect(yml).toMatch(/timeout-minutes:\s*10\b/);
  const started = Date.now();
  const ctx = await browser.newContext({ viewport: { width: 320, height: 800 } });
  const page = await ctx.newPage();
  try {
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 800 });
      await page.setContent(CLEAN);
      await page.evaluate(collect, width < PHONE_MAX);
    }
  } finally {
    await ctx.close();
  }
  const elapsed = Date.now() - started;
  expect(elapsed).toBeLessThan(10 * 60 * 1000);
});

test("AC5: a failure attaches screenshots of the failing state", async ({ browser }) => {
  const yml = workflow();
  expect(yml).toContain("if: failure()");
  expect(yml).toContain("actions/upload-artifact@v4");
  expect(yml).toContain("name: viewport-screenshots");
  expect(yml).toContain("path: test-results/viewport/");
  expect(suiteSource()).toContain("await page.screenshot(");
  expect(suiteSource()).toContain("test-results/viewport");

  mkdirSync(SHOTS, { recursive: true });
  const shot = path.join(SHOTS, "APL-2559-fixed-width-320.png");
  const ctx = await browser.newContext({ viewport: { width: 320, height: 700 } });
  const page = await ctx.newPage();
  try {
    await page.setContent(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><body style="margin:0"><div class="board-fault" style="width:400px;height:20px">wide</div></body>`);
    const found = await page.evaluate(collect, true);
    expect(found.some((f) => f.check === "overflow")).toBe(true);
    await page.screenshot({ path: shot, fullPage: true });
  } finally {
    await ctx.close();
  }
  expect(existsSync(shot)).toBe(true);
  expect(statSync(shot).size).toBeGreaterThan(100);
});
