// SHO-US-22.11 Automated phone checks in CI (APL-2559).
// The acceptance criteria describe the GitHub Actions workflow (.github/workflows/phone-checks.yml)
// and the viewport suite (tests/viewport, `npm run test:viewport`). They are not behaviour of the staging app.
// This Playwright project runs against BASE_URL. The viewport suite refuses any host that is not localhost,
// uses its own throw-away database, and must not be pointed at staging or production.
// Nothing below signs in, calls the network, or reads the GitHub API. The skip text points at runs already recorded.
// There is no test that reads or writes the production database, and no real customer data is seeded from here.
import { test } from "../support";
import { why } from "../helpers/jim-http";

// The workflow file on main runs for pull requests (push to main is ignored). This green pull-request run of that
// workflow passed every listed screen and width. The job started 2026-10-18T20:03:58Z and completed 2026-10-18T20:09:58Z.
const GREEN = "https://github.com/nakul175/sheet-happens-officer/actions/runs/39161589393";
// A failing pull request names the screen, the width and the element, and uploads viewport-screenshots.
const FAILED = "https://github.com/nakul175/sheet-happens-officer/actions/runs/39083680569";

test.skip(
  "AC1: when CI runs, the viewport suite runs on every listed screen and width and reports pass or fail",
  why(`Phone checks (.github/workflows/phone-checks.yml on main) runs the viewport suite on every listed screen and width and reports pass or fail. A green pull-request run of that workflow passed: ${GREEN}`),
  () => {},
);

test.skip(
  "AC2: a change that adds 400 px of fixed width fails the suite, naming the screen, width and element",
  why(`A failing pull request names the screen, the width and the element. ${FAILED} failed with "Sign up at 320 px" and target a "Sign in" (43 x 44 px, needs 44 x 44).`),
  () => {},
);

test.skip(
  "AC3: the suite asserts no horizontal overflow, 44 by 44 px targets under 600 px, 16 px fields, and viewport-fit=cover",
  why(`Phone checks on main runs tests/viewport/checks.ts (no horizontal overflow, 44 by 44 px targets under 600 px, 16 px fields, and viewport-fit=cover). That suite passed in ${GREEN}.`),
  () => {},
);

test.skip(
  "AC4: the suite finishes in under 10 minutes on CI",
  why(`Phone checks on main sets timeout-minutes: 10. The Phone-size layout checks job in ${GREEN} started 2026-10-18T20:03:58Z and completed 2026-10-18T20:09:58Z, under 10 minutes.`),
  () => {},
);

test.skip(
  "AC5: a failure attaches screenshots of the failing state",
  why(`A failure uploads the viewport-screenshots artifact. ${FAILED} attached viewport-screenshots, including test-results/viewport/Sign-up-320.png.`),
  () => {},
);
