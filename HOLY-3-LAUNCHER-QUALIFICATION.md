# HOLY-3 controlled launcher candidate

Base: canonical `release/accepted15-20261024` at `5346f49f187d41082becb7dacf87237656295aa2`.
Do not deploy from the unrelated historical main branch. PR #162 is separate work.

This candidate adds a task-side document URL launcher, not persistent attachments,
page creation, automatic sharing or a completed HOLY-3 acceptance claim. It requires
the paired HS embed account boundary before enabling.

Off by default. Controlled qualification requires `FF_HOLY_SHEET=1` and
`HOLY_SHEET_ORIGIN=https://staging.holysheet.aplyd.org`. No alternate hosts or
identity tokens can be supplied in the document URL. The context endpoint first
checks normal task access, then binds the current native session to the verified
central subject and rechecks the live authority. Native-only sign-in is refused.
The subject restricts which HS account may render; it does not authenticate or
grant access. Responses, including denials, are private/no-store.

The frame permits scripts, forms, sign-in popups and authorized downloads, without
top-level navigation. It is removed on failed periodic/focus checks and account
changes. Checks run every minute; this is not instantaneous push logout. HS API
checks remain authoritative on every operation.

Before enabling: confirm actual host revision and rollback procedure, pair the HS
boundary, use synthetic tasks/pages and dedicated QA accounts. Qualify matching
and mismatched accounts; signed-out login; owner/editor/viewer/unshared; edit in
SHO visible standalone; media download; task membership loss; suite logout before
JWT expiry; HS/accounts outages. Record revision, identities, task/page IDs and
timestamps privately. Do not replace the shared live SHO service with this draft
merely to run a qualification test.

Validation: six focused URL/context tests pass. Broader release validation and
live paired browser qualification remain required. The existing package's
`typecheck` script refers to a missing `scripts/typecheck.mjs`; direct TypeScript
and production build results must be recorded separately.
