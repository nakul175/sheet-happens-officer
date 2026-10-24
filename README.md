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

`npm run dev` sets `RETURN_PATH_LOG=1` and prints to the terminal. The integration tiers in
[Test](#test) read the server's *own* output and the files it writes (its log, and the email
outbox), so a server started this way gives those cases nothing to read. Start it with its output
in a file — or point `SERVER_LOG` at wherever its output goes — before running the tiers:

```bash
SUPER_ADMIN_EMAILS=you@aplyd.com npm run dev > server.log 2>&1
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

## Test

Integration tests run against a live server that shares the outbox folder. The vitest
process needs `DATABASE_URL` and `JOB_SECRET` as well: several tests open the database
and call the job endpoint directly. Each value in the commands is a placeholder.

| Name | Purpose |
|---|---|
| `TASKBOARD_URL` | Base URL of the server the tests call, e.g. `http://localhost:3100` |
| `DATABASE_URL` | Postgres connection string the test process uses, the same database as the server |
| `JOB_SECRET` | Bearer token the test process sends when it calls the job endpoint, the same value as the server |
| `EMAIL_OUTBOX_DIR` | Folder the app writes emails to; the tests read the files back from it |
| `SUPER_ADMIN_EMAILS` | Comma-separated addresses the test sign-ins expect to be super admins |

```bash
EMAIL_OUTBOX_DIR=/tmp/sho-outbox SUPER_ADMIN_EMAILS=root.test@aplyd.com APP_URL=http://localhost:3100 \
  RETURN_PATH_LOG=1 \
  DATABASE_URL="postgresql://USER:PASSWORD@localhost:5432/taskboard?schema=public" \
  JOB_SECRET=replace-with-a-token-of-at-least-16-chars \
  npx next dev -p 3100 > server.log 2>&1 &
EMAIL_OUTBOX_DIR=/tmp/sho-outbox SUPER_ADMIN_EMAILS=root.test@aplyd.com TASKBOARD_URL=http://localhost:3100 \
  DATABASE_URL="postgresql://USER:PASSWORD@localhost:5432/taskboard?schema=public" \
  JOB_SECRET=replace-with-a-token-of-at-least-16-chars \
  npm test
```

Three conditions are not on that line, because they belong to the server or the machine:

- `SERVER_LOG` — the path to the running server's log file, for example `server.log`. A few tests
  read the server's own log, not the test output, so point this at wherever the dev server writes.
  It is deliberately **not** a row in the table above: that table is the `npm test` line's variables,
  and a test asserts the two agree. `SERVER_LOG` belongs to the process that *runs the server*.
  Unset, the tests read `server.log` in the repository root, which is where the server line above
  writes.
- `PW_CHROMIUM` — the path to a Chrome or Chromium binary, used by the browser tests. In CI run
  `npx playwright-core install --with-deps chromium` first instead.
- `RETURN_PATH_LOG=1` — set this on the **server** process, not the test process. The server line
  above sets it and writes `server.log`, so the probe has somewhere to write. `npm run dev` sets it
  too, but prints to the terminal: redirect it (`npm run dev > server.log 2>&1`) or point
  `SERVER_LOG` at wherever its output goes, or the tests have nothing to read. `src/proxy.ts` only
  writes its `[return-path]` lines when the server has it, and `tests/return-to.test.ts` reads those
  lines back, counting only what the running server appended while that test ran: a `server.log` left
  behind by an earlier run does not let a server that logs nothing pass. In `ci.yml` and `deploy.yml` the
  server under test is started with `next start`, and the check still passes there: the proxy's own lines
  are what the test reads, not the request lines `next dev` adds. Both workflows run `npm test`, so both
  set the variable on that line; `tests/test-env-contract.test.ts` scans every workflow that runs the
  tier and fails when one does not.

### What the tests read from the server, not from the test process

Some cases read a file the **server** writes, or the server's own stdout. Nothing on the `npm test`
line can supply those: the server has to have been *started* to write the file. A run against a
server that was not fails at those cases and nowhere else, after the rest of the tier has already
run, which makes it look like a product defect.

- `tests/return-to.test.ts:755-817` (APL-2652 D9 AC2) reads the server's own log,
  `process.env.SERVER_LOG ?? "server.log"`, and needs a `[return-path] …` line in it. `src/proxy.ts:35`
  writes that line only when the **server** process has `RETURN_PATH_LOG=1`. The exact server line:

  ```bash
  EMAIL_OUTBOX_DIR=/tmp/sho-outbox SUPER_ADMIN_EMAILS=root.test@aplyd.com APP_URL=http://localhost:3100 \
    RETURN_PATH_LOG=1 \
    DATABASE_URL="postgresql://USER:PASSWORD@localhost:5432/taskboard?schema=public" \
    JOB_SECRET=replace-with-a-token-of-at-least-16-chars \
    npx next dev -p 3100 > server.log 2>&1 &
  ```

  Then run the suite with `SERVER_LOG=server.log` (or omit it: unset means `./server.log`). Without
  the file the case stops at `tests/return-to.test.ts:803` with *server log at server.log (set
  SERVER_LOG to the running server's log): expected false to be true*; with a file the server wrote
  no `[return-path]` line to, it stops at `:817` with *the server under test appended no
  [return-path] line for q=a%09b to <file> while this test ran. Start it with RETURN_PATH_LOG=1 and
  send its output to <file> (SERVER_LOG); a log left by an earlier run does not count.* Both are
  runner preconditions, not product failures. `tests/test-env-contract.test.ts` re-checks the
  presence half in milliseconds when `SERVER_LOG` is set, so it fails before the database tier.
- The mail outbox is the same shape: `src/lib/email.ts` writes the file from the **server** process
  and the spec reads it back from `EMAIL_OUTBOX_DIR`. Readers: `tests/helpers.ts:44` (through
  `account()`, so most of the database tier), `tests/auth.test.ts:34`, `tests/apl-2742.test.ts:51`,
  `tests/comments-19-1.test.ts:29`, `tests/forced-password-23-5.test.ts:13`,
  `tests/forced-password-23-5-browser.test.ts:29`, `tests/people.test.ts:12`,
  `tests/person-no-access.test.tsx:156`. A folder the server does not write fails as *no Verify mail
  for <address> in EMAIL_OUTBOX_DIR=<dir> after 10000ms: the test process and the server must read and
  write the same folder* (`tests/helpers.ts:77`), or with the throw that names the variable when it is
  unset (`tests/e2e/outbox.ts:22`).
- `tests/apl-2713-crm-modes.test.ts:124` and `tests/crm-visible-modes-server.test.ts:153` read a
  `server.log` too, but each spawns its own server and redirects it into its own temporary outbox, so
  they need nothing from the runner.

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
