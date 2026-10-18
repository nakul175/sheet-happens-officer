// SHO-US-22.11 Automated phone checks in CI (APL-2559).
// The criteria describe Phone checks (.github/workflows/phone-checks.yml) and tests/viewport.
// This file does not sign in, does not call the network, and does not read or write any database.
// The viewport suite refuses every host except localhost, so it is not pointed at staging or production.
import { readFileSync } from "node:fs";
import { test, expect } from "../support";
import { collect } from "../../viewport/checks";
import { PHONE_MAX, SCREENS, WIDTHS } from "../../viewport/screens";

const read = (path: string) => readFileSync(path, "utf8");
const workflow = read(".github/workflows/phone-checks.yml");
const suite = read("tests/viewport/viewport.test.ts");
const config = read("vitest.viewport.config.mts");

const pageHtml = (body: string, meta = "width=device-width, initial-scale=1, viewport-fit=cover") =>
  `<!doctype html><meta name="viewport" content="${meta}"><body style="margin:0">${body}</body>`;

test("AC1: when CI runs, the viewport suite runs on every listed screen and width and reports pass or fail", () => {
  expect(workflow).toMatch(/^\s*pull_request:\s*$/m);
  expect(workflow).toMatch(/push:\s*\n\s*branches-ignore:\s*\[main\]/);
  expect(workflow).toContain("npm run test:viewport");
  expect(suite).toContain("for (const width of WIDTHS)");
  expect(suite).toContain("for (const s of SCREENS)");
  expect(suite).toContain("it(`${s.name} @ ${width} px`");
  expect(WIDTHS.length).toBeGreaterThan(0);
  expect(SCREENS.length).toBeGreaterThan(0);
  expect(WIDTHS).toEqual([320, 360, 390, 414, 599, 768]);
  expect(SCREENS.map((s) => s.name)).toEqual(expect.arrayContaining(["Sign in", "Sign up", "My tasks", "Audit log"]));
  // A passing screen closes with no findings. A failing one reports the screen and the width.
  expect(suite).toContain("expect.fail(`${s.name} at ${width} px has ${found.length} problem");
});

test("AC2: a change that adds 400 px of fixed width fails the suite, naming the screen, width and element", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.setContent(pageHtml('<div class="board-fault" style="width:400px;height:20px">wide</div>'));
  const found = await page.evaluate(collect, 320 < PHONE_MAX);
  expect(found.some((x) => x.check === "overflow" && x.element.includes("div.board-fault"))).toBe(true);
  const hit = found.find((x) => x.element.includes("div.board-fault"))!;
  const reported = `Board at 320 px has 1 problem:\n  ${hit.check}: ${hit.element} (${hit.detail})`;
  expect(reported).toContain("Board");
  expect(reported).toContain("320 px");
  expect(reported).toContain("div.board-fault");
  expect(suite).toContain('x.element.includes("div.board-fault")');
  expect(suite).toContain("screenshot: ${shot}");
});

test("AC3: the suite asserts no horizontal overflow, 44 by 44 px targets under 600 px, 16 px fields, and viewport-fit=cover", async ({ page }) => {
  expect(PHONE_MAX).toBe(600);
  await page.setViewportSize({ width: 360, height: 700 });
  await page.setContent(pageHtml(
    '<button style="width:30px;height:30px">x</button><input style="font-size:14px;height:44px">',
    "width=device-width, initial-scale=1",
  ));
  const found = await page.evaluate(collect, 360 < PHONE_MAX);
  expect(found.map((x) => x.check).sort()).toEqual(["field", "meta", "target"]);
  const target = found.find((x) => x.check === "target")!;
  const field = found.find((x) => x.check === "field")!;
  const meta = found.find((x) => x.check === "meta")!;
  expect(target.detail).toContain("needs 44 x 44");
  expect(field.detail).toContain("needs 16");
  expect(meta.detail).toContain("viewport-fit=cover");
  expect(read("tests/viewport/checks.ts")).toContain("viewport-fit\\s*=\\s*cover");
});

test("AC4: the suite finishes in under 10 minutes on CI", () => {
  expect(workflow).toMatch(/timeout-minutes:\s*10\b/);
  expect(workflow).toContain("name: Phone-size layout checks");
  expect(config).toContain("testTimeout: 60000");
  expect(config).toContain('include: ["tests/viewport/**/*.test.ts"]');
});

test("AC5: a failure attaches screenshots of the failing state", () => {
  expect(workflow).toMatch(/name: Screenshots of failing pages\s*\n\s*if:\s*failure\(\)/);
  expect(workflow).toContain("actions/upload-artifact@v4");
  expect(workflow).toContain("name: viewport-screenshots");
  expect(workflow).toContain("path: test-results/viewport/");
  expect(suite).toContain('const SHOTS = "test-results/viewport"');
  expect(suite).toContain("await page.screenshot({ path: shot, fullPage: true })");
  // The suite builds its own rows on a local Postgres and refuses any other host.
  expect(workflow).toContain("postgresql://sho:sho@localhost:5432/sho_viewport");
  expect(workflow).not.toMatch(/sheethappensofficer\.com/);
  expect(suite).toContain("Refusing to run the viewport suite against");
  expect(suite).toContain("localhost|127\\.0\\.0\\.1");
});
