# SHO data contract

Source of truth: `prisma/schema.prisma` plus the complete ordered SQL migration history. Prisma alone does not describe partial indexes, triggers or every check constraint. `MODEL-REFERENCE.md` is a generated field/relation inventory; regenerate with `node scripts/data-reference.mjs`. Migration identity and the already-applied nullable deadline expansion are documented in `../runbooks/schema-releases.md`.

## Ownership and relationships

```mermaid
erDiagram
 Workspace ||--o{ User : contains
 Workspace ||--o{ Project : contains
 Project ||--o{ ProjectMember : authorizes
 User ||--o{ ProjectMember : joins
 Project ||--o{ Section : organizes
 Project ||--o{ Task : owns
 Section ||--o{ Task : groups
 Task ||--o{ Task : parents
 Project ||--o| DealDetails : extends
 Project ||--o{ DealParty : relates
 Task ||--o{ TaskLink : links
 User ||--o{ Session : authenticates
 User ||--o{ AuthToken : recovers
```

SHO is one organisation per deployment, per the owner decision in HR-11; see ../runbooks/workspace-contract.md. Multiple workspace rows are an invalid runtime state, not supported tenant isolation. Project membership and organisation role enforce application access. An application role with DML access is not PostgreSQL row-level security. Keep database administration credentials separate from runtime credentials.

## Invariants beyond Prisma

- A project's **at most one** Leader is enforced by partial unique index `ProjectMember_one_leader_per_project`; application transactions must maintain **at least one**. These are distinct guarantees.
- `Section_one_done_per_project` allows at most one Done section. Application creation/mutation preserves a usable Done section.
- `Section_max_8` / `enforce_max_sections` cap sections. The function was replaced by the pinned-search-path migration; inspect the latest definition, not just init SQL.
- `Task_section_in_project` / `enforce_task_section_in_project` reject section/project mismatches. Application transactions enforce other assignment, parent, approval and membership rules; foreign keys alone do not establish authorisation.
- `User_email_lowercase` and unique email enforce canonical account identities.
- CRM SQL maintains one Buyer per deal, distinct organisation/contact task links, one-target link checks and revenue/date constraints. See ordered SQL and the generated custom-SQL inventory.
- Vertical project uniqueness is a partial, case-insensitive index scoped by workspace and live status.
- Holy Sheet task movement uses `holy_sheet_task_move`; do not drop this trigger or SuiteGrant/CentralSessionLink while refactoring SHO.
- Bid-stage mapping has guarded before/after invariants and historical stage IDs. Do not rerun its data mapping manually.

A clean Prisma migration replay in CI is necessary but does not prove each negative/concurrent constraint case. Run direct constraint violations and competing mutations in an isolated database before claiming the entire contract verified.

## Deletion, Undo and retention

User deactivation is the normal account operation. Task/project deletion is normally a soft delete, permitting role-checked restoration/Undo. `undoable.ts` defines 30 × 24 hours; exactly the boundary is still eligible. Never substitute physical deletion for an application soft-delete path.

`jobs.ts` defines intended cleanup: tasks/comments older than 30 days in Trash; notifications after 90 days; action/audit history after 12 months. These are code policies, not evidence that any schedule is enabled or has run. Schedules remain paused. Retention changes require an owner decision and data-loss review.

Each relation's `onDelete` policy is listed in the reference. Important examples: user sessions/tokens cascade; ActionLog actor and ModelUsage user restrict deletion; audit actors are set null. Before deleting a row, inspect all inbound relations and external Holy Sheet links, not only the nearest model. Restored data must retain custom constraints and accepted legacy values.

## Sensitive and retired data

Personal data includes names, email addresses, contact details, notes/comments/task text, session user agents, IP/audit metadata and generated mail outboxes. Password hashes, token hashes and central/suite credentials must never appear in logs or evidence. Hashes of auth tokens are not suitable identifiers for public test reports.

Concierge has been removed from the application. `ChatMessage`, `ModelUsage`, Concierge enum values and legacy user preference fields are retained storage under the no-DROP policy. Do not restore those features or delete their data as incidental cleanup. Classify retention/export requirements before any future removal. Native suite routes and Holy Sheet link records are active integrations, not Concierge leftovers.

## Acceptance still required

A new maintainer should replay history in a disposable DB, inspect triggers/indexes/checks, execute role and inverse-operation fixtures, and compare a restored backup with this contract. Production catalog parity and a real restore drill remain open audit gates. This document authorizes no DDL or production operation.
