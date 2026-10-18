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

## Test

Integration tests run against a live server that shares the outbox folder:

```bash
EMAIL_OUTBOX_DIR=/tmp/sho-outbox SUPER_ADMIN_EMAILS=root.test@aplyd.com APP_URL=http://localhost:3100 \
  JOB_SECRET=0123456789abcdef0123 npx next dev -p 3100 &
EMAIL_OUTBOX_DIR=/tmp/sho-outbox TASKBOARD_URL=http://localhost:3100 npm test
```

## Deploy (story 9.3, process v3 P1 and P2)

One DigitalOcean droplet (Ubuntu 24.04, BLR1) runs the app behind Caddy; DigitalOcean Managed
Postgres holds the data. A push to `main` runs `.github/workflows/deploy.yml`, which tests the
commit and deploys it to **staging only** (`/opt/sho-staging`, `sho-staging` on port 3001).
It does not write `/etc/sho/app.env` or restart production.

Production deploys from a `rel-*` tag (`.github/workflows/release.yml`) through the GitHub
environment `production`. That environment is created in repository settings, with required
reviewer `nakul175` and prevent self-review. CI builds one release tarball and its SHA-256
per commit; staging and production both install that file. `deploy/release.sh` does not build
on the droplet. It migrates, switches the `current` symlink, restarts, and checks `/api/health`
and `/api/version`. A failed health check puts the previous code back. Migrations are
forward-only. On production, a pending migration is preceded by `pg_dump` of
`DIRECT_DATABASE_URL`; if the dump fails, the migration does not start.

`/api/version` returns `{ "sha", "digest" }` for the running build. Production `DATABASE_URL`
is the PgBouncer pool (port 25061, `pgbouncer=true`). `DIRECT_DATABASE_URL` is the direct
database, used for migrations and the backup.

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
   `STAGING_DATABASE_URL` (the staging database, not the production pool), `RESEND_API_KEY`
   (a Resend key with sending access for `sheethappensofficer.com`). Optional staging secret:
   `STAGING_DIRECT_DATABASE_URL`. Production secrets live on the `production` environment, not
   in the repository: `DATABASE_URL` (PgBouncer, port 25061, `pgbouncer=true`) and
   `DIRECT_DATABASE_URL` (direct database, required for migrations and the backup), plus
   `RESEND_API_KEY` if it should differ from the repository secret. Optional variables:
   `DROPLET_HOST` (IP, if DNS is not live yet) and `DROPLET_HOST_KEY` (one
   `ssh-keyscan -t ed25519 <ip>` line, which pins the host key).
7. Run the staging workflow (push to `main` or "Run workflow"). Production ships only when a
   `rel-*` tag is pushed and the production environment reviewer approves. Then sign up with
   the Super Admin address and confirm the verification email lands in the inbox, not junk.
8. Point an external uptime check at `https://app.sheethappensofficer.com/api/health`.

Scheduled jobs (`/etc/cron.d/sho`, IST): `purge-trash` 03:17, `purge-old` 03:37, `purge-chat` 03:47
(chat older than 90 days), `concierge-budget` 03:57 (80 percent notice), `stalled-deals` 07:50 (deals with no
next step or no activity for 30 days), `reminders` 08:00, `check`
08:05. Each run is recorded; a failure or a missed day puts a notice in the Super Admin's
bell, and the last runs are shown on the Audit log page. Rollback by hand is a redeploy of
an earlier `rel-*` tag; migrations are forward-only. The droplet needs `postgresql-client`
(`pg_dump`) before a production migration, and the deploy user needs passwordless sudo to
restart `sho-staging` the same way it can restart `sho`.

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

Unset values are simply left out of the environment's `app.env`; the deploy still succeeds and the concierge shows "not switched on yet". Staging writes `/etc/sho-staging/app.env`. Production writes `/etc/sho/app.env`.
