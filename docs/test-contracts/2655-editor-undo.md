# APL-2655 / APL-2674 local browser reconciliation

The formerly gated `tests/e2e/local/APL-2655.test.ts` expected an Editor's delete Undo button. That conflicts with the later APL-2674 acceptance in `tests/activity-delete-undo.test.ts`: an Editor sees no Undo on their own `task.deleted` row; a Leader/Admin may restore. The product already implements that restriction in `src/lib/activity-row.ts` `showUndo`. It must remain restricted.

The browser test now checks the Editor button is absent, then uses the authenticated browser context's direct API request to preserve APL-2655's separate server guarantees: an already-undone delete returns409 before the permission check; a not-yet-undone delete returns403. Both retain exact messages, full before/after snapshots and actual Trash UI assertions. No forced click or hidden-control exposure is used.

A third browser case is a positive control: the Leader sees the exact deleted-task row's Undo button, clicks it, receives200, restores the task, records the Leader as `undoneById`, and sees empty Trash. Other available Undo buttons are not valid substitutes for this row.

Red evidence: fresh whole-suite421a0d8 reports2076PASS2FAIL, both old Editor button expectations. Narrow final result:7/7PASS across three actual browser cases and four API cases. A fresh whole-suite result remains required after this test-only reconciliation.
