# Sheet Happens Officer

Internal work manager for the APLYD team: projects with Sections, tasks with subtasks,
assignee, collaborators and an optional approver, Trash with 30-day restore, a notification
bell, a per-project Activity log and an organisation audit log. Backlog and user stories live
in Linear (project "Sheet Happens Officer").

Stack: Next.js 16 (App Router), TypeScript, Prisma 6, PostgreSQL 16, Zod, Vitest.

## Run locally

```bash
cp .env.example .env                       # DATABASE_URL for a local Postgres
npm install                                # also runs prisma generate
npx prisma migrate dev
SUPER_ADMIN_EMAILS=you@aplyd.com npm run dev
```

After any pull that changes the Prisma schema (`prisma/schema.prisma` or migrations), run:

```bash
npx prisma generate
```

Without `RESEND_API_KEY`, emails are written as JSON files to `.outbox/` (or
`EMAIL_OUTBOX_DIR`), so verification and reset links can be opened from there.

Settings (environment variables):

| Name | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string used by the app (may point at PgBouncer) |
| `DIRECT_DATABASE_URL` | Direct Postgres connection string for migrations, bypassing PgBouncer; optional, falls back to `DATABASE_URL` when unset |
| `APP_URL` | Public address used in email links |
| `SUPER_ADMIN_EMAILS` | Comma-separated addresses that become Super Admin at sign-up |
| `RESEND_API_KEY`, `EMAIL_FROM` | Email sending; without a key, mail goes to the outbox folder (never in production) |
| `JOB_SECRET` | Bearer token for `POST /api/jobs/<name>` (at least 16 characters) |
| `TEST_CLOCK` / `TEST_CLOCK_SECRET` | Optional local-only story-spec clock. It is honored only with `TEST_CLOCK=1`, a non-production process, a loopback `DATABASE_URL`, and a valid HMAC request signature. Remote/staging/production servers ignore it. |

## Test

Integration tests run against a live server that shares the outbox folder. The vitest
process needs `DATABASE_URL` and `JOB_SECRET` as well: several tests open the database
and call the job endpoint directly. Each value in the commands is a placeholder.

| Name | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string the test process uses, the same database as the server |
| `JOB_SECRET` | Bearer token the test process sends when it calls the job endpoint, the same value as the server |

```bash
EMAIL_OUTBOX_DIR=/tmp/sho-outbox SUPER_ADMIN_EMAILS=root.test@aplyd.com APP_URL=http://localhost:3100 \
  DATABASE_URL="postgresql://USER:PASSWORD@localhost:5432/taskboard?schema=public" \
  JOB_SECRET=replace-with-a-token-of-at-least-16-chars \
  npx next dev -p 3100 &
EMAIL_OUTBOX_DIR=/tmp/sho-outbox TASKBOARD_URL=http://localhost:3100 \
  DATABASE_URL="postgresql://USER:PASSWORD@localhost:5432/taskboard?schema=public" \
  JOB_SECRET=replace-with-a-token-of-at-least-16-chars \
  npm test
```

## Deploy (story 9.3)

One DigitalOcean droplet (Ubuntu 24.04, BLR1) runs the app behind Caddy; DigitalOcean Managed
Postgres holds the data. Every push to `main` runs `.github/workflows/deploy.yml`: lint, build
and tests against a throwaway Postgres, then an rsync of the source to
`/opt/sho/releases/<sha>` and `deploy/release.sh`, which installs, migrates, builds, switches
the `current` symlink, restarts the service and checks `/api/health`. A failed health check
puts the previous release back and fails the run (GitHub emails the person who pushed).

One-time setup, in order:

1. `ssh-keygen -t ed25519 -f ~/.ssh/sho_deploy -N "" -C sho-deploy` on your machine.
2. Create the Managed Postgres cluster (BLR1, PostgreSQL 16, smallest plan).
3. Create the droplet (BLR1, 2 vCPU / 4 GiB, Ubuntu 24.04) with the `sho_deploy` public key
   and `deploy/cloud-init.yaml` pasted into **User data**. It installs Node 22, Caddy, the
   `deploy` user, the `sho` service, cron for the jobs, the firewall and automatic security
   updates, and generates `JOB_SECRET` locally.
4. In the database's settings, add the droplet as a trusted source; copy the **private
   network** connection string.
5. In GoDaddy, add an A record `app` → the droplet's IP.
6. GitHub repository secrets: `SSH_PRIVATE_KEY` (the private half of `sho_deploy`),
   `DATABASE_URL`, `RESEND_API_KEY` (a Resend key with sending access for
   `sheethappensofficer.com`, the sender's domain until Resend verifies `sheethappensofficer.aplyd.org`). Optional secret: `DIRECT_DATABASE_URL`, the direct (non-PgBouncer)
   connection string for migrations, needed once `DATABASE_URL` points at PgBouncer; unset, migrations
   use `DATABASE_URL`. Optional variables: `DROPLET_HOST` (IP, if DNS is not live yet)
   and `DROPLET_HOST_KEY` (one `ssh-keyscan -t ed25519 <ip>` line, which pins the host key).
7. Run the workflow (push to `main` or "Run workflow"), then sign up with the Super Admin
   address and confirm the verification email lands in the inbox, not junk.
8. Point an external uptime check at `https://sheethappensofficer.aplyd.org/api/health`.

Scheduled jobs (`/etc/cron.d/sho`, IST): `purge-trash` 03:17, `purge-old` 03:37, `purge-chat` 03:47
(chat older than 90 days), `concierge-budget` 03:57 (80 percent notice), `stalled-deals` 07:50 (deals with no
next step or no activity for 30 days), `reminders` 08:00, `check`
08:05. Each run is recorded; a failure or a missed day puts a notice in the Super Admin's
bell, and the last runs are shown on the Audit log page. Rollback by hand is a redeploy of
an earlier commit; migrations are forward-only.

### Concierge settings (SHO-US-9.1, 9.2)

The concierge sends task text to Anthropic only when the owner switches it on. Set in GitHub
(Settings > Secrets and variables > Actions):

| Name | Kind | Meaning |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | secret | The provider key. Never stored in the repo. |
| `MODEL_DATA_APPROVED` | variable | Must be exactly `true` to allow any request to the provider. Empty or anything else = off (default). |
| `MODEL_NAME` | variable, optional | Default `claude-haiku-5-5`. |
| `MONTHLY_CEILING_USD` | variable, optional | Default `100`. |
| `WEEKLY_MESSAGE_CAP` | variable, optional | Default `200` messages per person per week (Monday 00:00 India time). |

Unset values are simply left out of `/etc/sho/app.env`; the deploy still succeeds and the concierge shows "not switched on yet".

### Local-only browser stories

Mark any Playwright story that signs up accounts or verifies email from `EMAIL_OUTBOX_DIR` with the `@local-only` tag on its enclosing `test.describe`. Both staging-e2e runners exclude `@local-only` through `--grep-invert`; use the tag rather than `test.skip`, so staging never executes those local-outbox fixtures. Static and manual cases are also excluded there.

Local QA retains those cases. With the local production build/server, `EMAIL_OUTBOX_DIR`, `SHO_QA_PASS` and the test accounts configured, run `npx playwright test tests/e2e/stories/APL-2609.spec.ts`. CI runs its four cases against throwaway localhost Postgres, the local outbox and CI-only account credentials; an exact-four gate rejects skipped or failed cases. `node scripts/ci/check-local-only-2882.mjs` checks that local collection retains the four cases and full staging selection excludes them without dropping all other coverage. This collection check does not execute tests or contact staging.
