// APL-2749. Overlapping reminder job runs (a cron retry, or a manual POST during the scheduled run)
// must not write the same due-date reminder twice. Everything goes through the shared test server:
// people, project and tasks are made through the API, the job is POSTed with JOB_SECRET, and the
// reminders are read back on GET /api/notifications. Names are ZZ-TEST, addresses nakul17+ aliases.
// 40 concurrent POSTs alone did not overlap on a local `next start` (each run takes a few ms), so the AC1
// test adds one hook, inside the test only: a separate connection holds a SHARE lock on "Notification"
// (no rows written) while the runs start. Reads go through; each run's insert waits on the lock. The lock
// is released as soon as a second connection sees in pg_stat_activity two runs waiting past their read: two inserts waiting (the bug),
// or one insert plus one run waiting on the reminders advisory lock (the fix).
// The CRM_VISIBLE filter (AC3) is covered unchanged by tests/jobs-reminders-crm.test.ts and
// tests/jobs-reminders-crm-server.test.ts (`npm run test:reminder-modes`).
//
// qa:TC missing single run
// qa:TC missing 40 concurrent reminder requests
// qa:TC missing SHO-3011 a public sentinel stays invisible to the race's own connections
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BASE, istDate, task, type Account } from "./helpers";
import { zzTestData, type ZzProject } from "./zz-test-data";

const LOAD = 40;
/** Longest the test holds the lock: well under Prisma's default 2 s maxWait / 5 s timeout, which the fix keeps. */
const MAX_HOLD_MS = 500;
const tag = `${Date.now().toString(36)}-${process.pid}`;
const zz = zzTestData("2749");

type BellItem = { text: string; href: string | null };

let leader: Account;
let holder: Account;
let proj: ZzProject;

/** The schema DATABASE_URL names: where Prisma, and so the route under test, writes. */
function testSchema(): string | undefined {
  return new URL(process.env.DATABASE_URL ?? "postgresql://localhost").searchParams.get("schema");
}

/** The local test database, without Prisma's ?schema= parameter (pg would post it as an unknown startup setting). */
function localDatabaseUrl() {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is required and must point at the local test database");
  const url = new URL(raw);
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") {
    throw new Error("Refusing to run: the reminder race test uses the local test database only");
  }
  url.search = "";
  return url.toString();
}

/**
 * SHO-3011: both raw connections of the race, on the schema the app writes. Stripping ?schema= used to leave pg on the
 * server default (public), so `LOCK TABLE "Notification"` below locked a table the app never touches, the runs never
 * waited on it, and the race proved nothing - while every assertion that did not look at the schema still passed.
 * The schema is carried the only way pg can carry it, a start-up option, quoted so a mixed-case name keeps its case;
 * with no ?schema= in the URL nothing is added and the client is exactly the one it was before. The guard at the end
 * of this file asserts what this client really connects as, so a rewrite that loses the schema fails aloud.
 */
function raceClient() {
  const schema = testSchema();
  return new pg.Client({
    connectionString: localDatabaseUrl(),
    statement_timeout: 5_000,
    lock_timeout: 2_000,
    ...(schema ? { options: `-c search_path="${schema}"` } : {}),
  });
}

/** Waits until two runs are past their read: two inserts on the lock, or one insert and one advisory-lock wait. */
async function waitForOverlap(watch: pg.Client, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await watch.query<{ inserts: number; advisory: number }>(
      `SELECT count(*) FILTER (WHERE query ILIKE 'INSERT INTO %"Notification"%')::int AS inserts,
              count(*) FILTER (WHERE wait_event = 'advisory')::int AS advisory
       FROM pg_stat_activity
       WHERE datname = current_database() AND pid <> pg_backend_pid() AND state = 'active' AND wait_event_type = 'Lock'`,
    );
    const { inserts, advisory } = rows[0];
    if (inserts >= 2 || (inserts >= 1 && advisory >= 1)) return { inserts, advisory };
    await new Promise((r) => setTimeout(r, 5));
  }
  return null;
}

