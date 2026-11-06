# Independent handover acceptance

Status: NOT RUN by an independent new maintainer. Documentation and CI alone cannot close this gate.

Give a new maintainer repository access plus the README, not the chat history. In an isolated local environment they should:

1. Explain runtime entry, domain boundaries, Suite4, schema history and single-organisation workspace contract.
2. Install with Node22 from lockfile, start disposable PostgreSQL16, replay history, build and register/verify a synthetic user without real email.
3. Run the regression gates; identify a deliberately failing test from retained artifacts and repair a bounded fixture/code change.
4. Explain role denials, optimistic version conflicts, transaction/Undo boundaries and custom SQL constraints.
5. Rehearse the release runner with stubbed host operations, proving failed restart/wrong SHA recovery. Do not touch a real host for this exercise.
6. Explain backup identity, the owner-approved one-hour RPO and four-hour RTO targets, restore validation, secret sources and incident escalation without revealing secret values. State that the targets remain unmeasured.
7. Record elapsed setup time, undocumented steps, confusing ownership and missing access. Fix documentation, then repeat the failed portion.

Acceptance record fields: maintainer, exact commit, OS/Node/Postgres/browser versions, start/finish, commands, test counts, artifacts, blockers and reviewer. Product owner decides acceptance; engineering must not certify its own instructions as independently usable.
