// SHO-US-22.11 Automated phone checks in CI (APL-2559).
// The acceptance criteria describe the GitHub Actions workflow (.github/workflows/phone-checks.yml)
// and the viewport suite (tests/viewport, `npm run test:viewport`). They are not behaviour of the staging app.
// This Playwright project runs against STAGING_URL. The viewport suite refuses any host that is not localhost,
// uses its own throw-away database, and must not be pointed at staging or production.
// Nothing below signs in or calls the network. There is no test that reads or writes the production database,
// and no real customer data is seeded from here.
import { test } from "../support";

test.skip("AC1: when CI runs, the viewport suite runs on every listed screen and width and reports pass or fail", () => {
  // Reason: that run is the Phone checks workflow. A story spec cannot see a GitHub Actions result without the GitHub API,
  // and these specs may call only the staging app. Triggering the workflow is out of scope.
});

test.skip("AC2: a change that adds 400 px of fixed width fails the suite, naming the screen, width and element", () => {
  // Reason: proving the failure means editing the app and running the viewport suite. This patch must not edit the app,
  // and the suite is not allowed to run against staging. The failure text is built in tests/viewport/viewport.test.ts.
});

test.skip("AC3: the suite asserts no horizontal overflow, 44 by 44 px targets under 600 px, 16 px fields, and viewport-fit=cover", () => {
  // Reason: those assertions live in tests/viewport/checks.ts and run only against a local server.
  // Re-running them here would point the phone checks at staging, which that suite refuses.
});

test.skip("AC4: the suite finishes in under 10 minutes on CI", () => {
  // Reason: the workflow sets timeout-minutes: 10. A duration is only known by running the job, which this patch must not trigger.
});

test.skip("AC5: a failure attaches screenshots of the failing state", () => {
  // Reason: the screenshots are a GitHub Actions artifact (viewport-screenshots) uploaded from test-results/viewport when the job fails.
  // A story spec against staging cannot see that artifact, and producing one would mean failing the suite on purpose.
});
