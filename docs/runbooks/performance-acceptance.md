# Performance and operational acceptance

Status: NOT MEASURED. Health200 is availability evidence, not proof of latency, scale, recovery or data integrity. Owner-approved recovery targets (7 November 2026): one hour maximum data loss (RPO), four hours to verified service recovery (RTO). Neither target has been demonstrated by a real restore.

Use a disposable database and synthetic fixtures, never load-test production under this audit. Pin the candidate and hardware. Representative fixture proposal: 100 users, 100 projects, 10,000 tasks, 1,000 deals and corresponding activity history; product owner must confirm whether it reflects expected use. Capture data shape, browser/network conditions, concurrency and warm/cold cache state.

Measure p50/p95/p99 latency and error rate for Dashboard, task list/detail, Deals filter/sort/search, people pickers and Team. Include permission-constrained users and large-result cases. Inspect EXPLAIN (ANALYZE, BUFFERS) for slow queries only in the disposable fixture, record rows scanned/returned and peak process/database resources. Set response budgets from product needs before declaring PASS; do not invent a latency SLA.

Re-run after bounded query/pagination fixes; validate pagination does not hide accessible records or leak inaccessible records. No pagination/product behavior changes are included in this documentation pass.

Operational acceptance includes a real approved backup restore, measured recovery, Suite4/app smoke and rollback proof. Record alert owner, response procedure and escalation contacts. All scheduled work remains paused; a documented monitoring plan is not authorization to enable it.
