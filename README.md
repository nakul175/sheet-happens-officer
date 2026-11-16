# Sheet Happens Officer

Internal project/task and CRM application for APLYD. Tracking is **BTF**, project SHO. Concierge is outside this application. The four `/api/suite/*` routes and Holy Sheet links are active integrations and must be preserved.

Stack: Next.js App Router, TypeScript, React, Prisma 6, PostgreSQL 16. Use **Node 22**. Production runs Ubuntu 24.04 / Linux x86-64 with a native shutdown helper and the `server.js` entry point; macOS builds do not qualify that native behavior.

## Start with a disposable local database

Use an empty PostgreSQL 16 database named `sho_test` on loopback with synthetic credentials and `schema=public` in both database URLs. Never use a shared or production URL for these commands. Docker users can start a disposable instance with:

```bash
docker run --name sho-audit-db --rm -d -p 127.0.0.1:5432:5432 \
  -e POSTGRES_USER=sho -e POSTGRES_PASSWORD=sho -e POSTGRES_DB=sho_test postgres:16
cp .env.example .env
set -a
. ./.env
set +a
npm ci
npx prisma migrate deploy
npm run build
NODE_ENV=production node --import tsx server.js
```

The migration command above is for that **disposable local database only**, replaying checked-in history, not generating new migrations. Stop/remove the disposable container with `docker stop sho-audit-db` when finished. Do not run `migrate dev`, `db push`, `migrate reset` or schema repair against a shared database.

Open `http://localhost:3100`, register the synthetic Super Admin address from `.env.example`, and retrieve the verification link from `.outbox-local`. Local mail is captured there; no real provider credentials or AI key are required. For interactive development, `npm run dev -- --port 3100` is available, but release qualification uses the native production entry point above.

## Test

In a second terminal, load the same synthetic `.env` and run against the same server/database/outbox.

| Name | Purpose |
| --- | --- |
| `DATABASE_URL` | Disposable loopback database shared by the server and integration tests |
| `JOB_SECRET` | Synthetic job endpoint credential shared by server and test process |

Run:

```bash
node --test 'scripts/ci/**/*.test.mjs'
npm run lint
npm run typecheck
npx tsc --noEmit -p tsconfig.e2e.json
DATABASE_URL="postgresql://sho:sho@127.0.0.1:5432/sho_test?schema=public" JOB_SECRET=local-test-only-not-a-real-secret-0123 npm test
npm run test:modes
npm run test:viewport
```

Install the required browser with `npx playwright-core install chromium` if it is unavailable. Mode tests start their own isolated local servers; the default suite and phone checks require the server above and share its test DB/outbox. Tests create synthetic data; use a fresh disposable database for a clean rerun. See `.github/workflows/qualification.yml` and `phone-checks.yml` for the exact Linux gates and local Playwright story list. Collection, mocked checks and integration tests are different evidence; record pass/fail/skip counts separately.

## Maintainer map

- [Data contract and model reference](docs/data/CONTRACT.md): ownership, custom SQL, deletion, retention and retained legacy objects.
- [Domain boundaries](docs/runbooks/domain-boundaries.md): permissions, state changes, transactions and Undo.
- [Environment reference](docs/runbooks/environment-reference.md): required, optional, integration and test settings.
- [Runtime configuration](docs/runbooks/runtime-configuration.md): service manifest, environment precedence and native runtime.
- [Application release](docs/runbooks/app-release.md): app-only release, identity verification and rollback.
- [Schema releases](docs/runbooks/schema-releases.md): separate app/schema identities; existing nullable expansion.
- [Regression qualification](docs/runbooks/regression-qualification.md), [backup recovery](docs/runbooks/backup-recovery.md) and [dependency provenance](docs/runbooks/dependency-provenance.md).
- [Handover exercise](docs/runbooks/handover-exercise.md): independent onboarding acceptance, still required.

## Operations are paused

This branch is audit remediation, not deployment authorization. Main pushes test only. A production request requires explicit approved full SHA, successful shared qualification and phone checks, reviewed environment protection, and the separately approved cut. App cuts preserve existing configuration and never install schedules or apply migrations. Do not merge or deploy this branch until the owner approves.

No new features, production changes, schema DROP, credential rotation or scheduled work are part of this remediation. The owning engineer handles code, QA and deployment; product owner approves scope and production acceptance. Obsolete chat-role names are not operational dependencies. An incident owner must be explicitly named when an incident begins.
