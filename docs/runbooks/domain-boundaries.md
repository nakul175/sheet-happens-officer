# Domain ownership and transaction boundaries

`access.ts` owns project membership, role and CRM visibility. `task-access.ts` adapts that access to task/action not-found semantics; it must not import task/deal/record mutation services. `tasks.ts` re-exports the adapters for compatibility. Deals and records import the small adapter directly, removing the two known reciprocal runtime imports.

`tasks.ts` owns task state changes and validation (assignment, approval, completion, move, deletion). `deals.ts` owns deal classification, stage and next-step invariants. `records.ts` owns contact/note/task-link changes. Changes spanning these records must remain in the caller's Prisma transaction; do not replace transaction clients with the global client in helpers.

`undo.ts` owns inverse operations and eligibility, not a second generic persistence layer. For every new mutable action, specify before/after state, write authorization, optimistic version requirement, audit/notification effects and inverse behavior. Test duplicate/retried Undo, expired/deleted dependencies, and concurrent writes before extracting more code. Pure import refactors must not alter public API shapes or denial semantics.

This is an incremental boundary cleanup, not proof that every historical Undo invariant has been tested. Full integration/Undo regressions remain required in qualification. The workspace isolation contract is tracked separately in HR-11.
