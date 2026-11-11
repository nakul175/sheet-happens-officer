# SHO-2589 — Workload

Workload counts open tasks, including subtasks, in active projects. Admins see the workspace; Leaders see only people and tasks in projects they lead. Other members receive not-found. Counts open matching lists through `assignee` and `f` URL parameters; tasks open the existing task sheet, retaining version checks, assignment notices and Undo. Phone rows become cards. Hidden CRM work contributes counts, but drill-down redacts deal/task text and identifiers rather than weakening task access.

Local evidence: seven focused predicate/query/privacy tests, project TypeScript, production build and scoped ESLint (zero errors; inherited Shell warnings). `tests/workload.test.ts` adds real API scope, subtasks, archive/Trash exclusion, assignment eligibility and Undo checks for the CI database. Required full head CI and browser/role acceptance remain release gates; targeted unit evidence is not full acceptance.

Deploy and verify only through Deployment SHO. Confirm Leader/Member/Admin and CRM modes, exact counts and task reassignment/Undo, plus 390px cards, on the exact candidate revision. No schema change. Do not mark the BTF issue Done before release and verification evidence is recorded.
