# SHO-2589 — Workload

Workload counts open tasks, including subtasks, in active projects. Admins see the workspace; Leaders see only people and tasks in projects they lead. Other members receive not-found. Counts open matching lists through `assignee` and `f` URL parameters; tasks open the existing task sheet, retaining version checks, assignment notices and Undo. Phone rows become cards. Hidden CRM work contributes counts, but drill-down redacts deal/task text and identifiers rather than weakening task access.

Local evidence: seven focused predicate/query/privacy tests, project TypeScript, production build and scoped ESLint (zero errors; inherited Shell warnings). `tests/workload.test.ts` adds real API scope, subtasks, archive/Trash exclusion, assignment eligibility and Undo checks for the CI database. Required full head CI and browser/role acceptance remain release gates; targeted unit evidence is not full acceptance.

The story engineer owns staging, production and verification under Product’s current workflow. Confirm Leader/Member/Admin and CRM modes, exact counts and task reassignment/Undo, plus 390px cards, on the exact candidate revision. No schema change. Do not mark the BTF issue Done before release and verification evidence is recorded.

Current production integration starts at 5a87eacc668ebcd4e7070f14e05bbc72182b102b, preserving the live UI and Holy Sheet integration. Project Trash exclusion is explicit. Main-based PR291 is implementation evidence; this production-based candidate must pass its own full release gates and actual staging/production verification. No scheduling or cron change is part of this release.
