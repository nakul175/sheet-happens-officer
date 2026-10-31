# SHO-2638 — Isolated CRM visibility acceptance

Tested runtime: `7aeaf74cad3e060f95d729dc169ef7792ba3d9a8`, build `2rBn60wBoKiUQoSlZ_m4w`. Original fix `595224b` is in its ancestry. This is a staging-only C0 verification; application source is unchanged.

Three separate loopback `next start` processes use `CRM_VISIBLE=off`, `admins` and `all` against a fresh synthetic `sho_test_2638` clone. Each health response reports the tested SHA. No shared slot9 environment, systemd service, production flag, credential or migration was changed. The runtime was freshly built before the run.

## Results

| Mode | Role | Deal task/stage/search visible | Task / task-list status | Ordinary task retained |
|---|---|---|---|---|
| off | Editor | No | 404 / 404 | Yes |
| off | Admin | No | 404 / 404 | Yes |
| off | Super | No | 404 / 404 | Yes |
| admins | Editor | No | 404 / 404 | Yes |
| admins | Admin | Yes | 200 / 200 | Yes |
| admins | Super | Yes | 200 / 200 | Yes |
| all | Editor | Yes | 200 / 200 | Yes |
| all | Admin | Yes | 200 / 200 | Yes |
| all | Super | Yes | 200 / 200 | Yes |

All nine API role/mode rows pass. Actual org roles are checked through `/api/auth/me`. Hidden direct-route responses contain no private deal/task names. Search assertions check returned record IDs and result links; the user-entered query echo is not treated as returned private data.

Eight real Chromium browser rows pass: Editor at 1280px and 390px in all three modes, plus Admin/Super Admin at 1280px in admins mode. Each captures My tasks, deal search, task search and direct task URL. These are desktop/emulated-phone results, not physical-phone evidence. Representative states were visually inspected.

| Mode | Role | Width | My tasks | Deal search | Task search | Direct task |
|---|---|---:|---|---|---|---|
| off | Editor | 1280 | [View](screenshots/off-editor-1280-my-tasks.png) | [View](screenshots/off-editor-1280-search-deal.png) | [View](screenshots/off-editor-1280-search-task.png) | [View](screenshots/off-editor-1280-direct-task.png) |
| off | Editor | 390 | [View](screenshots/off-editor-390-my-tasks.png) | [View](screenshots/off-editor-390-search-deal.png) | [View](screenshots/off-editor-390-search-task.png) | [View](screenshots/off-editor-390-direct-task.png) |
| admins | Editor | 1280 | [View](screenshots/admins-editor-1280-my-tasks.png) | [View](screenshots/admins-editor-1280-search-deal.png) | [View](screenshots/admins-editor-1280-search-task.png) | [View](screenshots/admins-editor-1280-direct-task.png) |
| admins | Editor | 390 | [View](screenshots/admins-editor-390-my-tasks.png) | [View](screenshots/admins-editor-390-search-deal.png) | [View](screenshots/admins-editor-390-search-task.png) | [View](screenshots/admins-editor-390-direct-task.png) |
| admins | Admin | 1280 | [View](screenshots/admins-admin-1280-my-tasks.png) | [View](screenshots/admins-admin-1280-search-deal.png) | [View](screenshots/admins-admin-1280-search-task.png) | [View](screenshots/admins-admin-1280-direct-task.png) |
| admins | Super | 1280 | [View](screenshots/admins-super-1280-my-tasks.png) | [View](screenshots/admins-super-1280-search-deal.png) | [View](screenshots/admins-super-1280-search-task.png) | [View](screenshots/admins-super-1280-direct-task.png) |
| all | Editor | 1280 | [View](screenshots/all-editor-1280-my-tasks.png) | [View](screenshots/all-editor-1280-search-deal.png) | [View](screenshots/all-editor-1280-search-task.png) | [View](screenshots/all-editor-1280-direct-task.png) |
| all | Editor | 390 | [View](screenshots/all-editor-390-my-tasks.png) | [View](screenshots/all-editor-390-search-deal.png) | [View](screenshots/all-editor-390-search-task.png) | [View](screenshots/all-editor-390-direct-task.png) |

## Cleanup and evidence

The final run completed in 22.7 seconds. Synthetic projects/organisation were archived, Leader/Editor/Admin fixture accounts deactivated and the synthetic Super Admin signed out; all three temporary processes stopped. The receipt records UTC/IST times and health/source fingerprints. Raw local outboxes and browser traces stay private; only screenshots and sanitized receipts are published.

Two earlier attempts remain in local evidence: the first passed all role checks but the runner incorrectly expected sign-out `200` instead of the correct `204`; that expectation was fixed. The second spanned a 13h 22m environment interruption and timed out waiting for Search, whose captured page was visible. The unchanged assertions passed in the uninterrupted instrumented rerun. No privacy assertion failed and no retry/timeout waiver was added.

Concierge AC4 is retired by NJ’s removal instruction; no provider was configured or called. Existing exact-runtime CI also passes the seven `APL-2609.mode.test.ts` cases. This verification does not claim shared slot9 restoration.

Read-only production verification confirms live SHA `7aeaf74c`, matching CRM implementation hashes, the same production PID and unchanged protected runtime fingerprints. No production restart or mode toggle is needed for an already-live implementation/C0 evidence story. Exact qualification-PR gates are recorded in BTF.

The evidence runner requires a clean runtime tree, a built app, an explicitly expected SHA and a loopback synthetic `sho_test_*` database. Supply a synthetic fixture password through `SHO_QA_PASS`; no password or cookie is in these receipts. It refuses environment files and never loads production configuration.
