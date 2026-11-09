# SHO multi-workspace implementation boundary

Owner approved true multi-workspace support on 9 November 2026. The additive foundation now has a staging-only native selector and companion Portal Review/Save integration. Production rollout is not authorized. No original User, Session or business row is migrated or reassigned. People remains limited to the selected Employee Company by separate owner decision.

## Authority model

`User.workspaceId` and `User.orgRole` retain the original workspace authority. Additional `WorkspaceMembership` rows carry MEMBER/ADMIN only. SQL constraints reject duplicate original-workspace authority and extra SUPER_ADMIN. Native session selection is server-side and constrained to the exact session user/membership. Role changes are read fresh; revoke increments generation; regrant cannot resurrect a previously selected generation. An explicit switch to the unchanged original workspace remains possible after additional membership revoke, provided native and central authentication are still valid.

The private Portal membership service accepts only an operator-reviewed native original-workspace SUPER_ADMIN for that exact destination workspace. Initial enrollment is MEMBER. A protected native superadmin target, cross-workspace reviewer, stale preview, dormant project/task authority, duplicate request or failed receipt/audit refuses the transaction. Regrant explicitly reviews preserved project/task authority; assignments and business data are never deleted. It does not create users or infer email identity.

`session.mjs` requires prior central-session authentication. It is not itself a login API. New services and migrations are only exercised against disposable synthetic staging databases in this batch.

## Verified foundation

- Prisma schema validate/generate and application typecheck pass.
- Ten real PostgreSQL tests on the captured full native schema pass, including exact same native session grant/downgrade/revoke/regrant, preserved original account/session, independent original-workspace session, expired/global-disabled/foreign-session rejection, foreign-key and role constraints, stale review, dormant authority, rollback and concurrent confirmation.
- Additive migration and rollback on populated fixtures preserve every original native table, including existing accounts, sessions and project/task content.
- Synthetic database and owned SSH tunnel removed after every run.
- This is service-level qualification; it is not browser or Portal Save acceptance.

## Review boundaries

The staging candidate implements the following boundaries. Fresh CI and browser evidence are recorded in the companion acceptance pack; no production activation is implied:

1. Native sessionUser/central-login integration and a CSRF-protected exact workspace selection endpoint. Selection never overrides central app/session revocation.
2. Explicit workspace-scoped Actor through project/task access, search, CRM, teams/people, records, feed, notifications, background work and all mutation checks. Original account reads are retained only for identity, password/session and original-authority checks.
3. Team administration must change scoped membership, never globally deactivate/reissue credentials for a person simply because they belong to an additional workspace. Preserve existing global account operations only under explicit original authority.
4. Portal exact identity/resource review, signed preview/confirmation, durable uncertain-dispatch hold, native readback and receipts. Original-workspace project/org editors retain their original-workspace restriction. The separate additional-workspace editor changes membership; it never pretends to rewrite project roles.
5. Full regression/build/CI, real browser Portal Save, workspace switch and existing-tab grant/downgrade/revoke; two workspaces and two sessions; cross-workspace Admin negative tests; before/after preservation and additive migration/rollback rehearsal.

No production migration, deployment, runtime activation, merge or schedule changes are authorized by this foundation.

## Runtime and Portal candidate (staging only)

The native `SHO_MULTI_WORKSPACE_ENABLED=true` switch enables the account-menu
workspace chooser and explicit `/api/workspaces` selection. The session cookie
stays unchanged. Business handlers read current membership; project/CRM/people
scope is the selected workspace. Selecting another workspace performs a full
navigation to discard cached content from the prior authority. A revoked or
superseded selection shows a recovery chooser rather than protected content.
Regrant never revives the prior generation; explicit reselection is required.
Global account administration is held for additional-workspace administrators.

Portal's independent `APLYD_SHO_WORKSPACE_EDITOR_ENABLED=1` gate uses a private
`APLYD_SHO_WORKSPACE_CONNECTOR` wrapper invoking `scripts/portal-workspaces/cli.mjs`
and `APLYD_SHO_WORKSPACE_CONFIG` with the existing private org-connector config
shape. Native identities come from a fresh reviewed binding or the exact Portal
creation receipt, never email. Review is signed for five minutes and pins the
reviewer, target, resource, private configuration, reason and native snapshot.
A durable reserved/uncertain receipt prevents automatic replay. Confirmed writes
are read back before the Portal reports success. Role choices are bounded to
Member/Admin; enrollment/regrant starts as Member. Regrant review discloses
preserved project and task assignments.

Both PRs remain drafts, unmerged and undeployed. This introduces an additive
native migration and requires fresh staging evidence and a separate production
approval. Disabling the native feature with an existing selected session denies
that selection rather than silently returning another workspace's authority.

## Additional-workspace project editor

The companion Portal project editor is separately default-OFF. Private config
`project_ids` explicitly pins the native project IDs available for this workspace.
The list reads live names, filters to that workspace's active projects, and is
intersected with reviewed Portal ResourceMappings; company/organisation membership
alone does not establish project scope. Native `projects.mjs` and the private CLI
require an active additional MEMBER membership and the workspace's pinned original
SUPER_ADMIN reviewer. ADMIN workspace access must be reviewed separately because
it overrides project seats.

Signed Review/Save supports Editor, Viewer, remove and explicit regrant without
changing the workspace membership or native sessions. Leader transfer requires an
existing project member, keeps exactly one Leader, and leaves the previous Leader
as an Editor member. Existing creator and workspace Admin authority remain intact.
A current Leader cannot be downgraded or removed without first replacing them.
Creator downgrades that would misrepresent effective authority are refused.

Task assignee/approver/collaborator references are never silently rewritten. Viewer
downgrade/removal is held while such work requires handover; use SHO's existing
explicit task handover before retrying. The transaction locks current native scope,
roster and assignments, compares the entire reviewed proof, and atomically commits
membership, receipt, native action history and audit. Audit failure rolls back the
membership. Uncertain Portal dispatches block further SHO changes until reconciled.
No new migration is required beyond the stacked workspace foundation.
