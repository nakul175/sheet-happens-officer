# Independent handover acceptance

Status: NOT RUN by an independent new maintainer. Documentation and CI alone cannot close this gate. Use a fresh checkout of an exact approved candidate commit. Do not give the receiving maintainer this chat or an author's unpublished notes.

## Boundaries and preparation

The exercise uses only a disposable loopback PostgreSQL 16 database, synthetic accounts and a stubbed release host. It does not require staging or production access, real mail, provider secrets, migrations on a shared database or a service restart. The reviewer records the candidate commit and provides a copy of one retained failing-test artifact with its expected failure explained separately. The maintainer should discover the cause from the code and repository documentation.

Use [README.md](../../README.md) for the exact local setup and test commands, [data contract](../data/CONTRACT.md), [domain boundaries](domain-boundaries.md), [runtime configuration](runtime-configuration.md), [schema releases](schema-releases.md), [application release](app-release.md), and [backup recovery](backup-recovery.md). Record any step that requires information outside these files as a documentation gap.

Give a new maintainer repository access plus the README, not the chat history. In an isolated local environment they should:

1. Draw the request path from `server.js` to one task write and one deal write. Explain the `/api/suite/*` integration boundary, the single-organisation workspace contract, and which migration history a fresh database replays. The reviewer checks each explanation against the linked documents and source.
2. With Node 22 and a fresh disposable PostgreSQL 16 database, follow the README commands: install from the lockfile, replay checked-in migrations, build, start the production entry point locally, and register/verify a synthetic user using `.outbox-local`. Record the actual commands and the application URL. Destroy the disposable database after evidence collection.
3. Run the README regression commands, recording pass/fail/skip counts for script tests, lint, typecheck, E2E typecheck, unit/integration, modes and viewport checks separately. Diagnose the supplied failing artifact, make a bounded change in an exercise branch, and run its focused test plus the affected broader gate. The reviewer verifies that the change fixes the cause rather than weakening an assertion.
4. Trace one role denial, one optimistic version conflict, one Undo operation and one custom SQL constraint to their owning functions and tests. Explain the transaction boundary and how a concurrent membership change is handled. Record any ownership ambiguity.
5. In an isolated stubbed host, rehearse a wrong-SHA rejection and a failed-restart rollback with the release runner's existing tests. Record the test command, observed release identity and rollback result. Do not point the runner at a real host or change a service.
6. Identify the provider backup identity that a real restore would require; explain the owner-approved one-hour RPO and four-hour RTO targets, restore validation, secret sources and incident escalation without exposing secret values. This explanation does not prove the targets: only a separate provider backup restore rehearsal can measure them.
7. Record elapsed setup and diagnosis time, undocumented steps, confusing ownership and missing access. The author fixes confirmed documentation gaps and the maintainer repeats those failed steps. A reviewer then records acceptance or a specific remaining blocker.

## Acceptance record

Copy this table into the audit evidence directory and fill every field. Link to artifacts rather than pasting secrets or full logs into a status comment.

| Field | Evidence |
| --- | --- |
| Maintainer and independent reviewer | Names and roles; neither may be the candidate author |
| Exact candidate | Full commit SHA, branch and checkout status |
| Environment | OS, Node, PostgreSQL and browser versions; disposable database name only |
| Times | Start, first local boot, first full gate result, diagnosis, repair and finish |
| Local setup | Commands, app URL, synthetic user verification and database teardown receipt |
| Regression gates | Per-gate pass/fail/skip counts and artifact paths; identify any unavailable gate |
| Diagnosis and change | Failing artifact, root cause, changed files, focused and broader rerun results |
| Boundary explanation | Task, deal, Suite4, role, version, Undo and custom SQL source/test links |
| Stubbed release | Wrong-SHA and failed-restart outcomes, release identity and rollback evidence |
| Recovery explanation | Backup identity source, RPO/RTO targets, validation steps and unmeasured limits |
| Gaps and retest | Each documentation/access gap, owner, correction and repeated result |
| Decision | Reviewer PASS/FAIL with reasons; Product owner acceptance or remaining blocker |

Product owner decides acceptance. Engineering must not certify its own instructions as independently usable. A failed or skipped required exercise step leaves the independent handover gate open.
