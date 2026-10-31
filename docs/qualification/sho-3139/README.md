# SHO-3139: BD deal fields

This candidate adds four nullable facts to DealDetails and the existing create/edit/read surfaces:

| API field | Meaning and validation |
| --- | --- |
| `partner` | Free text bidding-partner name; trimmed, at most 200 characters; blank means unknown. It does not grant access or create an organisation link. |
| `athenaRole` | `PRIME`, `SUB` or `SOLO`; displayed as Prime, Sub or Solo. |
| `budgetUsd` | USD only, nonnegative Decimal(15,2); at most two decimal places. |
| `pwinAdjustedNfrUsd` | Entered USD amount after PWin adjustment, with the same precision/range. It is not silently recalculated or converted from deal value/currency. |

Existing PWin and Net Fee Revenue (USD) remain unchanged. Unknown values remain null, distinct from zero. Existing `value`/`currency` continue to describe the original deal value independently of these USD fields. The API rejects strings, currency objects, invalid role codes, negative amounts and excessive precision/range. Board/list/detail use a native BD details disclosure; existing access and CRM visibility checks still authorize the read paths. Detail edits include the facts in action-log snapshots and Undo conflict checks.

## Migration and approval

`20261031101131_sho3139_bd_fields` creates the three-value role enum and adds only these four nullable columns in a transaction. There is no drop, backfill or existing-row rewrite. Application rollback retains the additive columns and entered data; it must not drop the schema to roll back UI code.

The direct NJ migration hold still applies. Automatic approval review rejected the initial isolated `prisma migrate deploy` attempt: the BTF record saying GO is not direct user approval. No migration ran. The guarded isolated runner is prepared outside the source tree in `work/sho-3139-evidence/apply-isolated-migration.sh`; it pins the SQL hash, loopback database `sho_test_3139` and exactly one pending migration, then verifies that legacy row contents are unchanged and the new fields are null. Do not apply it or trigger migration-running CI until direct approval. Staging and production migration are separate pending gates.

## Acceptance case plan and current evidence

| Criterion | Required evidence | Current state |
| --- | --- | --- |
| AC1 | Actual create/edit form labels and submission; desktop/phone keyboard/browser smoke | Eight validation/component/client-payload tests passed; real browser acceptance pending the isolated migration. |
| AC2 | Create, update, reload, null clearing, zero/cents and rejection without mutation; Undo and stale conflicts | Boundary and client-payload tests passed. Actual persistence/Undo/conflict tests pending. |
| AC3 | Board/list/detail disclosures; Member/Viewer/outsider plus CRM all/admins/off privacy | Source retains the existing access checks. Real API/browser matrix pending. |
| AC4 | Existing-row fingerprint unchanged and all new values null after migration; old payloads still work | Private clone is prepared; only this migration is pending. Application of migration is held. |
| AC5 | Focused/full release and phone CI, suite route manifest and signed-out smoke | Scoped lint, typecheck and production compilation passed. Full CI and live acceptance are pending; not a completion claim. |

The story's Bug Off case-publication line is superseded by NJ's standing BTF-only tracking rule. This plan and executed evidence are published in BTF before In Review. No Concierge, HS or unrelated schema work is included.

The six cases in `tests/deal-bd-server.mode.test.ts` are prepared and typechecked but have not run: API round-trip/null/zero compatibility; invalid-input refusal without mutation; Undo/conflict protection; the role/CRM matrix; and desktop/390px create-edit-reload/disclosure flows. Their fixture setup and cleanup use the application APIs. The file joins the existing mode-test glob only after migration approval permits pushing and running CI. Prepared tests are not passing acceptance evidence.
