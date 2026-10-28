# Browser story selection

Stories that sign up accounts and verify email through the local `EMAIL_OUTBOX_DIR` must carry `@local-only` on their enclosing `test.describe`. Do not add `test.skip` to make them pass on staging. The canonical staging workflow on main excludes `@static|@manual|@local-only` in both parallel and serial runners; its policy and collection proof are tracked in PR #257. This selective integration branch does not contain that staging workflow, so it does not claim to run it.

The existing APL-2609 story remains available locally. With the local build/server, outbox, `SHO_QA_PASS`, and its test Super Admin alias configured, run `npx playwright test tests/e2e/stories/APL-2609.spec.ts`. The isolated release CI now executes all four cases and rejects skips, failures and flakes. Its fixture alias is added only to the throwaway CI server's allowlist. It does not provision staging or production accounts.

Full staging execution remains a separate release acceptance gate. Collection is not execution, and a localhost pass does not prove a staging pass.
