# SHO-3041: Bid stage migration proposal

Status: preparatory design, not approved runtime policy. No migration has been applied.
Scope: `Pipeline.key = DEAL_BID` only. Proactive (`DEAL_PROACTIVE`), ordinary projects (`PROJECT_STATUS`), their stages and their deals must remain byte-for-byte unchanged.

## Evidence on this branch

The original CRM migration seeds seven Bid stages under `pl_bid`. `Stage` has no retirement/alias field. Stage category drives workflow behavior: `DONE` and `LOST` require all tasks (including subtasks) closed before a move and produce a closure audit event (`src/lib/deals.ts`, `moveStage`). Historical action JSON stores both stage IDs and names. `src/lib/undo.ts` requires the previous stage ID to still exist in the same pipeline and restores its ID/reason. Deleting legacy stage rows breaks that Undo contract; the Stage FK uses ON DELETE SET NULL. Existing stage-removal API is therefore unsuitable for this migration.

## Proposed exact mapping and unresolved choices

| Existing Bid stage ID / name | Proposed target | Treatment / required decision |
|---|---|---|
| `st_bid_identified` / Identified | Leads | Rename in place, retain ID; no deal data movement. |
| `st_bid_gonogo` / Go/No-go | Under Evaluation | Recommended neutral rename, retain ID. A combined historical label cannot establish an individual Go/No-Go decision. Owner must approve neutral mapping or supply reviewed per-deal decisions. Never infer from title, reason text, task completion or AI. |
| `st_bid_preparing` / Preparing | Go | Plausible interpretation, **not established by stored data**. Approve this mapping, or map reviewed deals individually while retaining a legacy stage until resolved. |
| `st_bid_submitted` / Submitted | Submitted | Retain ID/category/rules. |
| `st_bid_awaiting` / Awaiting result | Submitted | Approved-intent candidate because intake explicitly combines submission/results-awaiting. Move references to retained Submitted ID only after a signed mapping manifest; retain old stage row as a legacy Undo target. A new retirement/alias mechanism is required to prevent it appearing as a new choice. |
| `st_bid_won` / Won | Won | Retain ID and existing DONE category until Won-follow-up policy is separately agreed. |
| `st_bid_lost` / Lost | Lost | Retain ID, LOST category and reason requirement. |
| New `st_bid_nogo` | No-Go | New ID; category decision needed: LOST closes/deal-summary excludes and triggers open-task guard; PAUSED remains open. Do not silently equate No-Go with Lost. Reason requirement also needs agreement. |
| New `st_bid_hold` | On Hold | Recommend PAUSED + reason; owner must approve. No existing deals auto-move here. |
| New `st_bid_ongoing` | Ongoing Projects | New ID; choose ACTIVE follow-up work versus DONE reporting outcome. No existing Won deal auto-moves. This is a Bid stage label, not conversion to ordinary Project. |

Requested active order: Leads, Under Evaluation, Go, No-Go, Submitted, Won, Lost, On Hold, Ongoing Projects. Keeping IDs is more important than original positions; only approved Bid positions change. Legacy retired Awaiting result must not add a tenth selectable column, while remaining resolvable for history and Undo.

### Options the owner can choose

1. Recommended neutral combined-stage policy: Go/No-go becomes Under Evaluation, Preparing becomes Go only if approved; owners manually resolve historical evaluation deals later. No-Go starts empty.
2. Reviewed per-deal policy: owner supplies `{dealId, oldStageId, targetStageId}` decisions for combined/preparing stages; unresolved deals remain in legacy stages. An exact nine-column launch waits until every unresolved deal has an approved placement.
3. Never use a blanket split into Go versus No-Go. Historical intent is absent; any automatic inference would invent data.

## Deterministic dry run before any write

- Resolve actual Bid pipeline by key, not name or assumed ID. Validate workstream DEAL; reject duplicate IDs, missing seeded rows, unexpected categories/rules, custom/renamed Bid stages and cross-pipeline projects for manual review. Do not overwrite custom rows because a seeded ID happens to match.
- Snapshot all Bid stage metadata; affected project IDs, pipeline/stage/reason/stageChangedAt; counts including archived deals; immutable audit/action identifiers; references to historical IDs in Undo actions. Preserve a separately hashed full Proactive/project-stage snapshot as a no-change assertion.
- Produce a stable sorted mapping manifest, input snapshot digest, affected counts and explicit unresolved rows. Zero writes for dry run. All destinations must be Bid stage IDs. Every source deal appears exactly once, and before/after totals match.
- Require explicit decisions for category/guard changes, preparing/combined mapping, custom stages and legacy retirement support. Absent decisions => abort, not best-effort migration.
- Build application support for non-selectable legacy stage IDs before migrating Awaiting result. List/history/Undo must resolve legacy IDs while new moves cannot choose retired rows. If Undo restores a retired ID, present it faithfully as legacy and allow a normal authorized move out; never rewrite the original action JSON.

## Apply design (future, separately authorized)

One transaction checks the approved snapshot digest under locks, creates only approved new Bid IDs, renames approved existing Bid stages, and changes only listed Bid project references. Set no project pipelineId, typeId, membership, task assignment/completion or archive flags. Preserve per-deal reason and stageChangedAt for a semantic relabel; record explicit before/after migration facts in a dedicated auditable migration receipt rather than masquerading as user moves/notifications/closure. Any actual business transition uses the normal authorized transition path and timestamp/audit behavior.

Do not delete any Stage, Project, ActionLog or AuditEvent row. Preserve historic JSON names as historic facts. A repeat apply of the same manifest must be a no-op; a mismatch aborts. Immediately compare unchanged Proactive/project snapshot digests, all project IDs and counts, all old stage IDs, and audit/Undo rows. Test fixtures include archived Bid deals, old awaiting stage Undo, recent moves, custom stage refusal, and concurrently changed data refusal.

## Rollback design

Store a versioned inverse manifest containing original names/order/category/reason/requiredFields and each changed project's original stage/reason/timestamp. Revert only rows still matching the migration's expected after-state; concurrent user edits cause a conflict report and transaction abort. Restore old IDs in place. Leave any newly created stages with new user references intact until separately reviewed; never hard-delete them. Recheck Proactive digest, project counts and original history/Undo. Test rollback on a disposable DB before staging application. Production execution still requires explicit human approval.

## SHO-3042: pipeline count implications

Stage display names are not opportunity types. RFP/RFA + OTC count inclusion must use an agreed Opportunity Type field, and handle existing null/legacy values explicitly. EOI and CV/LTA can remain visible without contributing to the chosen pipeline-value metric. No-Go/On Hold/Ongoing category choices affect open/deal summary counts and need named metric acceptance examples. Do not infer type from stage or mutate the Proactive pipeline/count semantics under this Bid-only request. Confirm whether counts mean number of opportunities, monetary sums or both, and which stages/currency conversion rules apply.

## SHO-3050: Won follow-up implications

Current DONE guard and next-step rules intentionally close deal tasks before Won. Allowing contract tasks on Won changes lifecycle behavior. Agree whether Bid-only Won can retain open tasks, whether new tasks are allowed, how closure/audit/next-step/reminder counts behave, and whether Ongoing Projects is active contract execution or a reporting-only Won substage. Proactive's existing Won guard remains intact. Merely renaming Won, changing its category to ACTIVE, or switching existing Won rows into Ongoing Projects would silently change acceptance and is excluded.
