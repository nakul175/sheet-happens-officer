# SHO-3137 — remove the in-app Concierge

Base: `a5356a7dd38c233fbe2f3c287f0f0f54cb0fad39` (live e1-2587 tip).
Head branch: `codex/sho-3137-eng1-base-a535`. BTF issue: SHO-3137, internal ID 3286.

## Delivered source scope

- Remove the provider client, engine, private thread/preferences, cards, model
  budget/usage functions and all nine `/api/concierge/*` route handlers.
- Remove the shell provider, entry points, drawer/dock/bar/FAB, microphone and
  prompt UI. Page content no longer reserves assistant width or footer space.
- Remove the Usage screen/API/navigation and dedicated styles. Audit, task,
  CRM, notifications, keyboard/overlay and ordinary Undo controls remain.
- Remove chat retention/budget jobs, provider environment injection, optional
  eval workflow/script and provider-only tests/docs. Existing host cron entries
  for the two retired jobs exit before loading secrets or making HTTP calls;
  new provisioning/release code does not recreate them.
- Preserve quick-add date parsing in `src/lib/relative-dates.ts`; `resolveDue`
  and `istParts` bodies are identical to the base. Preserve bulk Undo action-log
  collection and notification grouping, with a new regression check.
- Retire only obsolete assistant assertions from mixed tests; retain their
  task/CRM/privacy/comment/Undo assertions. Updated shell acceptance checks full
  content width and existing Audit authorization. Add new removal acceptance.

## Storage and release boundary

No database, schema or migration is changed or applied. Existing private
ChatMessage/ModelUsage tables, User preference columns and historical migration
files remain dormant for compatibility and data retention. There is no app
runtime reader/writer for them. Existing synthetic-data cleanup utilities may
still clean legacy fixture rows. Any physical data/table/column cleanup requires
separate NJ approval and a reviewed retention/rollback plan.

Historical activity/audit rows remain readable with a generic historical source;
the current application writes the normal SCREEN channel. No old audit record
is rewritten. Repository code stops injecting provider variables; live secrets
are not rotated, revoked or edited by this change.

All `/api/suite/*` source and the complete SHO-2587 search implementation remain
identical to the base. SEARCH_STAGE_A remains default off. No held story or
forbidden commit is added. This is qualification source only; Jim/Oscar retain
production cut ownership. No deploy, restart, main merge or schedule activation.

## Evidence

- Focused removal/search/suite tests: 24 passed in 6 files, no failures/skips.
- Application and story TypeScript checks pass. Repository ESLint: zero errors.
- CI script tests: 31 passed, no failures/skips.
- Production build passes; `node scripts/verify-concierge-removal.mjs` reads the
  built router and reports zero retired routes and all four suite routes.
- YAML syntax and deployment shell syntax checks pass.
- Playwright story collection succeeds. New `SHO-3137.spec.ts` covers signed-in
  endpoint retirement and Home/My tasks/Projects/Profile at 1512/390/320px.
  Collection is not browser execution.

Full server/database regressions and loaded desktop/phone acceptance must still
be verified in CI/isolated staging before a cut. No provider key is needed.
After the reviewed cut, verify exact live SHA, health, suite authorize/token/
userinfo/status, login, task creation/Undo, CRM/search and the removed controls;
record receipts in BTF/Bug Off before Done. Rollback is the unchanged prior
application revision; there is no destructive storage migration to reverse.
