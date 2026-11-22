# Application and schema identity

The observed application release is `7c4aa8419c7f19e781e54d0681c05d4c22d68b7b`. A retained production receipt records the separately approved SHO-3054 nullable expansion applied at 2026-11-02T19:10:25.041Z, preserving all 46 legacy date values. This is historical evidence, not a fresh catalog inspection.

`deploy/schema-baseline.json` records migration names and SQL checksums separately from app identity. This hardening branch restores the exact already-approved migration and its two nullable Prisma fields from `7917658f`. It does not add the deadline UI, reapply DDL to any shared database, backfill dates, or drop legacy columns. Null means no new deadline instant/timezone was entered. Do not infer midnight or a timezone from the legacy date.

For a future approved cut, compare `_prisma_migrations` names/checksums with this manifest using a read-only connection; reject unknown or modified history. Do not use `migrate resolve` to suppress drift. Replay the checked-in history only in a disposable test database, compare catalog/constraints, and qualify old/new app reads and writes. Record application commit, schema manifest hash, backup identity, and smoke results independently. If production already records this migration, do not execute its SQL manually again.

Status: source reconciliation is ready for CI; fresh production catalog comparison and compatibility/restore proof remain acceptance work. No production changes are authorized by this document.
