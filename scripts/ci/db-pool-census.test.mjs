// CI tier — THE POOL CENSUS, AND THE THREE VERDICTS THAT FOLLOW FROM IT.
//
// The incident behind this file: a full `npm test` stalled after two files with 370 of 400 Postgres
// connections idle, and nothing in the harness could say why. So the thresholds are asserted here at
// their boundaries (79.8% is OK, 80% is WARN, 100% is SATURATED), and then the whole thing is run
// against a real server — a DISPOSABLE database this file creates, with its own CONNECTION LIMIT and
// its own idle connections, so that the WARN, SATURATED and post-reap OK verdicts are measured rather
// than described. The reap is scoped with --database: it can only ever see the fixture's backends, so
// no other worker's pool on the shared cluster is reachable from this test.
//
// Run with: node --test "scripts/ci/**/*.test.mjs"   (skips the live half when DATABASE_URL is unset)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

import {
  EXIT_SATURATED,
  censusLines,
  connectionStringOf,
  poolVerdict,
  percentText,
  readCensus,
  reapIdle,
} from "./db-pool-census.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CHECKER = join(ROOT, "scripts/ci/worker-liveness.mjs");
const FIXTURE_LIMIT = 5;
const connectionString = process.env.DATABASE_URL
  ? connectionStringOf(process.env.DATABASE_URL)
  : null;

test("the verdict is OK below 80%, WARN at 80% and SATURATED at the ceiling", () => {
  // 400 is the ceiling the incident was measured against.
  assert.equal(poolVerdict(0, 400), "OK");
  assert.equal(poolVerdict(319, 400), "OK", "79.75% is not 80%: rounding must not promote a verdict");
  assert.equal(poolVerdict(320, 400), "WARN", "80% is the WARN the packet asks for");
  assert.equal(poolVerdict(370, 400), "WARN", "the incident's 370 idle connections were WARN, not SATURATED");
  assert.equal(poolVerdict(399, 400), "WARN");
  assert.equal(poolVerdict(400, 400), "SATURATED", "at the ceiling there is no slot left");
  assert.equal(poolVerdict(401, 400), "SATURATED", "SQLSTATE 53300 does not wait for arithmetic to agree");
  assert.equal(poolVerdict(10, 0), "UNKNOWN", "a ceiling of 0 is not a full server, it is a broken reading");
  assert.equal(poolVerdict(Number.NaN, 400), "UNKNOWN");
});

test("the printed ratio and verdict say the same thing, and 79.8% is not printed as 80%", () => {
  const lines = censusLines({
    used: 319,
    ceiling: 400,
    scope: "cluster",
    ceilingSource: "max_connections 400 of the server",
    byState: [{ state: "idle", count: 318 }, { state: "active", count: 1 }],
    verdict: "OK",
  });
  assert.match(lines[0], /^POOL: 319\/400 connections in use \(79\.8%\) scope=cluster/);
  assert.match(lines[0], /idle 318, active 1/);
  assert.match(lines[2], /^POOL VERDICT: OK/);
  assert.equal(percentText(320, 400), "80.0%");

  const warn = censusLines({
    used: 370, ceiling: 400, scope: "cluster", ceilingSource: "x",
    byState: [{ state: "idle", count: 370 }], verdict: "WARN",
  });
  assert.match(warn[2], /^POOL VERDICT: WARN — 92\.5% used, at or past the 80% threshold/);

  const saturated = censusLines({
    used: 400, ceiling: 400, scope: "cluster", ceilingSource: "x",
    byState: [{ state: "idle", count: 400 }], verdict: "SATURATED",
  });
  assert.match(saturated[2], /^POOL VERDICT: SATURATED/);
  assert.match(saturated[2], /A test that fails here is not a failing test/);
});


/** The real server, and a database of this test's own so nothing it kills can belong to anybody else. */
async function withFixtureDatabase(t) {
  if (!connectionString) {
    t.skip("DATABASE_URL is not set: the live half of the pool census needs a server");
    return null;
  }
  const name = `w242_pool_fixture_${process.pid}`;
  const admin = new pg.Client({ connectionString, application_name: "w242-fixture-admin" });
  try {
    await admin.connect();
    await admin.query(`drop database if exists "${name}" with (force)`);
    await admin.query(`create database "${name}" connection limit ${FIXTURE_LIMIT}`);
  } catch (error) {
    await admin.end().catch(() => {});
    t.skip(`no server to create ${name} on: ${error.message}`);
    return null;
  }
  const url = new URL(connectionString);
  url.pathname = `/${name}`;
  return {
    name,
    url: url.toString(),
    async drop() {
      await admin.query(`drop database if exists "${name}" with (force)`).catch(() => {});
      await admin.end().catch(() => {});
    },
  };
}

