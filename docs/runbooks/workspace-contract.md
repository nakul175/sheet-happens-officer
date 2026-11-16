# One organisation per deployment

Owner decision, 3 November 2026: SHO serves one organisation per deployment. Admins manage that organisation globally; project membership restricts members within it. Workspace rows are not a supported multi-tenant API.

Account bootstrap serializes with a transaction-scoped PostgreSQL advisory lock, so simultaneous first signups cannot create two workspaces. Sign-in, authenticated session resolution and central/suite identity resolution require exactly one workspace and a matching user. Zero/multiple rows or mismatched user identity fail closed. No code chooses the oldest workspace to mask ambiguity, and no row is merged or deleted automatically.

Before any future approved production cut, read-only verify the workspace count and membership integrity. If there are multiple rows, stop for a reviewed data reconciliation plan; this fix does not authorize moving/deleting production data or applying a new constraint. Direct DB administrators can still write invalid state; the runtime will refuse authentication rather than certify isolation.

Tests deliberately create a second workspace to prove reads and writes are denied, then remove only that test-owned row. Ordinary fixtures reuse the sole test workspace. Purge/repair tooling has separate privileged semantics and must not be exposed through end-user routes. Do not interpret this contract as permission to enable schedules or change database roles.
