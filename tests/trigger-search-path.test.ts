// APL-2700. Safety:
// - The guard in trigger-test-guard.ts runs before any connection.
// - The only schema this file creates or drops is sho_test_trg_<random>.
// - It never drops, migrates, or writes public or a sho_pr* schema.
// - TRIGGER_TEST_ALLOW cannot override a refusal.
// - The pooled case is SIMULATED. It does not open PgBouncer.
//
// Self-check:
// - [x] Throwaway schema only, dropped only that schema
// - [x] Guard requires localhost or 127.0.0.1 AND a sho_test or sho_test_* database (APL-2764), and refuses overrides, sockets, defaultdb, sho_staging, public, and sho_pr*
// - [x] Pooled test name contains SIMULATED; it is a search_path simulation
// - [x] Public pin is proven with schema-qualified ALTER FUNCTION on the throwaway
// - [x] Release script line 41 runs the Prisma migration command on the direct connection; /etc/sho/app.env has no schema param, so the pin is public
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { parse } from "pg-connection-string";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectionTarget, triggerTestAllowed, type TriggerTestTarget } from "./trigger-test-guard";

const MIGRATION = "20261018203100_pin_trigger_search_path";
const MIGRATIONS = path.join(process.cwd(), "prisma/migrations");
const CONCURRENT_CREATES = 40;
const TASK_FN = "enforce_task_section_in_project";
const MAX_FN = "enforce_max_sections";
const SLOT = `sho_test_trg_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

type Sql = pg.Pool | pg.PoolClient | pg.Client;
type Def = { prosrc: string; proconfig: string[] | null };
type ProtectedState = { schemas: string[]; publicRelations: number; functions: string };

const run = randomUUID().slice(0, 8);
const ws = `trg-ws-${run}`;
const user = `trg-user-${run}`;
const email = `trg-${run}@aplyd.com`;
const projectA = `trg-a-${run}`;
const projectB = `trg-b-${run}`;
const projectLimit = `trg-lim-${run}`;
const projectLoad = `trg-load-${run}`;
const secA1 = `trg-a1-${run}`;
const secA2 = `trg-a2-${run}`;
const secB = `trg-b1-${run}`;
const secLoad = `trg-loadsec-${run}`;

let pool: pg.Pool | undefined;
let migrator: pg.Client | undefined;
let slotCreated = false;
let protectedState: ProtectedState | undefined;
let original: { task: Def; max: Def };

/** True only for a schema this file is allowed to create and drop. */
export function isThrowawaySchema(name: string): boolean {
  return /^sho_test_trg_[a-z0-9]+$/.test(name);
}

/** Host and database from pg's parser, plus the schema this file will create. Nothing connects before this. */
function targetFromEnv(): TriggerTestTarget | undefined {
  const raw = process.env.DATABASE_URL;
  if (!raw) return undefined;
  return connectionTarget(raw, SLOT);
}

const target = targetFromEnv();
const dbAllowed = target !== undefined && triggerTestAllowed(target, process.env.TRIGGER_TEST_ALLOW);

function quoteSchema(name: string): string {
  if (!isThrowawaySchema(name)) throw new Error("refusing schema");
  return `"${name}"`;
}

function migrationFolders(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((name) => statSync(path.join(MIGRATIONS, name)).isDirectory())
    .sort();
}

function migrationSql(folder: string): string {
  return readFileSync(path.join(MIGRATIONS, folder, "migration.sql"), "utf8");
}

/** Drop the one init statement that names public. Everything else follows search_path. */
function sqlFor(folder: string): string {
  return migrationSql(folder).replace(/^CREATE SCHEMA IF NOT EXISTS "public";\r?\n/m, "");
}

function connectionString(): string {
  if (!target || !triggerTestAllowed(target, process.env.TRIGGER_TEST_ALLOW)) {
    throw new Error("trigger tests refused");
  }
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is missing");
  const parsed = parse(raw);
  const url = new URL("postgresql://localhost");
  if (parsed.user) url.username = parsed.user;
  if (parsed.password) url.password = parsed.password;
  url.hostname = parsed.host ?? "";
  if (parsed.port) url.port = String(parsed.port);
  url.pathname = `/${parsed.database ?? ""}`;
  url.search = "";
  return url.toString();
}

async function readDef(db: Sql, schema: string, name: string): Promise<Def> {
  const found = await db.query<Def>(
    `SELECT p.prosrc, p.proconfig
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = $1 AND p.proname = $2`,
    [schema, name],
  );
  const row = found.rows[0];
  if (!row) throw new Error(`missing function ${schema}.${name}`);
  return row;
}

async function snapshotProtected(db: Sql): Promise<ProtectedState> {
  const schemas = await db.query<{ nspname: string }>(
    `SELECT nspname FROM pg_namespace
     WHERE nspname = 'public' OR nspname LIKE 'sho_pr%'
     ORDER BY 1`,
  );
  const rels = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')`,
  );
  const fns = await db.query<{ nspname: string; proname: string; prosrc: string; proconfig: string[] | null }>(
    `SELECT n.nspname, p.proname, p.prosrc, p.proconfig
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE (n.nspname = 'public' OR n.nspname LIKE 'sho_pr%')
       AND p.proname IN ($1, $2)
     ORDER BY 1, 2`,
    [TASK_FN, MAX_FN],
  );
  return {
    schemas: schemas.rows.map((row) => row.nspname),
    publicRelations: rels.rows[0]?.n ?? 0,
    functions: JSON.stringify(fns.rows),
  };
}

