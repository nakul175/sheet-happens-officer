# Bid stage mapping — team intake, 24 October 2026

Owner-approved scope: Bid only (`pl_bid`, `DEAL_BID`). Proactive is unchanged.

| Existing stage ID | Previous label | Result | Category | Reason required |
| --- | --- | --- | --- | --- |
| st_bid_identified | Identified | Leads | ACTIVE, unchanged | No |
| st_bid_gonogo | Go/No-go | Under Evaluation | ACTIVE, neutral | No |
| st_bid_preparing | Preparing | Go | ACTIVE | No |
| st_bid_submitted | Submitted | Submitted | ACTIVE | No |
| st_bid_awaiting | Awaiting result | Historical only; retired | ACTIVE | No |
| st_bid_won | Won | Won | DONE | No |
| st_bid_lost | Lost | Lost | LOST | Yes |
| st_bid_nogo (new) | — | No-Go | LOST | Yes |
| st_bid_onhold (new) | — | On Hold | PAUSED | Yes |
| st_bid_ongoing (new) | — | Ongoing Projects | DELIVERY | No |

Visible order: Leads, Under Evaluation, Go, No-Go, Submitted, Won, Lost, On Hold, Ongoing Projects.

Ongoing Projects means active post-Won delivery. It is outside the sales pipeline and sales counts. No existing Won deal moves automatically. Tasks remain supported during delivery; runtime rules and UI are separate from this data migration.

## Deployment order and transaction boundary

1. `20261024110000_stage_delivery_category` adds `StageCategory.DELIVERY` only. PostgreSQL must commit this migration before the next migration uses that value. Do not combine both migrations into one transaction.
2. `20261024110100_bid_stage_mapping` performs the guarded mapping in one explicit transaction. It adds `Stage.isRetired` with false default, then marks only Awaiting result retired and inserts the three new Bid stages.
3. The compatible runtime must hide retired stages from new choices and normal moves, preserve them for historical display and Undo, and handle DELIVERY outside sales aggregates.

The mapping migration locks Pipeline, Stage and Project against concurrent writes. Before schema/data changes it requires the exact seven original seeded Bid IDs, labels, positions, categories, reason rules and empty requiredFields. Missing/custom stages, reserved new-ID collisions and inconsistent project pipeline/stage references abort. An operator must inspect and approve a separate explicit mapping for customized installations; do not bypass preflight by relabelling their data.

## Preservation guarantees

All Bid projects currently in Awaiting result move to the existing Submitted ID, including archived projects. Only stageId changes; stageReason, stageChangedAt, updatedAt and every other project column are preserved. All other Bid projects, including Won, keep their stage. Project counts are asserted unchanged. Existing stage IDs, including Awaiting result, remain present so history and Undo references remain valid. No history or Undo JSON is rewritten.

The migration snapshots and asserts all other Stage rows, all Pipeline rows and all projects in other pipelines unchanged. It asserts the entire expected post-migration Bid-project snapshot, allowing only the defined Awaiting→Submitted change.

## Validation and recovery

Root owns applying these migrations to the isolated local integration database before any staging proposal. Validate seeded success with active and archived Awaiting projects, Won and Proactive projects, historical references, and customized/missing seed rejection with no partial changes. Run migration contract tests and runtime regression suites as well.

Failure of the mapping migration rolls back its changes. The earlier DELIVERY enum addition can remain unused safely; PostgreSQL enum removal is not an automatic rollback. After new data is written, rollback requires an explicit data review: do not delete new stages, force Delivery back to Won, reconstruct split decision states, or rewrite history automatically. Production application remains separately approval-gated.
