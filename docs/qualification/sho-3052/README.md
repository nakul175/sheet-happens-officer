# SHO-3052 — Buyer replacement browser qualification

Base: live `569496b75236ab7b9bf14d430e717c5378423b88`. BTF issue 3055.
Branch: `codex/sho-3052-eng1-base-5694`.

Buyer replacement already exists in the live application. Existing API acceptance
covers roles, canonical Buyer, retained data, read models, stale snapshots and
unconfirmed duplicates. Add real browser coverage for the missing confirmation
contract at 1280px and 390px: current/proposed Buyer, initially disabled save,
cancel with no mutation, duplicate warning clearing the first confirmation, and
explicit confirmation before replacement. Editor/Viewer controls stay hidden.

A separate browser/API case creates a test-owned foreign workspace and organisation,
proves the picker excludes it and both normal/forced requests reject it without
mutation. Only those two synthetic rows are removed afterward. All fixture setup
is guarded to a loopback app and a local `sho_test*` database before any writes.
No production data, schema changes or migrations are involved.

Final isolated acceptance: five tests pass across the existing API file and new
browser file. Both typechecks, scoped lint and webpack build pass. Review screenshots
at both widths are retained in `work/sho-3052-evidence/screenshots`; the phone duplicate
state was visually inspected. Source runtime, Prisma, suite routes, Search and
Concierge removal are unchanged. Exact-head CI and the serial Eng1 cut are pending.
