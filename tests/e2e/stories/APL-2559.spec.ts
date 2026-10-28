// SHO-US-22.11 Automated phone checks in CI (Linear APL-2559).
// Pam left no qa:TC id on the issue; each title says "qa:TC missing".
// A check that only asks whether a file contains a string is tagged @static. The staging
// workflow leaves @static out. It does not pass a live acceptance criterion.
// The live tests run the viewport checker in Chromium. They do not sign in, do not call a
// deployed app, and do not read or write any database. No customer data is seeded.
// The only skip is a missing SHO_QA_PASS.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { test, expect } from "../support";
import { collect } from "../../viewport/checks";
import { PHONE_MAX, SCREENS, WIDTHS } from "../../viewport/screens";

const PASS = process.env.SHO_QA_PASS ?? "";
const ROOT = process.cwd();
const WORKFLOW = path.join(ROOT, ".github/workflows/phone-checks.yml");
const SUITE = path.join(ROOT, "tests/viewport/viewport.test.ts");
// W240: this spec owns its evidence folder. It used to point at test-results/viewport, which
// tests/viewport/viewport.test.ts and tests/viewport/comments-phone.test.ts also write — one run's
// screenshots landing in a folder two other files resolve. Every other story spec owns
// test-results/<SPEC-ID>.
const SHOTS = path.join(ROOT, "test-results/APL-2559");

test.beforeAll(() => {
  test.skip(!PASS, "APL-2559: set SHO_QA_PASS (password for nakul17+ aliases).");
});

const CLEAN = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"></head>
<body style="margin:0"><button style="width:44px;height:44px">Ok</button><input style="font-size:16px;height:44px;width:120px"></body></html>`;

const WIDE = `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><body style="margin:0"><div class="board-fault" style="width:400px;height:20px">wide</div></body>`;

test("AC1: when CI runs, the viewport suite runs on every listed screen and width and reports pass or fail qa:TC missing", async ({ browser }) => {
  const titles = WIDTHS.flatMap((width) => SCREENS.map((screen) => `${screen.name} @ ${width} px`));
  expect(SCREENS.length).toBeGreaterThan(0);
  expect(WIDTHS.length).toBeGreaterThan(0);
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

test("@static AC1: the workflow and the suite file name the screen and width loop qa:TC missing", () => {
  const yml = readFileSync(WORKFLOW, "utf8");
  const source = readFileSync(SUITE, "utf8");
  expect(yml).toMatch(/^on:\s*$/m);
  expect(yml).toContain("pull_request:");
  expect(yml).toContain("npm run test:viewport");
  expect(source).toContain("for (const width of WIDTHS)");
  expect(source).toContain("for (const s of SCREENS)");
  expect(source).toContain("it(`${s.name} @ ${width} px`");
  expect(source).toContain("expect.fail(");
});

test("AC2: a change that adds 400 px of fixed width fails the suite, naming the screen, width and element qa:TC missing", async ({ browser }) => {
  const width = 320;
  expect(WIDTHS).toContain(width);
  expect(SCREENS.some((screen) => screen.name.length > 0)).toBe(true);
  const ctx = await browser.newContext({ viewport: { width, height: 700 } });
  const page = await ctx.newPage();
  try {
    await page.setContent(WIDE);
    const found = await page.evaluate(collect, true);
    const hit = found.find((f) => f.check === "overflow" && f.element.includes("div.board-fault"));
    expect(hit, "the 400 px element is named").toBeTruthy();
    expect(hit?.element).toContain("div.board-fault");
    expect(hit?.detail).toMatch(/400|right edge/);
  } finally {
    await ctx.close();
  }
});

test("@static AC2: the suite file contains the fixed-width failure wording qa:TC missing", () => {
  const source = readFileSync(SUITE, "utf8");
  expect(source).toContain("fails a page with 400 px of fixed width and names the element");
  expect(source).toContain("${s.name} at ${width} px has");
  expect(source).toContain("f.element");
  expect(source).toContain("screenshot:");
});

test("AC3: the suite asserts no horizontal overflow, 44 by 44 px targets under 600 px, 16 px fields, and viewport-fit=cover qa:TC missing", async ({ browser }) => {
  expect(PHONE_MAX).toBe(600);
  const narrow = await browser.newContext({ viewport: { width: 360, height: 700 } });
  const bad = await narrow.newPage();
  try {
    await bad.setContent(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><body style="margin:0"><button style="width:30px;height:30px">x</button><input style="font-size:14px;height:44px"><div style="width:400px;height:10px">wide</div></body>`);
    const found = await bad.evaluate(collect, 360 < PHONE_MAX);
    expect(found.map((f) => f.check).sort()).toEqual(["field", "meta", "overflow", "target"]);
    expect(found.find((f) => f.check === "target")?.detail).toContain("44");
    expect(found.find((f) => f.check === "field")?.detail).toContain("16");
    expect(found.find((f) => f.check === "meta")?.detail).toContain("viewport-fit=cover");
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

test("@static AC3: checks.ts names the four rules qa:TC missing", () => {
  const source = readFileSync(path.join(ROOT, "tests/viewport/checks.ts"), "utf8");
  expect(source).toContain("No sideways scroll");
  expect(source).toContain("Tap targets at least 44 by 44");
  expect(source).toContain("Fields at least 16 px");
  expect(source).toContain("viewport-fit=cover");
});

test("@static AC4: the phone-check suite has its own 10-minute limit qa:TC missing", () => {
  expect(readFileSync(WORKFLOW, "utf8")).toMatch(/- name: Phone checks\n\s+timeout-minutes: 10\n\s+run: npm run test:viewport/);
});

test("AC5: a failure attaches screenshots of the failing state qa:TC missing", async ({ browser }) => {
  mkdirSync(SHOTS, { recursive: true });
  const shot = path.join(SHOTS, "APL-2559-fixed-width-320.png");
  // W240 anti-cheat: remove this run's target first. The assertions below are existsSync + a size
  // floor, and a PNG left by a previous run satisfied both even when this run's screenshot never
  // wrote one. Deleting first makes the pass depend on the bytes this run produced.
  rmSync(shot, { force: true });
  const ctx = await browser.newContext({ viewport: { width: 320, height: 700 } });
  const page = await ctx.newPage();
  try {
    await page.setContent(WIDE);
    const found = await page.evaluate(collect, true);
    expect(found.some((f) => f.check === "overflow")).toBe(true);
    await page.screenshot({ path: shot, fullPage: true });
  } finally {
    await ctx.close();
  }
  expect(existsSync(shot)).toBe(true);
  expect(statSync(shot).size).toBeGreaterThan(100);
});

test("@static AC5: the workflow uploads viewport-screenshots after a failure qa:TC missing", () => {
  const yml = readFileSync(WORKFLOW, "utf8");
  const source = readFileSync(SUITE, "utf8");
  expect(yml).toContain("if: failure()");
  expect(yml).toContain("actions/upload-artifact@v4");
  expect(yml).toContain("name: viewport-screenshots");
  expect(yml).toContain("path: test-results/viewport/");
  expect(source).toContain("await page.screenshot(");
  expect(source).toContain("test-results/viewport");
});
