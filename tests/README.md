# Browser story selection

A Playwright story that expects email to appear in an existing listener's local `EMAIL_OUTBOX_DIR` must carry `@local-only` on its enclosing `test.describe`. Do not add `test.skip` to make it pass on staging. The canonical main staging workflow excludes `@static|@manual|@local-only` in both parallel and serial runners; PR #257 documents and verifies that policy. This selective integration branch does not contain that workflow or claim to execute it.

This integration's APL-2609 version was already adapted by SHO-2897: it owns a temporary app listener and a private outbox instead of reading an existing listener's mail. It deliberately remains eligible for a separately authorized isolated-host run under the restricted slot user. It never redirects an existing remote app's mail. That owned-instance proof must not be described as verification of the existing staging or production listener.

For local QA set the built app path in `SHO_QA_APP_ROOT`, its exact source revision in `SHO_QA_RELEASE`, scoped local `DATABASE_URL`, `SHO_QA_PASS` and existing `SHO_ADMIN_EMAIL`/`SHO_ADMIN_PASS`; then run `npx playwright test tests/e2e/stories/APL-2609.spec.ts`. The release CI executes all four retained cases against its own temporary listener/outbox, rejects skips/failures/flakes and saves JSON evidence. It reuses the configured bootstrap account and grants no new Super Admin.

Full staging and production listener verification remain separate release gates. Collection is not execution, and a localhost owned-instance pass does not prove a deployed-listener pass.
