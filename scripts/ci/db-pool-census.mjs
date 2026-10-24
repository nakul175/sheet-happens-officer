#!/usr/bin/env node
// OPERATOR TIER — A SATURATED CONNECTION POOL LOOKS EXACTLY LIKE A HANGING TEST.
//
// The incident behind this file: a complete `npm test` stalled after two files with 370 of 400
// Postgres connections idle — accumulated from killed vitest runs, dev servers and prisma pools.
// Terminating the idle backends made the suite run again immediately. Nothing in the harness
// noticed: vitest had simply stopped producing output, which is what a slow test also looks like.
//
// So this file answers one question, and only one: HOW FULL IS THE SERVER, and is that close to
// the point where the next connection cannot be made? It reports. It never terminates anything on
// its own — killing backends during a run is worse than the pressure, because it fails a test that
// was about to pass. `reapIdle()` is the one destructive function here and it is reachable only
// from the explicit `--reap-idle <minutes>` flag, which is off by default.
//
// What it cannot see: WHICH process is holding the connections. `pg_stat_activity` names a
// datname, a user and an application_name, not a vitest file. A pool exhausted by a live process
// is a bug in that process; this file only tells an operator where to look.
import process from "node:process";
import pg from "pg";

/** WARN at 80% of the ceiling: the point where a run has little headroom left, not where it fails. */
export const WARN_RATIO = 0.8;

/** Exit code of a SATURATED pool. Distinct from worker-liveness' 1 (dead worker) and 2 (usage). */
export const EXIT_SATURATED = 3;

/**
 * The verdict for a census. SATURATED means the server will refuse (or has begun refusing) new
 * connections — `used >= ceiling`, not `>`, because at the ceiling there is no slot left.
 */
export function poolVerdict(used, ceiling) {
  if (!Number.isFinite(used) || !Number.isFinite(ceiling) || ceiling <= 0) return "UNKNOWN";
  if (used >= ceiling) return "SATURATED";
  if (used / ceiling >= WARN_RATIO) return "WARN";
  return "OK";
}

/** The ratio, to one decimal, so 319/400 prints 79.8% and does not read as the 80% it is not. */
export function percentText(used, ceiling) {
  if (!Number.isFinite(used) || !Number.isFinite(ceiling) || ceiling <= 0) return "n/a";
  return `${((used / ceiling) * 100).toFixed(1)}%`;
}

/**
 * node-postgres takes a libpq URL; the app's `?schema=w242` is a Prisma-only param. The value is
 * never printed — this file must be safe to run with a real DATABASE_URL in a terminal log.
 */
export function connectionStringOf(rawUrl) {
  if (!rawUrl) throw new Error("DATABASE_URL is not set (pass --database-url, or set DATABASE_URL)");
  const url = new URL(rawUrl);
  return `postgresql://${url.username}:${url.password}@${url.host}${url.pathname}`;
}

/** `state` counts in pg_stat_activity's own words, biggest first. A NULL state is its own bucket. */
export function stateSummary(byState) {
  return byState.map((row) => `${row.state ?? "(no state)"} ${row.count}`).join(", ") || "no backends";
}

/**
 * One read-only census. The connection this uses is excluded from every count (`pid <> pg_backend_pid()`),
 * and a backend with no datname (autovacuum, a walsender) is not a client and is not counted.
 *
 * Scope: cluster-wide by default, because max_connections is cluster-wide. `--database` narrows the
 * count to one database and, when that database carries a `CONNECTION LIMIT`, uses that limit as the
 * ceiling instead — the question then becomes "can this database take another client", which is what
 * a worker on a shared cluster actually cares about.
 */
export async function readCensus({ connectionString, database = null }) {
  const client = new pg.Client({ connectionString, application_name: "sho-pool-census" });
  await client.connect();
  try {
    const limits = (
      await client.query("select current_setting('max_connections')::int as max_connections")
    ).rows[0];
    const scoped = database ?? (await client.query("select current_database() as db")).rows[0].db;
    const dbRow = (
      await client.query("select datconnlimit from pg_database where datname = $1", [scoped])
    ).rows[0];
    if (database && !dbRow) throw new Error(`no such database: ${database}`);
    const datlimit = dbRow?.datconnlimit ?? -1;
    const byState = (
      await client.query(
        `select state, count(*)::int as count
           from pg_stat_activity
          where pid <> pg_backend_pid()
            and datname is not null
            and ($1::text is null or datname = $1)
          group by state
          order by count desc, state asc`,
        [database],
      )
    ).rows;
    const used = byState.reduce((sum, row) => sum + row.count, 0);
    const limitedByDatabase = database !== null && datlimit > 0;
    const ceiling = limitedByDatabase
      ? Math.min(limits.max_connections, datlimit)
      : limits.max_connections;
    return {
      scope: database ?? "cluster",
      ceiling,
      ceilingSource: limitedByDatabase
        ? `CONNECTION LIMIT ${datlimit} of database ${database}`
        : `max_connections ${limits.max_connections} of the server`,
      maxConnections: limits.max_connections,
      used,
      byState,
      verdict: poolVerdict(used, ceiling),
    };
  } finally {
    await client.end();
  }
}


