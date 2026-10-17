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
| `DATABASE_URL` | Postgres connection string |
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
   `sheethappensofficer.com`). Optional variables: `DROPLET_HOST` (IP, if DNS is not live yet)
   and `DROPLET_HOST_KEY` (one `ssh-keyscan -t ed25519 <ip>` line, which pins the host key).
7. Run the workflow (push to `main` or "Run workflow"), then sign up with the Super Admin
   address and confirm the verification email lands in the inbox, not junk.
8. Point an external uptime check at `https://app.sheethappensofficer.com/api/health`.

Scheduled jobs (`/etc/cron.d/sho`, IST): `purge-trash` 03:17, `purge-old` 03:37, `check`
08:05. Each run is recorded; a failure or a missed day puts a notice in the Super Admin's
bell, and the last runs are shown on the Audit log page. Rollback by hand is a redeploy of
an earlier commit; migrations are forward-only.
