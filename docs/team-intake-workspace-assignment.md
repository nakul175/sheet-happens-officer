# SHO-3058: explicit workspace people selection

Local implementation on `local/sho-3058`; no production/staging change or shared database acceptance run.

Project Leaders and same-workspace Admins can search active, verified workspace people by name from project Add task and task detail, separately for Assignee and Collaborators. Search returns only ID, display name and whether the person is already a project member; no email, private project names or other profile data. Results are bounded to 20. Existing Viewers are not offered as assignees. Existing Viewer collaborators remain supported by the existing collaborator contract.

Selecting a nonmember opens an explicit confirmation that grants Editor access to the entire project. It says that undoing the task change does not remove project access. Add-task selection delays the actual membership grant until the task is saved; cancelling the form grants nothing. Assignee/collaborator pending choices are separate so each role gets its own explicit selection/confirmation.

The server retains current membership authority: ordinary Editors cannot search through this manager endpoint or grant membership. Existing-member assignment/collaboration continues through existing controls. Global Quick Add remains self-assigned. External invitations and workspace account creation are excluded.

A confirmed grant is created in the same database transaction as assignment, collaborator addition or task creation. The helper locks the project, rechecks current active same-workspace actor/Leader-or-Admin authority, and validates the target's active same-workspace identity. Conflict-safe membership insertion retains every existing role; an existing Viewer is never promoted. Explicit reassignment/collaboration also locks/rechecks the task version, so failure rolls membership back. Concurrent existing membership sends no duplicate member-added notice/action. Task assignment/collaboration uses existing notices and primary Undo action; membership addition is a secondary independently logged grant. Existing member-removal Undo rules still refuse revocation while someone holds open tasks.

API additions:

- Manager search: `GET /api/projects/:id/assignment-people?q=...&purpose=assignee|collaborator`.
- Existing assignment POST adds optional `addToProject: true`, retaining required `expectedUpdatedAt`.
- Existing collaborator POST adds optional `addToProject: true` and requires `expectedUpdatedAt` when using that explicit grant path; old existing-member payloads remain accepted.
- Existing task-create POST adds `addAssigneeToProject` and `addCollaboratorsToProject` confirmations; every confirmed collaborator must also be selected in `collaboratorIds`.

Regression coverage includes role refusal, cross-workspace/inactive-target refusal, unchanged Viewer role, existing-member idempotency, failed-write/stale-version rollback, collaborator insertion races, task creation, explicit UI confirmation/cancellation and Editor UI restrictions. Real local PostgreSQL concurrency and full browser acceptance remain required before declaring this issue accepted. No database/schema migration is needed.