/** The report lines for a census: what is used, out of what, and the verdict that follows. */
export function censusLines(census) {
  const lines = [
    `POOL: ${census.used}/${census.ceiling} connections in use (${percentText(census.used, census.ceiling)}) ` +
      `scope=${census.scope} — ${stateSummary(census.byState)}`,
    `POOL: ceiling ${census.ceiling} (${census.ceilingSource})`,
  ];
  if (census.verdict === "SATURATED") {
    lines.push(
      "POOL VERDICT: SATURATED — no slot is left, so the next connection waits or is refused. " +
        "A test that fails here is not a failing test; see scripts/ci/worker-liveness-runbook.md",
    );
  } else if (census.verdict === "WARN") {
    lines.push(
      `POOL VERDICT: WARN — ${percentText(census.used, census.ceiling)} used, at or past the ` +
        `${Math.round(WARN_RATIO * 100)}% threshold; a second run on this cluster has no headroom`,
    );
  } else {
    lines.push(`POOL VERDICT: ${census.verdict} — below ${Math.round(WARN_RATIO * 100)}% of the ceiling`);
  }
  return lines;
}

/**
 * THE ONE DESTRUCTIVE PATH — opt-in, and only through `--reap-idle <minutes>`.
 *
 * Terminates connections that are `idle` (not `idle in transaction`: those hold locks and a client
 * is mid-work), older than N minutes by `state_change`, and never this process's own backend. The
 * candidate set and the terminate are one statement, so a backend that became busy between a first
 * look and the kill is not picked — but state is a snapshot, and the operator is still asking to
 * kill whatever was idle at that instant. Scoping with `--database` is what keeps this from
 * reaching another worker's pool on a shared cluster.
 */
export async function reapIdle({ connectionString, minutes, database = null, kill = true }) {
  if (!Number.isFinite(minutes) || minutes < 0) throw new Error("--reap-idle needs minutes >= 0");
  const client = new pg.Client({ connectionString, application_name: "sho-pool-reaper" });
  await client.connect();
  try {
    const { rows } = await client.query(
      `with candidates as (
         select pid from pg_stat_activity
          where state = 'idle'
            and pid <> pg_backend_pid()
            and datname is not null
            and state_change < now() - make_interval(mins => $1::int)
            and ($2::text is null or datname = $2)
       )
       select a.pid,
              a.datname,
              a.usename,
              a.application_name,
              extract(epoch from (now() - a.state_change))::int as idle_seconds,
              ${kill ? "pg_terminate_backend(a.pid)" : "false"} as terminated
         from pg_stat_activity a
         join candidates c using (pid)
        where a.state = 'idle'
        order by a.state_change asc`,
      [Math.floor(minutes), database],
    );
    return {
      minutes,
      scope: database ?? "cluster",
      candidates: rows.length,
      terminated: rows.filter((row) => row.terminated).length,
      rows,
    };
  } finally {
    await client.end();
  }
}

/** What `--reap-idle` prints: every backend it touched, or a plain "nothing was idle that long". */
export function reapLines(report) {
  if (report.candidates === 0) {
    return [`REAP: nothing was idle for ${report.minutes} min in scope=${report.scope}; nothing terminated`];
  }
  const lines = [
    `REAP: terminated ${report.terminated}/${report.candidates} idle backend(s) older than ` +
      `${report.minutes} min in scope=${report.scope}`,
  ];
  for (const row of report.rows) {
    lines.push(
      `REAP:   pid ${row.pid} ${row.datname ?? "-"} user=${row.usename ?? "-"} ` +
        `app=${row.application_name || "(none)"} idle ${(row.idle_seconds / 60).toFixed(1)} min ` +
        `terminated=${row.terminated}`,
    );
  }
  return lines;
}

function usage(message) {
  process.stderr.write(`db-pool-census: ${message}\n`);
  process.stderr.write(
    "usage: node scripts/ci/db-pool-census.mjs [--database-url <url>] [--database <name>] " +
      "[--reap-idle <minutes>] [--dry-run] [--json]\n" +
      "  --database-url  connection URL; defaults to $DATABASE_URL (never printed)\n" +
      "  --database      count (and reap) only this database's connections\n" +
      "  --reap-idle     OPT-IN, off by default: terminate connections idle longer than <minutes>\n" +
      "  --dry-run       with --reap-idle: list what would be terminated, terminate nothing\n" +
      "exit: 0 OK/WARN, 3 SATURATED, 2 usage\n",
  );
  process.exit(2);
}

async function main() {
  const argv = process.argv.slice(2);
  const args = { json: false, kill: true };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--json") args.json = true;
    else if (flag === "--dry-run") args.kill = false;
    else if (["--database-url", "--database", "--reap-idle"].includes(flag)) {
      const value = argv[i + 1];
      if (value === undefined) usage(`${flag} needs a value`);
      args[flag.slice(2)] = value;
      i += 1;
    } else usage(`unknown argument ${flag}`);
  }
  const connectionString = connectionStringOf(args["database-url"] ?? process.env.DATABASE_URL);
  const database = args.database ?? null;
  const out = [];
  if (args["reap-idle"] !== undefined) {
    const report = await reapIdle({
      connectionString,
      minutes: Number(args["reap-idle"]),
      database,
      kill: args.kill,
    });
    out.push(...reapLines(report));
  }
  const census = await readCensus({ connectionString, database });
  out.push(...censusLines(census));
  if (args.json) process.stdout.write(`${JSON.stringify({ lines: out, census }, null, 2)}\n`);
  else process.stdout.write(`${out.join("\n")}\n`);
  process.exit(census.verdict === "SATURATED" ? EXIT_SATURATED : 0);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    process.stderr.write(`db-pool-census: ${error.message}\n`);
    process.exit(1);
  });
}
