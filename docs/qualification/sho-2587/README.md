# SHO-2587 — Eng1 code qualification

Base: `b73b9e6931805a1ce56146e9907fdb9056adf0ca` (live e1-2729 tip).
Head branch: `codex/sho-2587-eng1-base-b73b`.

## Scope

Stage A PostgreSQL keyword/stem/trigram search across tasks, projects, deals,
organizations, contacts and notes. The Search screen and Palette consume one
ranked payload (at most 25 records), with record type, matched field, plain-text
two-line excerpts and existing record links. Notes open their organization.
An exact title/phrase gets priority; coverage across matched fields, stems and
long-token spelling variations contributes to ranking. Ties use record type/ID.

Authority is re-read for every query. Workspace, current membership, CRM,
archive, removal and Trash predicates apply before ranking/limiting. The query
does not search chats, comments or attachments, call a provider, persist query
text, or maintain a separate index synchronization job.

NJ's 30 October Concierge stop supersedes this story's earlier Concierge
consumer criterion. `src/lib/concierge/reads.ts` is byte-identical to the base;
no Concierge expansion is included. The legacy search path, including its
existing feature-gated comment search, stays intact while Stage A is disabled.

## Migration and activation HOLD

`SEARCH_STAGE_A_ENABLED` is **off by default**. Only the exact value `true`
activates the extension-dependent query. Do not enable it before NJ's separate
database approval and successful isolated acceptance. An activated query failure
is reported as an error; it is not disguised as an empty result or a fallback.

`search-indexes.sql` is an **unapplied review draft outside Prisma migrations**.
No schema/migration, database, extension or production/staging configuration has
been changed. The draft adds expression GIN indexes and pg_trgm, with separate
production lock/concurrent-build review required. It must not run automatically.
Jim/Oscar retain cut ownership. Application rollback disables the switch and
retains additive indexes until separately approved cleanup.

## Validation status

- 13 focused input/excerpt, query-contract, activation and existing archived-search
  tests pass. Query tests mock Prisma: they establish bindings, predicates and
  payload behavior, **not execution correctness or query-plan/performance proof**.
- Repository lint: zero errors (20 existing warnings).
- Application TypeScript and story TypeScript: pass after restoring lockfile
  dependencies. Production build: pass.
- CI script tests: 31 pass, zero failures/skips.
- No local database mutation or extension installation; full database-backed
  tests, SQL/index execution, loaded-browser checks and benchmark are not run.
- This candidate is for code qualification, **not production activation or Done**.

## Acceptance after NJ YES

1. Use a new disposable database; review/apply the existing schema separately,
   then the reviewed index SQL. Confirm pg_trgm and EXPLAIN index use. Never
   target shared staging or production from a local acceptance runner.
2. Seed 20,000 synthetic tasks and 5,000 notes plus representative projects,
   deals, organizations and contacts. Include exact IDs from the fixed
   `acceptance-queries.json` catalogue and unrelated distractors. This catalogue
   was recorded before database ranking tuning; retain failures and revisions.
3. Run all 30 queries as a member; record expected/actual top hit and miss rate.
   Warm once; measure at least five subsequent complete passes, recording every
   latency and p95 (nearest-rank), with the production HTTP search route included.
   Require p95 <500 ms. Save population counts, plans, environment and candidate.
4. Repeat visibility checks after revoking membership, archiving and deleting
   projects/tasks, removing contacts/notes, CRM off/admins modes and with a
   different workspace. Include a private deal note, its organization and
   restricted task. Membership changes must take effect on the next query.
5. Check Search and Palette keyboard navigation, escaping and two-line excerpts
   at desktop/390/320px; verify note links and no obsolete-query Palette results.
   Run the required full regression/security/CI gates before requesting a cut.

No embeddings or Stage B are included. A future Stage B decision requires its
own refinement; the >20% miss threshold cannot authorize provider work here.
