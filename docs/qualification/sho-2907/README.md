# SHO-2907: qualify the migrated APL-2691 browser spec

The APL-2691 file and its source migration are already present on live b623fb00. The remaining stale blocker was its Won-refusal expectation. NJ's29Oct SHO-3050 refinement explicitly allows Won with open operational tasks; this qualification tests that contract instead of reinstating obsolete behavior. Lost still refuses open tasks. Existing task-order assertions are retained on that refusal path, not discarded.

Four browser cases cover Won UI with21 unchanged tasks, singular Lost refusal, API Won success versus Lost409, and Lost's exact first20 task-page ordering with the21st excluded. Changed Won cases use new-version/TC-missing labels; the unchanged Lost TC remains. No CSS-class/first locators, fixed timeouts, new product behavior or schema migration is introduced. API fixture cleanup errors fail the test.

The spec supports explicit staging credentials as before. On loopback CI only, a guarded synthetic sho_test database provisions the existing local Super Admin helper. Production targets are refused. Release CI now collects and executes this file in its actual browser step; collection alone is not qualification.

Latest NJ instructions replace the historical main-merge routing with a pinned live Eng1 qualification PR and no main merge. The qa/story-e2e branch is never merged and original PR83 stays parked. Pam owns independent acceptance; Eng1 will record actual CI/staging/live evidence and leave In Review. SHO-2759 is not being claimed concurrently. Suite4, Concierge removal, held stories and database schema remain intact.

Status: typechecks and scoped lint passed; fresh unchanged-application build and actual desktop/phone acceptance are in progress. No acceptance or live claim yet.