async function postReminders(count: number) {
  const secret = process.env.JOB_SECRET ?? "";
  expect(secret.length, "JOB_SECRET (the shared test server's job token) is required").toBeGreaterThanOrEqual(16);
  const responses = await Promise.all(Array.from({ length: count }, () => fetch(`${BASE}/api/jobs/reminders`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}` },
  })));
  for (const res of responses) {
    const text = await res.text();
    expect(res.status, text.replaceAll(secret, "[redacted]").slice(0, 180)).toBe(200);
    expect((JSON.parse(text) as { status?: string }).status).toBe("OK");
  }
}

/** Bell items that are the due-tomorrow reminder for this task. */
async function dueTomorrow(who: Account, taskId: string, title: string) {
  const r = await who.c.get("/api/notifications?limit=200");
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return (r.json.items as BellItem[]).filter((item) => item.href === `/tasks/${taskId}` && item.text === `"${title}" is due tomorrow.`);
}

/** One task due tomorrow for each holder, so each run starts with no reminder written for them. */
async function dueTasks(label: string) {
  const holderTitle = `ZZ-TEST ${label} ${tag}`;
  const leaderTitle = `ZZ-TEST ${label} ${tag} leader`;
  const holderTaskId = await task(leader, proj.id, { title: holderTitle, assigneeId: holder.id, dueDate: istDate(1) });
  const leaderTaskId = await task(leader, proj.id, { title: leaderTitle, assigneeId: leader.id, dueDate: istDate(1) });
  return [
    { who: holder, taskId: holderTaskId, title: holderTitle },
    { who: leader, taskId: leaderTaskId, title: leaderTitle },
  ];
}

describe("qa:TC missing APL-2749: overlapping reminder runs write one reminder per holder, task, type and day", () => {
  beforeAll(async () => {
    leader = await zz.person("Leader");
    holder = await zz.person("Holder");
    proj = await zz.project(leader);
    const added = await leader.c.post(`/api/projects/${proj.id}/members`, { userId: holder.id, role: "EDITOR" });
    expect(added.status, JSON.stringify(added.json)).toBe(201);
  }, 60_000);

  afterAll(async () => {
    const problems = await zz.cleanUp();
    expect(problems, problems.join("\n")).toEqual([]);
  }, 60_000);

  it("qa:TC missing AC2: a single run writes the due-tomorrow reminder for each holder, linked to the task", async () => {
    const due = await dueTasks("single run");
    await postReminders(1);
    for (const d of due) {
      const items = await dueTomorrow(d.who, d.taskId, d.title);
      expect(items.map((item) => item.text)).toEqual([`"${d.title}" is due tomorrow.`]);
    }
  });

  it("qa:TC missing AC1: 40 concurrent POST /api/jobs/reminders leave exactly one reminder per holder and task", async () => {
    const due = await dueTasks("concurrent run");
    // The gate holds the lock; the watcher reads pg_stat_activity outside the gate's transaction snapshot.
    // Both are bounded: no statement runs past 5 s and no lock wait past 2 s, even if the release below never ran.
    const gate = raceClient();
    const watch = raceClient();
    let overlap: { inserts: number; advisory: number } | null = null;
    let posts: Promise<unknown>;
    let heldMs = 0;
    let began = false;
    try {
      await gate.connect();
      await watch.connect();
      for (const client of [gate, watch]) {
        const { rows } = await client.query<{ statement_timeout: string; lock_timeout: string }>(
          "SELECT current_setting('statement_timeout') AS statement_timeout, current_setting('lock_timeout') AS lock_timeout",
        );
        expect(rows[0]).toEqual({ statement_timeout: "5s", lock_timeout: "2s" });
      }
      await gate.query("BEGIN");
      began = true;
      await gate.query('LOCK TABLE "Notification" IN SHARE MODE');
      posts = postReminders(LOAD).then(() => null, (err: unknown) => err);
      const held = Date.now();
      overlap = await waitForOverlap(watch, MAX_HOLD_MS);
      heldMs = Date.now() - held;
    } finally {
      // APL-2894: end both clients even when a connect, the setting assert or the lock fails.
      try {
        if (began) await gate.query("ROLLBACK");
      } finally {
        await Promise.allSettled([gate.end(), watch.end()]);
      }
    }
    const failed = await posts;
    if (failed) throw failed;
    expect(overlap, "two reminder runs were waiting past their read at the same time").not.toBeNull();
    const counts: Record<string, number> = {};
    for (const d of due) counts[d.who === holder ? "holder" : "leader"] = (await dueTomorrow(d.who, d.taskId, d.title)).length;
    console.log(`APL-2749 overlap ${JSON.stringify(overlap)} after ${heldMs} ms held; reminder rows per (recipient, task, TASK_DUE_TOMORROW) after ${LOAD} concurrent runs: ${JSON.stringify(counts)}`);
    expect(counts).toEqual({ holder: 1, leader: 1 });
  }, 90_000);
});

// SHO-3011. The race above is only a race if its two connections see the rows the route writes. A client that lost
// Prisma's ?schema= reads `public` instead - a wrong answer, never an error - so `LOCK TABLE "Notification"` locked a
// table nobody was writing, the overlap it waits for never came, and the file still passed every test whose assertions
// happened not to look at the schema. W121 fixed the same class in tests/apl-2742.test.ts, whose own guard bans the
// strings `new pg.Pool(` / `new pg.Client(`: a grep is the instrument that missed this one, so the check here is
// behavioural. It builds its connections through raceClient(), the factory the race itself uses, and reads a sentinel
// row that lives in `public` under a name nothing else uses.
describe("qa:TC missing SHO-3011: the race's pg connections read the schema DATABASE_URL names, not public", () => {
  const SENTINEL = `zz_w168_sentinel_${process.pid}`;

  it("qa:TC missing SHO-3011 AC1: current_schema() is the URL's schema and a public sentinel is not visible", async () => {
    const want = testSchema();
    expect(want, "this guard only means something when DATABASE_URL names a schema (?schema=)").toBeTruthy();

    const client = raceClient();
    await client.connect();
    try {
      // The sentinel as the leak would have found it: a table that exists only in public, fully qualified in its DDL so
      // its own creation cannot depend on the search path being checked.
      await client.query(`DROP TABLE IF EXISTS public."${SENTINEL}"`);
      await client.query(`CREATE TABLE public."${SENTINEL}" (value text)`);
      await client.query(`INSERT INTO public."${SENTINEL}" (value) VALUES ('SENTINEL-FROM-public')`);

      const where = (await client.query<{ current: string | null; schemas: string; searchPath: string }>(
        "SELECT current_schema() AS current, array_to_string(current_schemas(false), ',') AS schemas, current_setting('search_path') AS \"searchPath\"",
      )).rows[0];
      expect(where.current, "a race connection did not receive the URL's schema").toBe(want);
      expect(where.schemas.split(","), "search_path falls back to public, so an unqualified read can leave the schema").not.toContain("public");

      // Behaviour, not text: the unqualified sentinel name has no table to resolve to on this connection.
      await expect(client.query(`SELECT value FROM "${SENTINEL}"`)).rejects.toMatchObject({ code: "42P01" });

      // And the table the race locks is the one the route inserts into, in that same schema.
      const locked = (await client.query<{ schema: string }>(
        `SELECT n.nspname AS schema FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.oid = to_regclass('"Notification"')`,
      )).rows[0];
      expect(locked?.schema, "LOCK TABLE \"Notification\" would have guarded another schema's table").toBe(want);

      // The single-connection construction this replaces, for the record: it is the escape, on the live URL.
      const bare = new pg.Client({ connectionString: localDatabaseUrl() });
      await bare.connect();
      try {
        const bareSchema = (await bare.query<{ s: string | null }>("SELECT current_schema() AS s")).rows[0].s;
        expect(bareSchema, "a bare pg client drops ?schema= - this is the leak the factory closes").not.toBe(want);
        const bareSentinel = (await bare.query<{ value: string }>(`SELECT value FROM "${SENTINEL}"`)).rows;
        expect(bareSentinel.map((r) => r.value), "the same connection reads the public sentinel").toEqual(["SENTINEL-FROM-public"]);
      } finally {
        await bare.end();
      }
    } finally {
      await client.query(`DROP TABLE IF EXISTS public."${SENTINEL}"`).catch(() => {});
      await client.end();
    }
  }, 30_000);
});