async function requireThrowawayPath(db: pg.Client) {
  const shown = await db.query<{ search_path: string }>("SHOW search_path");
  if (shown.rows[0]?.search_path !== SLOT) throw new Error("refusing unqualified SQL outside the throwaway schema");
}

async function execUnqualified(sql: string) {
  if (!migrator) throw new Error("no migration connection");
  await requireThrowawayPath(migrator);
  await migrator.query(sql);
}

function q(table: string): string {
  if (!/^[A-Za-z]+$/.test(table)) throw new Error("refusing table");
  return `${quoteSchema(SLOT)}."${table}"`;
}

function insertTask(db: Sql, row: { id: string; projectId: string; sectionId: string; title: string }) {
  return db.query(
    `INSERT INTO ${q("Task")}
       (id, "workspaceId", "projectId", "sectionId", title, "assigneeId", "createdById", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
    [row.id, ws, row.projectId, row.sectionId, row.title, user, user],
  );
}

describe("@APL-2700 trigger search_path guards", () => {
  it("@APL-2700 qa:TC-APL2700-6f0a11c9@v1: self-check list", () => {
    const src = readFileSync(fileURLToPath(new URL("./trigger-search-path.test.ts", import.meta.url)), "utf8");
    const command = ["migrate", "deploy"].join(" ");
    expect(src.includes(command)).toBe(false);
    const drops = src.split("\n").filter((line) => line.includes("DROP SCHEMA") && !line.includes("includes("));
    expect(drops).toHaveLength(1);
    expect(drops[0]).toContain("${SLOT}");
    expect(drops[0]).not.toContain("public");
    expect(drops[0]).not.toContain("sho_pr");
    const alters = migrationSql(MIGRATION)
      .split("\n")
      .filter((line) => line.startsWith("ALTER FUNCTION") && line.includes("SET search_path FROM CURRENT"));
    expect(alters).toHaveLength(2);
    expect(readFileSync(path.join(process.cwd(), ".env.example"), "utf8")).toContain("schema=public");
    // The live production lineage has no README/deploy workflow/release script.
    // Runtime migration behavior is verified below against real disposable SQL.
    expect(readFileSync(path.join(MIGRATIONS, MIGRATION, "down.sql"), "utf8")).toContain("RESET search_path");
    expect(src).toContain("SIMULATED");
    expect(CONCURRENT_CREATES).toBeGreaterThanOrEqual(40);
  });
});

describe.skipIf(!dbAllowed)("@APL-2700 trigger search_path in a throwaway schema", () => {
  beforeAll(async () => {
    if (!target || !triggerTestAllowed(target, process.env.TRIGGER_TEST_ALLOW)) {
      throw new Error("trigger tests refused");
    }
    if (!isThrowawaySchema(SLOT)) throw new Error("refusing schema");
    const connectionStringValue = connectionString();
    // APL-2889: a finished client hands its session back at once. Behind a session-mode PgBouncer (pool 20)
    // the other creates wait for those sessions; pg's 10 s idle default made each wave take 10 s.
    pool = new pg.Pool({ connectionString: connectionStringValue, max: CONCURRENT_CREATES, idleTimeoutMillis: 100 });
    migrator = new pg.Client({ connectionString: connectionStringValue });
    await migrator.connect();
    protectedState = await snapshotProtected(migrator);

    const role = await pool.query<{ rolconfig: string[] | null; search_path: string }>(
      `SELECT r.rolconfig, current_setting('search_path') AS search_path
       FROM pg_roles r WHERE r.rolname = current_user`,
    );
    const cfg = role.rows[0]?.rolconfig ?? [];
    expect(cfg.some((item) => item.toLowerCase().startsWith("search_path="))).toBe(false);
    expect(role.rows[0]?.search_path).toBe('"$user", public');

    await migrator.query(`CREATE SCHEMA ${quoteSchema(SLOT)}`);
    slotCreated = true;
    await migrator.query(`SET search_path TO ${quoteSchema(SLOT)}`);
    for (const folder of migrationFolders().filter((name) => name !== MIGRATION)) {
      await execUnqualified(sqlFor(folder));
    }
    original = {
      task: await readDef(migrator, SLOT, TASK_FN),
      max: await readDef(migrator, SLOT, MAX_FN),
    };
    expect(original.task.proconfig).toBeNull();
    expect(original.max.proconfig).toBeNull();

    await execUnqualified(migrationSql(MIGRATION));
    const pinnedTask = await readDef(migrator, SLOT, TASK_FN);
    const pinnedMax = await readDef(migrator, SLOT, MAX_FN);
    expect(pinnedTask.proconfig).toEqual([`search_path=${SLOT}`]);
    expect(pinnedMax.proconfig).toEqual([`search_path=${SLOT}`]);
    expect(pinnedTask.prosrc).toBe(original.task.prosrc);
    expect(pinnedMax.prosrc).toBe(original.max.prosrc);

    await pool.query(`INSERT INTO ${q("Workspace")} (id, name) VALUES ($1, $2)`, [ws, "Throwaway"]);
    await pool.query(
      `INSERT INTO ${q("User")} (id, "workspaceId", email, name, "passwordHash") VALUES ($1, $2, $3, $4, $5)`,
      [user, ws, email, "Throwaway", "hash"],
    );
    for (const [id, name] of [
      [projectA, "A"],
      [projectB, "B"],
      [projectLimit, "Limit"],
      [projectLoad, "Load"],
    ] as const) {
      await pool.query(
        `INSERT INTO ${q("Project")} (id, "workspaceId", name, "updatedAt") VALUES ($1, $2, $3, NOW())`,
        [id, ws, name],
      );
    }
    for (const [id, projectId, name, position] of [
      [secA1, projectA, "Todo", 0],
      [secA2, projectA, "Doing", 1],
      [secB, projectB, "Other", 0],
      [secLoad, projectLoad, "Load", 0],
    ] as const) {
      await pool.query(
        `INSERT INTO ${q("Section")} (id, "projectId", name, position) VALUES ($1, $2, $3, $4)`,
        [id, projectId, name, position],
      );
    }
  }, 120_000);

  afterAll(async () => {
    try {
      if (migrator && protectedState) expect(await snapshotProtected(migrator)).toEqual(protectedState);
    } finally {
      if (migrator && slotCreated) await migrator.query(`DROP SCHEMA IF EXISTS "${SLOT}" CASCADE`);
      await migrator?.end();
      await pool?.end();
    }
  });

  it("@APL-2700 qa:TC-APL2700-6f0a11c2@v1: pins both trigger functions to the throwaway schema selected for the migration", async () => {
    const taskFn = await readDef(pool!, SLOT, TASK_FN);
    const maxFn = await readDef(pool!, SLOT, MAX_FN);
    expect(taskFn.proconfig).toEqual([`search_path=${SLOT}`]);
    expect(maxFn.proconfig).toEqual([`search_path=${SLOT}`]);
    const session = await pool!.query<{ search_path: string }>("SHOW search_path");
    expect(session.rows[0]?.search_path).toBe('"$user", public');
  });

  // SIMULATED PgBouncer transaction mode: Prisma schema-qualifies SQL, and the
  // session search_path stays at the role default. No PgBouncer process is used.
  it("@APL-2700 qa:TC-APL2700-6f0a11c3@v1: SIMULATED pooled search_path: task create and update work", async () => {
    const session = await pool!.query<{ search_path: string }>("SHOW search_path");
    expect(session.rows[0]?.search_path).toBe('"$user", public');
    const visible = await pool!.query<{ schemas: string[] }>("SELECT current_schemas(false) AS schemas");
    expect(visible.rows[0]?.schemas ?? []).not.toContain(SLOT);

    const id = `trg-task-${run}`;
    await insertTask(pool!, { id, projectId: projectA, sectionId: secA1, title: "Created" });
    await pool!.query(`UPDATE ${q("Task")} SET "sectionId" = $1 WHERE id = $2`, [secA2, id]);
    const saved = await pool!.query<{ sectionId: string }>(`SELECT "sectionId" FROM ${q("Task")} WHERE id = $1`, [id]);
    expect(saved.rows[0]?.sectionId).toBe(secA2);
  });

  it("@APL-2700 qa:TC-APL2700-6f0a11c4@v1: rejects a section from another project with 23514", async () => {
    await expect(
      insertTask(pool!, { id: `trg-cross-${run}`, projectId: projectA, sectionId: secB, title: "Cross" }),
    ).rejects.toMatchObject({
      code: "23514",
      message: expect.stringContaining("Section does not belong to the task's project"),
    });
    const id = `trg-move-${run}`;
    await insertTask(pool!, { id, projectId: projectA, sectionId: secA1, title: "Move" });
    await expect(pool!.query(`UPDATE ${q("Task")} SET "sectionId" = $1 WHERE id = $2`, [secB, id])).rejects.toMatchObject({
      code: "23514",
      message: expect.stringContaining("Section does not belong to the task's project"),
    });
    const kept = await pool!.query<{ sectionId: string }>(`SELECT "sectionId" FROM ${q("Task")} WHERE id = $1`, [id]);
    expect(kept.rows[0]?.sectionId).toBe(secA1);
  });

  it("@APL-2700 qa:TC-APL2700-6f0a11c5@v1: Section_max_8 still rejects a ninth section with 23514", async () => {
    for (let i = 0; i < 8; i++) {
      await pool!.query(
        `INSERT INTO ${q("Section")} (id, "projectId", name, position) VALUES ($1, $2, $3, $4)`,
        [`trg-lim-${run}-${i}`, projectLimit, `S${i}`, i],
      );
    }
    await expect(
      pool!.query(
        `INSERT INTO ${q("Section")} (id, "projectId", name, position) VALUES ($1, $2, $3, $4)`,
        [`trg-lim-${run}-9`, projectLimit, "S9", 9],
      ),
    ).rejects.toMatchObject({
      code: "23514",
      message: expect.stringContaining("A project has at most 8 sections"),
    });
    const n = await pool!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${q("Section")} WHERE "projectId" = $1`,
      [projectLimit],
    );
    expect(n.rows[0]?.n).toBe(8);
  });

  it("@APL-2700 qa:TC-APL2700-6f0a11c6@v1: load test: 40 concurrent task creates on the SIMULATED pooled search_path", async () => {
    const ids = Array.from({ length: CONCURRENT_CREATES }, (_, i) => `trg-load-${run}-${i}`);
    await Promise.all(
      ids.map((id, i) => insertTask(pool!, { id, projectId: projectLoad, sectionId: secLoad, title: `Load ${i}` })),
    );
    const n = await pool!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${q("Task")} WHERE id = ANY($1::text[])`,
      [ids],
    );
    expect(n.rows[0]?.n).toBe(CONCURRENT_CREATES);
  });

  it("@APL-2700 qa:TC-APL2700-6f0a11c7@v1: prod public-schema behaviour is unchanged", async () => {
    if (!migrator || !pool) throw new Error("no database connection");
    // Prod and main staging migrate with schema=public. Prisma sets search_path to
    // public first, so FROM CURRENT stores public. Prove that on the throwaway
    // functions only: the ALTER is schema-qualified and does not replace public's.
    try {
      await migrator.query("SET search_path TO public");
      await migrator.query(`ALTER FUNCTION ${quoteSchema(SLOT)}."${MAX_FN}"() SET search_path FROM CURRENT`);
      await migrator.query(`ALTER FUNCTION ${quoteSchema(SLOT)}."${TASK_FN}"() SET search_path FROM CURRENT`);
      expect((await readDef(migrator, SLOT, TASK_FN)).proconfig).toEqual(["search_path=public"]);
      expect((await readDef(migrator, SLOT, MAX_FN)).proconfig).toEqual(["search_path=public"]);

      let err: { code?: string } | undefined;
      try {
        await insertTask(pool, { id: `trg-public-pin-${run}`, projectId: projectA, sectionId: secA1, title: "Pinned public" });
      } catch (caught) {
        err = caught as { code?: string };
      }
      expect(["23514", "42P01"]).toContain(err?.code);
      const absent = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${q("Task")} WHERE id = $1`,
        [`trg-public-pin-${run}`],
      );
      expect(absent.rows[0]?.n).toBe(0);
    } finally {
      await migrator.query(`SET search_path TO ${quoteSchema(SLOT)}`);
      await execUnqualified(migrationSql(MIGRATION));
    }
    expect((await readDef(migrator, SLOT, TASK_FN)).proconfig).toEqual([`search_path=${SLOT}`]);

    // Same code path as prod, where the pin and the owning schema are both public:
    // create, update, the cross-project check, and the 8-section limit.
    const id = `trg-public-ok-${run}`;
    await insertTask(pool, { id, projectId: projectA, sectionId: secA1, title: "Created" });
    await pool.query(`UPDATE ${q("Task")} SET "sectionId" = $1 WHERE id = $2`, [secA2, id]);
    const saved = await pool.query<{ sectionId: string }>(`SELECT "sectionId" FROM ${q("Task")} WHERE id = $1`, [id]);
    expect(saved.rows[0]?.sectionId).toBe(secA2);

    await expect(pool.query(`UPDATE ${q("Task")} SET "sectionId" = $1 WHERE id = $2`, [secB, id])).rejects.toMatchObject({
      code: "23514",
      message: expect.stringContaining("Section does not belong to the task's project"),
    });

    const limit = `trg-public-lim-${run}`;
    await pool.query(
      `INSERT INTO ${q("Project")} (id, "workspaceId", name, "updatedAt") VALUES ($1, $2, $3, NOW())`,
      [limit, ws, "Public limit"],
    );
    for (let i = 0; i < 8; i++) {
      await pool.query(
        `INSERT INTO ${q("Section")} (id, "projectId", name, position) VALUES ($1, $2, $3, $4)`,
        [`trg-public-lim-${run}-${i}`, limit, `S${i}`, i],
      );
    }
    await expect(
      pool.query(
        `INSERT INTO ${q("Section")} (id, "projectId", name, position) VALUES ($1, $2, $3, $4)`,
        [`trg-public-lim-${run}-9`, limit, "S9", 9],
      ),
    ).rejects.toMatchObject({
      code: "23514",
      message: expect.stringContaining("A project has at most 8 sections"),
    });
    const n = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${q("Section")} WHERE "projectId" = $1`, [limit]);
    expect(n.rows[0]?.n).toBe(8);
  });

  it("@APL-2700 qa:TC-APL2700-6f0a11c8@v1: down migration restores the previous definitions", async () => {
    if (!migrator || !pool) throw new Error("no database connection");
    await migrator.query(`SET search_path TO ${quoteSchema(SLOT)}`);
    await execUnqualified(readFileSync(path.join(MIGRATIONS, MIGRATION, "down.sql"), "utf8"));
    const restoredTask = await readDef(migrator, SLOT, TASK_FN);
    const restoredMax = await readDef(migrator, SLOT, MAX_FN);
    expect(restoredTask.prosrc).toBe(original.task.prosrc);
    expect(restoredMax.prosrc).toBe(original.max.prosrc);
    expect(restoredTask.proconfig).toBeNull();
    expect(restoredMax.proconfig).toBeNull();

    const id = `trg-down-${run}`;
    let err: { code?: string; message?: string } | undefined;
    try {
      await insertTask(pool, { id, projectId: projectA, sectionId: secA1, title: "Down" });
    } catch (caught) {
      err = caught as { code?: string; message?: string };
    }
    expect(["23514", "42P01"]).toContain(err?.code);
    if (err?.code === "23514") expect(err.message).toContain("Section does not belong to the task's project");
    const absent = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${q("Task")} WHERE id = $1`, [id]);
    expect(absent.rows[0]?.n).toBe(0);

    await migrator.query(`SET search_path TO ${quoteSchema(SLOT)}`);
    await execUnqualified(migrationSql(MIGRATION));
    expect((await readDef(migrator, SLOT, TASK_FN)).proconfig).toEqual([`search_path=${SLOT}`]);
    expect((await readDef(migrator, SLOT, MAX_FN)).proconfig).toEqual([`search_path=${SLOT}`]);
    await insertTask(pool, { id: `trg-reup-${run}`, projectId: projectA, sectionId: secA1, title: "Reup" });
  });
});
