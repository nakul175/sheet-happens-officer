# Domain ownership and transaction boundaries

`access.ts` owns project membership, role and CRM visibility. `task-access.ts` adapts that access to task/action not-found semantics; it must not import task/deal/record mutation services. `tasks.ts` re-exports the adapters for compatibility. Deals and records import the small adapter directly, removing the two known reciprocal runtime imports.

`tests/lib-runtime-import-cycles.test.ts` scans static runtime imports and re-exports across all `src/lib` TypeScript modules. It fails if a new cycle appears, while ignoring type-only edges. Keep this guard with the targeted task/deal/record boundary test; it does not prove transaction ownership or detect dynamic imports.

`tasks.ts` owns task state changes and validation (assignment, approval, completion, move, deletion). `deals.ts` owns deal classification, stage and next-step invariants. `records.ts` owns contact/note/task-link changes. Changes spanning these records must remain in the caller's Prisma transaction; do not replace transaction clients with the global client in helpers.

`undo.ts` owns inverse operations and eligibility, not a second generic persistence layer. For every new mutable action, specify before/after state, write authorization, optimistic version requirement, audit/notification effects and inverse behavior. Test duplicate/retried Undo, expired/deleted dependencies, and concurrent writes before extracting more code. Pure import refactors must not alter public API shapes or denial semantics.

## A change through these modules

| Change | Transaction owner | Rule/helper used inside that transaction | Focused regression entrypoint |
| --- | --- | --- | --- |
| Task assignment or membership grant | `tasks.ts` `assignTask` | Lock task, then project/people/membership; re-read actor, access and expected version. `project-task-membership.ts` adds a seat only when explicitly requested. Task row, notifications and ActionLog commit together. | `tests/task-assignment-race-db.test.ts` |
| Task completion, reopen, move or restore | `tasks.ts` service function | Re-check live access/version under locks. Call `deals.ts` `ensureNextStep(tx, ...)` with the **same** transaction client when a working deal loses its dated next step. | `tests/task-move-race-db.test.ts` and the task lifecycle/restore suites |
| Deal stage/details or Buyer mutation | `deals.ts` service function | `access.ts` authorizes the deal project; stage and next-step invariants, details and ActionLog are owned here. A task caller may invoke only the transaction-scoped `ensureNextStep` invariant. | `tests/undo-deal-stage-db.test.ts`, `tests/undo-deal-details-db.test.ts` |
| Contact, note or task link mutation | `records.ts` service function | `task-access.ts` supplies task visibility without importing task mutation services. Record-specific permissions and inverse state are recorded here. | `tests/record-access-boundary.test.ts`, `tests/undo-contact-db.test.ts` |
| Project-scoped Undo | `undo.ts` `undoAction` | `prepare` checks eligibility/conflicts; transactional actions lock/re-read, then `applyPreparedUndo(tx, ...)` claims the log and applies the inverse within the same transaction. | Relevant `tests/undo-*-db.test.ts` plus the matching forward-action race suite |
| Organisation/contact/note Undo without a project | `records.ts` `undoRecord`, called by `undoAction` | Record service opens its own transaction and rechecks actor/record authority; do not pass a global client into a project-scoped Undo transaction. | `tests/undo-contact-db.test.ts` and record Undo suites |

When changing a forward action, first locate its ActionLog shape and the matching inverse switch case. Record the lock order, current actor/membership check, version precondition, notification/audit effects, and cleanup behavior. Add a real PostgreSQL concurrency case for an access or version race; use a browser case when the user can observe a different state. Keep the existing API contract stable while moving a rule to a smaller module.

This is an incremental boundary cleanup, not proof that every historical Undo invariant has been tested. Full integration/Undo regressions remain required in qualification. The workspace isolation contract is tracked separately in HR-11.
