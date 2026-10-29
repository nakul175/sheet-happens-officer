# SHO-2589 — Workload

Workload counts open tasks, including subtasks, in active projects. Admins see the workspace; Leaders see only people and tasks in projects they lead. Other members receive not-found. Counts open matching lists through `assignee` and `f` URL parameters; tasks open the existing task sheet, retaining version checks, assignment notices and Undo. Phone rows become cards. Hidden CRM work contributes counts, but drill-down redacts deal/task text and identifiers rather than weakening task access.

Local evidence: seven focused predicate/query/privacy tests, project TypeScript, production build and scoped ESLint (zero errors; inherited Shell warnings). `tests/workload.test.ts` adds real API scope, subtasks, archive/Trash exclusion, assignment eligibility and Undo checks for the CI database. Required full head CI and browser/role acceptance remain release gates; targeted unit evidence is not full acceptance.

The story engineer owns staging, production and verification under Product’s current workflow. Confirm Leader/Member/Admin and CRM modes, exact counts and task reassignment/Undo, plus 390px cards, on the exact candidate revision. No schema change. Do not mark the BTF issue Done before release and verification evidence is recorded.

Current production integration starts at b0f09e78638dae4575a3095aa69181d834dcf1fa, preserving the live UI, accessibility fixes and Holy Sheet integration. Project Trash exclusion is explicit. Main-based PR291 is implementation evidence; this production-based candidate must pass its own full release gates and actual staging/production verification. No scheduling or cron change is part of this release.

Requalification: PR297 head5973af53 used5a87eacc and its green checks are historical evidence. The current-production-based candidate must pass fresh exact-head gates and staging acceptance. Production remains held by NJ; shared staging/QA access and BTF/BugOff verification remain external dependencies.

Production requalification on 2026-10-29 uses live baseline 2cf4e6d3c4eb3b7a74554ff8bbcae5e3758177ff. The candidate preserves that baseline and carries SHO-2908/2910 browser specs plus SHO-2878 trigger safety/SQL tests; the existing SHO-2771 environment-read safeguards remain intact. Fresh isolated acceptance and exact-head CI are required. Main merge and production promotion remain held pending explicit incident clearance.
