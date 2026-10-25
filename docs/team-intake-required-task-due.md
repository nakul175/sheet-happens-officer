# SHO-3037: creation-only due dates

Owner decision: newly created top-level tasks in Projects and personal Inbox require a due date. Existing undated tasks, Ideas and subtasks remain optional. No automatic due dates or historical backfill.

`createTask` enforces this after Project visibility/write checks, before transaction side effects. Workstream Project includes personal Inbox storage; Deal task contracts remain unchanged. Direct integrations and Concierge call the same domain function. Concierge also reports a missing-date blocker on its proposal before confirmation. Creation parses actual calendar dates, rejecting impossible dates rather than normalizing them.

Global Quick Add, Project inline Add and the full Project task modal expose due-date input. They can capture an Idea explicitly in the same create request. `isIdea` is persisted with the task inside its creation transaction and included in creation history; it is not an exception-only validation flag. Undated ordinary tasks cannot first be created and then toggled to an Idea. Subtasks cannot be created as Ideas, matching the existing top-level Idea toggle restriction.

Existing task edits, clearing existing due dates, and Idea-to-task toggles keep their prior creation-only compatibility. No database migration or blanket non-null constraint is needed. Creation Undo retains its existing delete/restore flow and therefore preserves the stored Idea state.

Focused tests cover missing/null dates, impossible dates, explicit leap-day storage, actual atomic Idea persistence/history, optional subtasks, unchanged Deal task policy, legacy update schema compatibility, and Quick Add UI draft preservation and single-request Idea capture. Full real API/browser acceptance and broad suite compatibility remain integration gates; no staging claim is made.
