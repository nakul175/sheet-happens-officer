| ID | symptom | carrier (file ← intro, assertion) | measured — result, report, verbatim line | staging | LABEL |
|---|---|---|---|---|---|
| 9301 | a fixture row that binds a sha to a file it does not touch | `tests/no-proc-environ-2917.test.ts` ← `7572df1` | **AT-HEAD-PASS**: `Tests  1 passed (1)` | LOCAL-ONLY | **FIXED** |
| 9302 | a fixture row whose carrier is true and whose em dash must not bind | `tests/apl-2736.test.ts` ← `6d4ee55` (intro) — `7572df1` is not a carrier of this file | **DECISION NEEDED** — no run | NOT-STAGED | **DECISION NEEDED** |

### 4b. Staging — 1 + 1 + 0 + 0 = 2

| staging | n | rows |
|---|---|---|
| **NOT-STAGED** | **1** | 9302 |
| **LOCAL-ONLY** | **1** | 9301 |
| **PRE-ISOLATION-STAGED** | **0** | — |
| **ISOLATED-STAGED** | **0** | — |

### 4c. Evidence — 1 + 1 + 0 + 0 = 2

`UNPROVEN=1` (9302), `AT-HEAD=1` (9301), `PARTIAL=0`, `LOCAL-ONLY=0`.
