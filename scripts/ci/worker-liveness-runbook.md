
# Worker liveness and DATABASE POOL pressure — operator runbook

The checker is `scripts/ci/worker-liveness.mjs`; the pool half is `scripts/ci/db-pool-census.mjs`.
This page is the part an operator needs: what the two verdict families mean, the one destructive
flag and when it is allowed, and what the checker cannot tell you.

```bash
# Packets only (unchanged): RUNNING / FINISHED / DEAD-WITHOUT-REPORT.
node scripts/ci/worker-liveness.mjs --tsv packets.tsv --state state --reports <execution dir>

# Packets and the connection pool. The URL is never printed.
DATABASE_URL='postgresql://…?schema=w242' node scripts/ci/worker-liveness.mjs \
  --tsv packets.tsv --state state --reports <execution dir>

# A worker's own scope on a shared cluster: count only that database, and measure it against its
# CONNECTION LIMIT when it has one. This is the safe way to look without reading other workers' load.
DATABASE_URL='…' node scripts/ci/worker-liveness.mjs … --database w242
```

## The three pool verdicts, and their exit codes

| verdict | condition | exit |
|---|---|---|
| `OK` | used < 80% of the ceiling | 0 (with the packet verdicts) |
| `WARN` | used >= 80% | 0 — headroom is running out, nothing has failed yet |
| `SATURATED` | used >= ceiling | **3** — always non-zero, even when every packet is healthy |

Exit 3 is deliberately distinct from 1 (`DEAD-WITHOUT-REPORT`) and 2 (usage). A saturated pool is
not a worker problem, and it must not be possible to pass the checker by having no dead workers.
Without `--database-url` the checker prints `POOL: skipped — …` and the packet verdicts are exactly
what they were: "I did not look" is printed, never implied.

## `--reap-idle <minutes>` — the only flag that terminates anything

**Opt-in, off by default, and reporting is the default for a reason**: killing a backend during a
run fails a test that was about to pass.

```bash
# See what would go, terminate nothing:
DATABASE_URL='…' node scripts/ci/worker-liveness.mjs … --database w242 --reap-idle 15 --dry-run
# Actually terminate backends idle longer than 15 min, printing each pid:
DATABASE_URL='…' node scripts/ci/worker-liveness.mjs … --database w242 --reap-idle 15
```

It terminates only connections whose `state` is `idle` — never `idle in transaction` (those hold
locks and a client is mid-work), never a backend with no datname (autovacuum, a walsender), never
its own. It prints `REAP:   pid … datname=… app=… idle N min terminated=true` per backend and then
the census it produced, so the verdict an operator reads is the one the reap left behind.

Scope it with `--database` whenever the cluster is shared. On a shared cluster `--reap-idle` without
`--database` reaches every idle backend on the server, including another worker's.

## What this cannot tell you

- **Which process holds the connections.** `pg_stat_activity` carries a datname, a user and an
  `application_name`, not a vitest file. A pool exhausted by a LIVE process is a bug in that
  process; this reports pressure and tells you where to look, nothing more.
- **Whether the stall you are watching is the pool.** A full server and a slow test look identical
  from outside: no output. That is why the census is printed rather than an error being awaited.
- **A stall that is not pool pressure.** A queued waiter inside one pool (every slot held by an
  in-flight query, `pg`'s default having no connect timeout) stalls with plenty of server capacity
  left; the census will say `OK` while the test times out. Both readings are true.
- **Refusal by the server for a superuser role.** On the local harness cluster the app role is a
  superuser, and Postgres does not enforce `CONNECTION LIMIT` (or `superuser_reserved_connections`)
  against superusers: measured at 4/4 on a fixture database, a fresh connection was accepted in
  13 ms. Do not expect a `53300` to appear before you have looked at the census.
