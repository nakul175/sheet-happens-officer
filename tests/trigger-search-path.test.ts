// APL-2700: preview slots use PgBouncer transaction mode and ?schema=sho_prN.
// Prisma schema-qualifies its SQL, but the role's default search_path stays
// ("$user", public), so an unpinned trigger reads public."Section".
// This file connects the same way: a non-public schema, schema-qualified SQL,
// and a session whose search_path is the role default. public."Section" is the
// decoy and does not hold the slot's section ids.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "dotenv/config";

const SLOT = "sho_pr1";
const MIGRATION = "20261018203100_pin_trigger_search_path";
const MIGRATIONS = path.join(process.cwd(), "prisma/migrations");
const CONCURRENT_CREATES = 40;
const TASK_FN = "enforce_task_section_in_project";
const MAX_FN = "enforce_max_sections";

type Sql = pg.Pool | pg.PoolClient | pg.Client;
type Def = { prosrc: string; proconfig: string[] | null };

const run = randomUUID().slice(0, 8);
const ws = `slot-ws-${run}`;
const user = `slot-user-${run}`;
const email = `slot-${run}@aplyd.com`;
const projectA = `slot-a-${run}`;
const projectB = `slot-b-${run}`;
const projectLimit = `slot-lim-${run}`;
const projectLoad = `slot-load-${run}`;
const secA1 = `slot-a1-${run}`;
const secA2 = `slot-a2-${run}`;
const secB = `slot-b1-${run}`;
const secLoad = `slot-loadsec-${run}`;

let pool: pg.Pool;
let migrator: pg.Client;
let original: { task: Def; max: Def };

function databaseUrl(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is missing");
  return raw;
}

function withSchema(raw: string, schema: string): string {
  const url = new URL(raw);
  url.searchParams.set("schema", schema);
  return url.toString();
}

function withoutSchema(raw: string): string {
  const url = new URL(raw);
  url.searchParams.delete("schema");
  return url.toString();
}

function migrationFolders(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((name) => statSync(path.join(MIGRATIONS, name)).isDirectory())
    .sort();
}

