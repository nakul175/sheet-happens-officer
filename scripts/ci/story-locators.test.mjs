// SHO-2996 / SHO-2997 / SHO-2998 AC1: a parent step, `.locator("..")`, names nothing and breaks when a wrapper element
// is added around the element it starts from. Line 18 of APL-2539.spec.ts, line 44 of APL-2540.spec.ts (AC1's deal panel)
// and line 118 of APL-2540.spec.ts (AC4's parties line) each had one. Those three call sites were rewritten to role
// locators, but the same parent-walk survived in the shared helper APL-2540 AC3 still calls, so the spec could go red on a
// wrapper change without any of the fixed lines changing.
//
// This check is the guard for all three: no story spec, and no locator helper those deal specs use, may go back to one.
// tests/e2e/helpers/screen-row.ts is deliberately out of scope: its activityRow() walks up from a sentence to its row and
// is used by APL-2470/2504/2505, which no ticket in this cluster touches.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const STORIES = join(ROOT, "tests/e2e/stories");
const HELPERS = ["tests/e2e/helpers/claude-a.ts"];
const HELPER = join(ROOT, "tests/e2e/helpers/claude-a.ts");
const APL_2540 = join(ROOT, "tests/e2e/stories/APL-2540.spec.ts");
const DEAL_PANEL = join(ROOT, "src/components/DealPanel.tsx");

/** `.locator("..")` and `.locator('..')`, the whole-string parent step only: `"../x"` module paths are untouched. */
const PARENT_STEP = /\.locator\(\s*["'`]\.\.["'`]\s*\)/;

function files() {
  const stories = readdirSync(STORIES).filter((n) => n.endsWith(".spec.ts")).map((n) => join(STORIES, n));
  return [...stories, ...HELPERS.map((p) => join(ROOT, p))];
}

test("no story spec or deal helper walks to a parent element", () => {
  const offenders = [];
  for (const file of files()) {
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      if (!/^\s*(\/\/|\*)/.test(line) && PARENT_STEP.test(line)) offenders.push(`${file.replace(`${ROOT}/`, "")}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, [], "use a role, test-id or label locator instead of a parent step");
});

// APL-2540 AC1 and AC3 must resolve the SAME deal-panel region, so a locator change in one spec cannot silently point at a
// different panel. That region is the one DealPanel.tsx puts the Stage group in.
//
// SHO-2920+2921 (aa9b699) gave the panel a landmark of its own: DealPanel.tsx renders <section aria-label="Deal">, and a
// named <section> is exposed as role=region, so the helper now names that panel instead of <main> (which also holds the
// task list below it). The old expectation below still spelled the pre-aa9b699 locator,
// getByRole("main").filter({ has: getByRole("group", { name: "Stage" }) }), and went red against a helper that is
// correct. The three assertions keep the original intent: one shared locator, both ACs take the panel from it, and the
// region it names is the one that holds the Stage group.
test("the deal panel APL-2540 AC1 and AC3 share is the one that holds the Stage group", () => {
  const helper = readFileSync(HELPER, "utf8");
  assert.match(
    helper,
    /export const dealPanel = \(page: Page\) => page\.getByRole\("region", \{ name: "Deal", exact: true \}\)/,
    "claude-a.ts must carry the one shared deal-panel locator, the \"Deal\" landmark DealPanel.tsx renders",
  );

  // Both ACs reach the panel through that helper and neither builds a locator of its own.
  const panel = helper.split("\n").find((line) => line.startsWith("export const dealPanel = "));
  assert.ok(panel, "claude-a.ts must export dealPanel");
  const spec = readFileSync(APL_2540, "utf8").split("\n");
  const uses = spec.filter((line) => /^\s*const \w+ = dealPanel\(/.test(line));
  assert.equal(uses.length, 2, `APL-2540 AC1 and AC3 must both do \`const panel = dealPanel(page)\`, found ${uses.length}`);

  // The region that locator resolves holds the Stage group: DealPanel.tsx nests role="group" aria-label="Stage" in the
  // single <section aria-label="Deal">, and APL-2539 AC7 asserts that group is visible inside dealPanel().
  const component = readFileSync(DEAL_PANEL, "utf8");
  const section = component.match(/<section[^>]*aria-label="Deal"[^>]*>([\s\S]*?)<\/section>/);
  assert.ok(section, 'DealPanel.tsx must render the panel as <section aria-label="Deal">, the region named "Deal"');
  assert.match(section[1], /role="group"[^>]*aria-label="Stage"/, "the \"Deal\" region must hold the Stage group");
  assert.match(panel, /name: "Deal", exact: true/, "the helper must name that region exactly, not a broader ancestor");
});
