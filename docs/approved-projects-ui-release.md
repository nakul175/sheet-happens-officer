# Approved Projects UI release

Scope: SHO-3077 Projects delivery, SHO-3078 Vertical boards, SHO-3079 New project, SHO-3080 project List, SHO-3081 Board, SHO-3082 Task details and SHO-3083 shared navy navigation. Approved 27 October 2026. Based on reviewed release candidate a76dd097, which contains the existing vertical, recoverable Trash, auth and membership behavior. No API, schema, permission, runtime entry or dependency changes.

Lato is self-hosted with its OFL license. Styling is limited to the approved routes and the shell while one of those routes is rendered. Board and task details use the approved layouts; other page bodies keep their existing layout. The shared authenticated navy header uses a transparent white/gold variant derived from the real SVG, retaining its geometry and transparent clearing mask. Concierge remains accessible using its existing bottom bar/floating layout. Long stored names remain intact. Classification, role, Leader, read-only and explicit open-task metadata remain available. No illustrative sample data or unsupported menus were added.

The New project form keeps its original payload, people eligibility and first-task navigation, with an added Cancel link and submit guard. The List changes preserve selection/completion independence, Leader-only section menus, filter and saved-view URL state, bulk actions, inline edits, quick add and pagination.

Local validation: 37 focused regressions across seven files pass; direct TypeScript check passes; optimized webpack production build passes. Scoped lint has no errors (existing Shell/ProjectView warnings remain). The baseline package typecheck command refers to a missing scripts/typecheck.mjs; the direct TypeScript check and Next build were run instead.

Desktop and 320px fixture screenshots are captured separately. These exercise real UI components with synthetic API fixtures and are not staging or production evidence. Required CI, staging and production verification remain release gates; this document does not assert deployment completion.

Release procedure: obtain all required CI results for the exact candidate; stage on the established isolated SHO slot with exact-SHA health, role/behavior and visual verification; retain and validate rollback; deploy atomically only after verifying the current production parent has not changed; verify public and local health, sign-in and authenticated approved routes on the deployed revision. Record revision, CI links and screenshots in the seven BTF CRs before Done. No schedules.