function migrationSql(folder: string): string {
  return readFileSync(path.join(MIGRATIONS, folder, "migration.sql"), "utf8");
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

function migratePublic() {
  const url = withSchema(databaseUrl(), "public");
  const prisma = path.join(process.cwd(), "node_modules/.bin/prisma");
  try {
    execFileSync(prisma, ["migrate", "deploy"], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: url, DIRECT_DATABASE_URL: url },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
  } catch (err) {
    const failed = err as { stdout?: string; stderr?: string; message?: string };
    const text = `${failed.stdout ?? ""}\n${failed.stderr ?? ""}\n${failed.message ?? ""}`;
    throw new Error(text.replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted]"));
  }
}

function q(table: string): string {
  return `"${SLOT}"."${table}"`;
}

function insertTask(db: Sql, row: { id: string; projectId: string; sectionId: string; title: string }) {
  return db.query(
    `INSERT INTO ${q("Task")}
       (id, "workspaceId", "projectId", "sectionId", title, "assigneeId", "createdById", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
    [row.id, ws, row.projectId, row.sectionId, row.title, user, user],
  );
}

describe("trigger search_path on a pooled preview slot (APL-2700)", () => {
  beforeAll(async () => {
    const connectionString = withoutSchema(databaseUrl());
    pool = new pg.Pool({ connectionString, max: CONCURRENT_CREATES });
    migrator = new pg.Client({ connectionString });
    await migrator.connect();

    const role = await pool.query<{ rolconfig: string[] | null; search_path: string }>(
      `SELECT r.rolconfig, current_setting('search_path') AS search_path
       FROM pg_roles r WHERE r.rolname = current_user`,
    );
    const cfg = role.rows[0]?.rolconfig ?? [];
    expect(cfg.some((item) => item.toLowerCase().startsWith("search_path="))).toBe(false);
    expect(role.rows[0]?.search_path).toBe('"$user", public');

    migratePublic();

    await migrator.query(`DROP SCHEMA IF EXISTS "${SLOT}" CASCADE`);
    await migrator.query(`CREATE SCHEMA "${SLOT}"`);
    await migrator.query(`SET search_path TO "${SLOT}"`);
    for (const folder of migrationFolders().filter((name) => name !== MIGRATION)) {
      await migrator.query(migrationSql(folder));
    }
    original = {
      task: await readDef(migrator, SLOT, TASK_FN),
      max: await readDef(migrator, SLOT, MAX_FN),
    };
    expect(original.task.proconfig).toBeNull();
    expect(original.max.proconfig).toBeNull();

    await migrator.query(`SET search_path TO "${SLOT}"`);
    await migrator.query(migrationSql(MIGRATION));
    const pinnedTask = await readDef(migrator, SLOT, TASK_FN);
    const pinnedMax = await readDef(migrator, SLOT, MAX_FN);
    expect(pinnedTask.proconfig).toEqual([`search_path=${SLOT}`]);
    expect(pinnedMax.proconfig).toEqual([`search_path=${SLOT}`]);
    expect(pinnedTask.prosrc).toBe(original.task.prosrc);
    expect(pinnedMax.prosrc).toBe(original.max.prosrc);

    const decoy = await pool.query<{ rel: string | null }>(`SELECT to_regclass('public."Section"') AS rel`);
    expect(decoy.rows[0]?.rel).not.toBeNull();

    await pool.query(`INSERT INTO ${q("Workspace")} (id, name) VALUES ($1, $2)`, [ws, "Slot"]);
    await pool.query(
      `INSERT INTO ${q("User")} (id, "workspaceId", email, name, "passwordHash") VALUES ($1, $2, $3, $4, $5)`,
      [user, ws, email, "Slot", "hash"],
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
    await migrator?.query(`DROP SCHEMA IF EXISTS "${SLOT}" CASCADE`);
    await migrator?.end();
    await pool?.end();
  });

  it("pins both trigger functions to the schema selected for the migration", async () => {
    const taskFn = await readDef(pool, SLOT, TASK_FN);
    const maxFn = await readDef(pool, SLOT, MAX_FN);
    expect(taskFn.proconfig).toEqual([`search_path=${SLOT}`]);
    expect(maxFn.proconfig).toEqual([`search_path=${SLOT}`]);
    const session = await pool.query<{ search_path: string }>("SHOW search_path");
    expect(session.rows[0]?.search_path).toBe('"$user", public');
  });

  it("task create and update work on a pooled slot", async () => {
    const session = await pool.query<{ search_path: string }>("SHOW search_path");
    expect(session.rows[0]?.search_path).toBe('"$user", public');
    const unseen = await pool.query(`SELECT id FROM "Section" WHERE id = $1`, [secA1]);
    expect(unseen.rows).toHaveLength(0);
    const decoy = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public."Section" WHERE id = ANY($1::text[])`,
      [[secA1, secA2, secB, secLoad]],
    );
    expect(decoy.rows[0]?.n).toBe(0);

    const id = `slot-task-${run}`;
    await insertTask(pool, { id, projectId: projectA, sectionId: secA1, title: "Created" });
    await pool.query(`UPDATE ${q("Task")} SET "sectionId" = $1 WHERE id = $2`, [secA2, id]);
    const saved = await pool.query<{ sectionId: string }>(
      `SELECT "sectionId" FROM ${q("Task")} WHERE id = $1`,
      [id],
    );
    expect(saved.rows[0]?.sectionId).toBe(secA2);
  });

  it("rejects a section from another project with 23514", async () => {
    await expect(
      insertTask(pool, { id: `slot-cross-${run}`, projectId: projectA, sectionId: secB, title: "Cross" }),
    ).rejects.toMatchObject({
      code: "23514",
      message: expect.stringContaining("Section does not belong to the task's project"),
    });
    const id = `slot-move-${run}`;
    await insertTask(pool, { id, projectId: projectA, sectionId: secA1, title: "Move" });
    await expect(
      pool.query(`UPDATE ${q("Task")} SET "sectionId" = $1 WHERE id = $2`, [secB, id]),
    ).rejects.toMatchObject({
      code: "23514",
      message: expect.stringContaining("Section does not belong to the task's project"),
    });
    const kept = await pool.query<{ sectionId: string }>(
      `SELECT "sectionId" FROM ${q("Task")} WHERE id = $1`,
      [id],
    );
    expect(kept.rows[0]?.sectionId).toBe(secA1);
  });

  it("Section_max_8 still rejects a ninth section with 23514", async () => {
    for (let i = 0; i < 8; i++) {
      await pool.query(
        `INSERT INTO ${q("Section")} (id, "projectId", name, position) VALUES ($1, $2, $3, $4)`,
        [`slot-lim-${run}-${i}`, projectLimit, `S${i}`, i],
      );
    }
    await expect(
      pool.query(
        `INSERT INTO ${q("Section")} (id, "projectId", name, position) VALUES ($1, $2, $3, $4)`,
        [`slot-lim-${run}-9`, projectLimit, "S9", 9],
      ),
    ).rejects.toMatchObject({
      code: "23514",
      message: expect.stringContaining("A project has at most 8 sections"),
    });
    const n = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${q("Section")} WHERE "projectId" = $1`,
      [projectLimit],
    );
    expect(n.rows[0]?.n).toBe(8);
  });

  it("creates 40 tasks concurrently on the pooled connection", async () => {
    const ids = Array.from({ length: CONCURRENT_CREATES }, (_, i) => `slot-load-${run}-${i}`);
    await Promise.all(
      ids.map((id, i) => insertTask(pool, { id, projectId: projectLoad, sectionId: secLoad, title: `Load ${i}` })),
    );
    const n = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${q("Task")} WHERE id = ANY($1::text[])`,
      [ids],
    );
    expect(n.rows[0]?.n).toBe(CONCURRENT_CREATES);
  });

  it("prod public-schema behaviour is unchanged", async () => {
    const taskFn = await readDef(pool, "public", TASK_FN);
    const maxFn = await readDef(pool, "public", MAX_FN);
    expect(taskFn.proconfig).toEqual(["search_path=public"]);
    expect(maxFn.proconfig).toEqual(["search_path=public"]);

    const c = await pool.connect();
    const stamp = randomUUID().slice(0, 8);
    const pubWs = `pub-ws-${stamp}`;
    const pubUser = `pub-user-${stamp}`;
    const pubProject = `pub-proj-${stamp}`;
    const pubOther = `pub-other-${stamp}`;
    const pubLimit = `pub-lim-${stamp}`;
    const pubSec1 = `pub-sec1-${stamp}`;
    const pubSec2 = `pub-sec2-${stamp}`;
    const pubOtherSec = `pub-osec-${stamp}`;
    const pubTask = `pub-task-${stamp}`;
    try {
      const session = await c.query<{ search_path: string }>("SHOW search_path");
      expect(session.rows[0]?.search_path).toBe('"$user", public');
      await c.query("BEGIN");
      await c.query(`INSERT INTO public."Workspace" (id, name) VALUES ($1, $2)`, [pubWs, "Public"]);
      await c.query(
        `INSERT INTO public."User" (id, "workspaceId", email, name, "passwordHash") VALUES ($1, $2, $3, $4, $5)`,
        [pubUser, pubWs, `pub-${stamp}@aplyd.com`, "Public", "hash"],
      );
      for (const [id, name] of [
        [pubProject, "P"],
        [pubOther, "Q"],
        [pubLimit, "Limit"],
      ] as const) {
        await c.query(
          `INSERT INTO public."Project" (id, "workspaceId", name, "updatedAt") VALUES ($1, $2, $3, NOW())`,
          [id, pubWs, name],
        );
      }
      await c.query(
        `INSERT INTO public."Section" (id, "projectId", name, position) VALUES ($1, $2, $3, $4)`,
        [pubSec1, pubProject, "Todo", 0],
      );
      await c.query(
        `INSERT INTO public."Section" (id, "projectId", name, position) VALUES ($1, $2, $3, $4)`,
        [pubSec2, pubProject, "Doing", 1],
      );
      await c.query(
        `INSERT INTO public."Section" (id, "projectId", name, position) VALUES ($1, $2, $3, $4)`,
        [pubOtherSec, pubOther, "Other", 0],
      );
      await c.query(
        `INSERT INTO public."Task"
           (id, "workspaceId", "projectId", "sectionId", title, "assigneeId", "createdById", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
        [pubTask, pubWs, pubProject, pubSec1, "Created", pubUser, pubUser],
      );
      await c.query(`UPDATE public."Task" SET "sectionId" = $1 WHERE id = $2`, [pubSec2, pubTask]);
      const moved = await c.query<{ sectionId: string }>(
        `SELECT "sectionId" FROM public."Task" WHERE id = $1`,
        [pubTask],
      );
      expect(moved.rows[0]?.sectionId).toBe(pubSec2);

      await c.query("SAVEPOINT cross_project");
      await expect(
        c.query(`UPDATE public."Task" SET "sectionId" = $1 WHERE id = $2`, [pubOtherSec, pubTask]),
      ).rejects.toMatchObject({
        code: "23514",
        message: expect.stringContaining("Section does not belong to the task's project"),
      });
      await c.query("ROLLBACK TO SAVEPOINT cross_project");

      for (let i = 0; i < 8; i++) {
        await c.query(
          `INSERT INTO public."Section" (id, "projectId", name, position) VALUES ($1, $2, $3, $4)`,
          [`pub-lim-${stamp}-${i}`, pubLimit, `S${i}`, i],
        );
      }
      await c.query("SAVEPOINT ninth");
      await expect(
        c.query(
          `INSERT INTO public."Section" (id, "projectId", name, position) VALUES ($1, $2, $3, $4)`,
          [`pub-lim-${stamp}-9`, pubLimit, "S9", 9],
        ),
      ).rejects.toMatchObject({
        code: "23514",
        message: expect.stringContaining("A project has at most 8 sections"),
      });
      await c.query("ROLLBACK TO SAVEPOINT ninth");
      const n = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM public."Section" WHERE "projectId" = $1`,
        [pubLimit],
      );
      expect(n.rows[0]?.n).toBe(8);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });

  it("down migration restores the previous definitions", async () => {
    await migrator.query(`SET search_path TO "${SLOT}"`);
    await migrator.query(readFileSync(path.join(MIGRATIONS, MIGRATION, "down.sql"), "utf8"));
    const restoredTask = await readDef(migrator, SLOT, TASK_FN);
    const restoredMax = await readDef(migrator, SLOT, MAX_FN);
    expect(restoredTask.prosrc).toBe(original.task.prosrc);
    expect(restoredMax.prosrc).toBe(original.max.prosrc);
    expect(restoredTask.proconfig).toBeNull();
    expect(restoredMax.proconfig).toBeNull();

    await expect(
      insertTask(pool, { id: `slot-down-${run}`, projectId: projectA, sectionId: secA1, title: "Down" }),
    ).rejects.toMatchObject({
      code: "23514",
      message: expect.stringContaining("Section does not belong to the task's project"),
    });

    await migrator.query(`SET search_path TO "${SLOT}"`);
    await migrator.query(migrationSql(MIGRATION));
    expect((await readDef(migrator, SLOT, TASK_FN)).proconfig).toEqual([`search_path=${SLOT}`]);
    expect((await readDef(migrator, SLOT, MAX_FN)).proconfig).toEqual([`search_path=${SLOT}`]);
    await insertTask(pool, { id: `slot-reup-${run}`, projectId: projectA, sectionId: secA1, title: "Reup" });
  });
});