/** Idle connections this test owns and holds: the fabricated pressure. */
async function hold(fixtureUrl, count, from = 0) {
  const clients = [];
  for (let i = from; i < from + count; i += 1) {
    const client = new pg.Client({ connectionString: fixtureUrl, application_name: `w242-holder-${i}` });
    // A reaped backend surfaces as an error event on its client, not as a rejected query: this test reaps its own.
    client.on("error", () => {});
    await client.connect();
    await client.query("select 1");
    clients.push(client);
  }
  return clients;
}

async function release(clients) {
  for (const client of clients) await client.end().catch(() => {});
}

function runChecker(args, env = {}) {
  return spawnSync(process.execPath, [CHECKER, ...args], {
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: "", ...env },
  });
}

/** A pool of one FINISHED packet: the packet verdicts must not be what makes these assertions pass. */
function finishedPacketPool() {
  const dir = mkdtempSync(join(tmpdir(), "w242-pool-census-"));
  const state = join(dir, "state");
  const reports = join(dir, "reports");
  for (const each of [state, reports]) mkdirSync(each);
  const tsv = join(dir, "packets.tsv");
  writeFileSync(tsv, "w940\tpool/w940\t3900\tw940\tOPS\n");
  writeFileSync(join(state, "w940.pid"), "1\n");
  writeFileSync(join(reports, "W940-REPORT.md"), "# w940\n\nSTATUS: DONE - abc1234\n");
  return { dir, args: ["--tsv", tsv, "--state", state, "--reports", reports] };
}

test("a real saturated server reads SATURATED and exits 3, WARN at 80%, and --reap-idle brings it back to OK", async (t) => {
  const fixture = await withFixtureDatabase(t);
  if (!fixture) return;
  const pool = finishedPacketPool();
  // The checker connects on the MAIN database and scopes the count to the fixture: a census that had to
  // open a connection in the saturated database would be refused exactly when it is needed most.
  const scoped = [...pool.args, "--database-url", connectionString, "--database", fixture.name];
  let holders = [];
  try {
    const census = await readCensus({ connectionString, database: fixture.name });
    assert.equal(census.ceiling, FIXTURE_LIMIT, "a scoped database is measured against its own CONNECTION LIMIT");
    assert.equal(census.used, 0);
    assert.equal(census.verdict, "OK");

    holders = await hold(fixture.url, 4);
    const warn = runChecker(scoped);
    assert.match(warn.stdout, /POOL: 4\/5 connections in use \(80\.0%\)/);
    assert.match(warn.stdout, /POOL VERDICT: WARN/);
    assert.match(warn.stdout, /RESULT: OK/, "WARN is not a failure: it is headroom running out");
    assert.equal(warn.status, 0);

    holders.push(...(await hold(fixture.url, 1, 4)));
    const saturated = runChecker(scoped);
    assert.match(saturated.stdout, /POOL: 5\/5 connections in use \(100\.0%\)/);
    assert.match(saturated.stdout, /POOL VERDICT: SATURATED/);
    assert.match(saturated.stdout, /RESULT: FAIL \(pool SATURATED\)/);
    assert.equal(saturated.status, EXIT_SATURATED, "a saturated pool must be impossible to ignore");
    assert.notEqual(saturated.status, 1, "it must not look like a dead worker");
    assert.notEqual(saturated.status, 2, "nor like bad usage");

    // Nothing happens without the flag: the plain run above must have left all five backends alive.
    const still = await readCensus({ connectionString, database: fixture.name });
    assert.equal(still.used, 5, "reporting must not terminate anything");

    const reaped = runChecker([...scoped, "--reap-idle", "0"]);
    assert.match(reaped.stdout, /REAP: terminated 5\/5 idle backend\(s\) older than 0 min/);
    assert.match(reaped.stdout, /app=w242-holder-0/);
    assert.match(reaped.stdout, /POOL: 0\/5 connections in use/);
    assert.match(reaped.stdout, /POOL VERDICT: OK/);
    assert.equal(reaped.status, 0, "after the reap the verdict returns to OK");

    const dry = await reapIdle({ connectionString, minutes: 0, database: fixture.name, kill: false });
    assert.equal(dry.terminated, 0, "--dry-run terminates nothing");
  } finally {
    await release(holders);
    rmSync(pool.dir, { recursive: true, force: true });
    await fixture.drop();
  }
});
