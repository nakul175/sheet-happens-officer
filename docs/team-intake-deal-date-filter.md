# SHO-3043: explicit Deals calendar filter

Local implementation on `local/sho-3043`; no migration, shared database mutation, staging deployment or publication.

Deals offers an optional date basis: Submission deadline, Created date or Expected close. A user chooses at least one inclusive From/To calendar bound and applies it. There is no guessed default date basis. The initial request has no date predicate and preserves existing behavior. Clear removes both the applied filter and draft controls. Invalid dates, unknown basis, inverted ranges and invalid undated flags return HTTP400; the UI preserves the last applied results and displays the validation error.

Active filters exclude missing dates by default. Include undated deals explicitly includes null dates and missing detail rows for the selected deadline/close basis. Created date is always present. Filter state is local to this Deals view; it does not change Monday review or any global project data. Existing lifecycle, pipeline, mine, archive and project-visibility restrictions remain intersected with the date predicate. All Deals group counts and currency metrics derive from the same filtered server result.

Calendar semantics:

- Precise submission deadlines and Created timestamps use IST (Asia/Kolkata, UTC+05:30). A range for 25 October includes instants from 24 October18:30UTC inclusive to25 October18:30UTC exclusive.
- Legacy date-only submission deadlines keep their recorded calendar date; their UTC-midnight storage is not treated as an explicit05:30 time. The existing precision flag selects the correct branch.
- Expected close is date-only and keeps its calendar date.
- A To date includes the entire chosen calendar day. Missing From or To means an open bound. There is no mandatory time or inferred timestamp for undated deals.

API: `GET /api/deals` accepts optional `dateBasis=submissionDeadline|createdAt|expectedClose`, `dateFrom=YYYY-MM-DD`, `dateTo=YYYY-MM-DD`, `includeUndated=true|false`. A basis plus at least one bound is required for an active filter. Existing no-filter requests remain accepted. The list adds read-only `createdAt` (UTC ISO) and `expectedClose` (date-only or null) metadata.

Tests cover IST/UTC boundary construction, legacy precision, open/inclusive bounds, missing-date policy, invalid inputs and API400/session precedence, query intersection with privacy/lifecycle/mine/archive, Apply/Clear UI and filtered Deals metrics. Actual PostgreSQL query results around the boundaries and full browser acceptance remain pending a root-coordinated isolated local application. No staging verification is claimed.
