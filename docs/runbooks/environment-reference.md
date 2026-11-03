# Environment reference

Never copy live values into chat, test fixtures, evidence or repository files. Runtime precedence follows `runtime-manifest.json` and the service/drop-ins, documented in runtime-configuration.md; later sources can override earlier ones. These are names and policies, not a dump of effective production settings. Production app cuts must not overwrite environment files.

| Names | Classification / requirement | Default or policy |
| --- | --- | --- |
| DATABASE_URL | Required secret; runtime app-role database URL | No safe production default; local example only |
| DIRECT_DATABASE_URL | Privileged secret for approved migration/status tooling | Prisma requires resolution; provide separately; runtime switch must not overwrite it |
| APP_URL | Required deployed origin; local public email links | Code fallback localhost:3000 is development-only |
| SUPER_ADMIN_EMAILS | Required approved bootstrap identity list | Empty by default; comma-separated, lowercased; privileged configuration |
| RESEND_API_KEY / EMAIL_FROM | Mail integration secret / sender | Without provider key, production needs explicitly configured outbox; sender default still old .com domain pending verified sender approval |
| EMAIL_OUTBOX_DIR | Local/isolated test mail directory; sensitive content | .outbox outside production; require explicit path in production; protect/delete test mail |
| JOB_SECRET | Secret for job endpoint; minimum 16 chars | No production fallback; setting it does not authorize enabling schedules |
| SUITE_ACCOUNTS_CLIENT_SECRET / SUITE_BUGOFF_CLIENT_SECRET | Required secrets for enabled Suite4 clients | No default; do not rotate or omit during app cuts |
| APLYD_ACCOUNTS_SSO / APLYD_ACCOUNTS_ISSUER / APLYD_ACCOUNTS_CLIENT_SECRET | Central-login flag, fixed approved issuer, secret | SSO requires exactly true and matching issuer; provision all together; no automatic Accounts restart |
| FF_HOLY_SHEET / HOLY_SHEET_ORIGIN | Optional document integration | Flag exactly 1, origin must be an approved Holy Sheet origin; a link is not permission |
| FF_TASK_COMMENTS / FEATURE_COMMENTS | Optional aliases for comments | Off; accepts true/1/on/yes; first alias takes precedence |
| CRM_VISIBLE | Optional CRM audience | all by default; admins/off supported |
| SIGNIN_RETURN_TO | Optional return-path flag | Off; accepts 1/on |
| SEARCH_STAGE_A_ENABLED | Held search capability | Leave unset/off; true requires separately approved DB extension and qualification |
| NODE_ENV / NEXT_RUNTIME | Framework runtime | production for deployed server; do not spoof NEXT_RUNTIME |
| PORT / SHO_BIND_HOST | Server binding | 3000 / 127.0.0.1; test example3100; do not expose private test listeners |
| RELEASE | Release identity | Written into release.env by approved cut; health must match exact commit |
| SHUTDOWN_DRAIN_MS | Shutdown budget | Validated in shutdown.ts; must fit systemd TimeoutStopSec |
| NEXT_MANUAL_SIG_HANDLE / SHO_SERVER_ENTRY | Internal server-entry markers | Set by server.js; not operator feature switches |
| RETURN_PATH_LOG | Diagnostic test logging | Set only for relevant qualification; logs can contain request paths |
| TEST_CLOCK / TEST_CLOCK_SECRET | Test-only time control / secret | Requires loopback DB, nonproduction process and valid signed request; unset outside tests |
| SHUTDOWN_TEST_SLOW_MS | Shutdown test injection | Never set in production |
| MAIL_SINK / MAIL_SINK_TOKEN | Isolated staging-only mail capture flag / secret | Complete staging configuration required; invalid armed setup refuses sends |
| SHO_DEPLOY_STAGE / SHO_SLOT | Staging containment markers | Used together with exact local slot origin for mail sink; do not spoof in production |
| SHO_HOLY_QA / SHO_HOLY_QA_CLIENT_SECRET / SHO_HOLY_QA_SUBJECTS | Isolated Holy QA identity / secret / explicit allowlist | Exact QA origin and <=4 unique UUID subjects; not general production identities |
| SHO_HOLY_QA_REALM / SHO_HOLY_QA_DATABASE_SCHEMA | Disposable QA realm | Guarded named schema in sho_staging; cannot authorize schema creation |
| TASKBOARD_URL / BASE_URL / SHO_E2E_START_BASE_URL | Test target / forwarded test target | Loopback-only for local tests; several tests mutate fixtures; never point broad suite at live |
| PW_CHROMIUM / PW_CHROME / CI / GITHUB_ACTIONS | Browser/tooling context | Harness-specific; inspect invoking test/config; not app secrets |
| NODE_OPTIONS | Node tooling memory/options | Release script supplies build memory; do not add unreviewed loaders |

The table covers direct application/server accesses and common harness inputs; story-specific ports and fixture flags remain documented in their tests. No Concierge provider keys belong in SHO's getting-started configuration.
