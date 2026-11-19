// Audit-only characterization. Transactional DDL/data on disposable CI PostgreSQL.
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const url = new URL(process.env.DATABASE_URL || "");
if (process.env.CI !== "true" || !["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/sho_test") {
  throw new Error("HR106_LOCAL_CI_ONLY");
}
const client = new Client({ connectionString: url.toString() });
const id = `hr106-${randomUUID()}`;
let cases = 0;
let connected = false;
let passed = false;

async function attempt(label, sql, expectedCode) {
  await client.query("SAVEPOINT hr106_case");
  let code = null;
  try { await client.query(sql); } catch (error) { code = error.code; }
  await client.query("ROLLBACK TO SAVEPOINT hr106_case");
  await client.query("RELEASE SAVEPOINT hr106_case");
  if (code !== expectedCode) throw new Error(`${label}: expected ${expectedCode || "success"}, got ${code || "success"}`);
  cases++;
}

function project(suffix, type, pipeline, stage) {
  const q = (s) => s === null ? "NULL" : `'${s}'`;
  return `INSERT INTO "Project" ("id","workspaceId","name","updatedAt","typeId","pipelineId","stageId") VALUES (${q(`${id}-${suffix}`)},${q(id)},'HR106 disposable',NOW(),${q(type)},${q(pipeline)},${q(stage)})`;
}

try {
  await client.connect();
  connected = true;
  await client.query("BEGIN");
  await client.query("SET LOCAL lock_timeout = '5s'");
  await client.query("SET LOCAL statement_timeout = '15s'");
  await client.query('INSERT INTO "Workspace" ("id","name") VALUES ($1,$2)', [id, "HR106 disposable"]);

  // Confirm the gap on the exact migrated schema before testing the proposed additive keys.
  await attempt("baseline wrong pipeline type is accepted", project("wrong-type-before", "wst_project", "pl_proactive", null), null);
  await attempt("baseline wrong stage pipeline is accepted", project("wrong-stage-before", "wst_deal", "pl_bid", "st_pro_lead"), null);
  await attempt("existing stage-needs-pipeline check", project("no-pipeline", "wst_deal", null, "st_pro_lead"), "23514");

  const draft = readFileSync("deploy/drafts/hr106-project-stage-invariant.sql", "utf8");
  const competingWriter = new Client({ connectionString: url.toString() });
  await competingWriter.connect();
  try {
    await competingWriter.query("BEGIN");
    await competingWriter.query('LOCK TABLE "Project" IN ROW EXCLUSIVE MODE');
    await client.query("SAVEPOINT hr106_writer_lock");
    await client.query("SET LOCAL lock_timeout = '250ms'");
    let lockCode = null;
    try { await client.query(draft); } catch (error) { lockCode = error.code; }
    await client.query("ROLLBACK TO SAVEPOINT hr106_writer_lock");
    await client.query("RELEASE SAVEPOINT hr106_writer_lock");
    if (lockCode !== "55P03") throw new Error(`draft did not refuse competing writer: ${lockCode || "success"}`);
    cases++;
  } finally {
    await competingWriter.query("ROLLBACK").catch(() => {});
    await competingWriter.end();
  }
  for (const [label, insert, marker] of [
    ["wrong pipeline type", project("dirty-type", "wst_project", "pl_proactive", null), "HR106_PIPELINE_TYPE_MISMATCH"],
    ["wrong stage pipeline", project("dirty-stage", "wst_deal", "pl_bid", "st_pro_lead"), "HR106_STAGE_PIPELINE_MISMATCH"],
  ]) {
    await client.query("SAVEPOINT hr106_preflight");
    await client.query(insert);
    let failure;
    try { await client.query(draft); } catch (error) { failure = error; }
    await client.query("ROLLBACK TO SAVEPOINT hr106_preflight");
    await client.query("RELEASE SAVEPOINT hr106_preflight");
    if (failure?.code !== "P0001" || !failure.message.includes(marker)) throw new Error(`${label}: draft preflight did not stop safely`);
    cases++;
  }
  await client.query(draft);

  // A future migration must not silently replace the column-specific SET NULL
  // actions with Prisma's ordinary composite SET NULL on every child column.
  const catalog = await client.query(`
    SELECT c.conname, c.contype, c.convalidated, c.confdeltype,
      (SELECT array_agg(a.attname::text ORDER BY u.ord)
         FROM unnest(c.conkey) WITH ORDINALITY AS u(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = u.attnum) AS child_cols,
      (SELECT array_agg(a.attname::text ORDER BY u.ord)
         FROM unnest(c.confkey) WITH ORDINALITY AS u(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = u.attnum) AS parent_cols,
      (SELECT array_agg(a.attname::text ORDER BY u.ord)
         FROM unnest(c.confdelsetcols) WITH ORDINALITY AS u(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = u.attnum) AS set_null_cols
    FROM pg_constraint c
    WHERE c.connamespace = 'public'::regnamespace
      AND c.conname = ANY($1::text[])
  `, [[
    "hr106_pipeline_id_type_key", "hr106_stage_id_pipeline_key",
    "hr106_project_pipeline_type_fkey", "hr106_project_stage_pipeline_fkey",
  ]]);
  const expected = new Map([
    ["hr106_pipeline_id_type_key", { type: "u", child: ["id", "typeId"] }],
    ["hr106_stage_id_pipeline_key", { type: "u", child: ["id", "pipelineId"] }],
    ["hr106_project_pipeline_type_fkey", {
      type: "f", child: ["pipelineId", "typeId"], parent: ["id", "typeId"], setNull: ["pipelineId"],
    }],
    ["hr106_project_stage_pipeline_fkey", {
      type: "f", child: ["stageId", "pipelineId"], parent: ["id", "pipelineId"], setNull: ["stageId"],
    }],
  ]);
  if (catalog.rows.length !== expected.size) throw new Error("HR106_CATALOG_CONSTRAINT_COUNT");
  for (const constraint of catalog.rows) {
    const want = expected.get(constraint.conname);
    if (!want || constraint.contype !== want.type || !constraint.convalidated ||
        JSON.stringify(constraint.child_cols) !== JSON.stringify(want.child) ||
        (want.parent && JSON.stringify(constraint.parent_cols) !== JSON.stringify(want.parent)) ||
        (want.setNull && (constraint.confdeltype !== "n" ||
          JSON.stringify(constraint.set_null_cols) !== JSON.stringify(want.setNull)))) {
      throw new Error(`HR106_CATALOG_DRIFT:${constraint.conname}:${JSON.stringify({
        type: constraint.contype, validated: constraint.convalidated,
        child: constraint.child_cols, parent: constraint.parent_cols,
        deleteAction: constraint.confdeltype, setNull: constraint.set_null_cols,
      })}`);
    }
    cases++;
  }

  await attempt("matching stage pipeline and type", project("valid", "wst_deal", "pl_proactive", "st_pro_lead"), null);
  await attempt("plain project remains valid", project("plain", "wst_project", null, null), null);
  await attempt("wrong pipeline type rejected", project("wrong-type-after", "wst_project", "pl_proactive", null), "23503");
  await attempt("wrong stage pipeline rejected", project("wrong-stage-after", "wst_deal", "pl_bid", "st_pro_lead"), "23503");
  await attempt("stage without pipeline remains rejected", project("no-pipeline-after", "wst_deal", null, "st_pro_lead"), "23514");

  // The new composite FKs must retain the old single-column nulling behavior.
  const pipeline = `${id}-pipeline`;
  const stage = `${id}-stage`;
  const projectId = `${id}-delete-semantics`;
  await client.query('INSERT INTO "Pipeline" ("id","typeId","key","name","position") VALUES ($1,$2,$3,$4,$5)', [pipeline, "wst_deal", pipeline, "HR106 disposable", 999]);
  await client.query('INSERT INTO "Stage" ("id","pipelineId","name","position","category","requiredFields") VALUES ($1,$2,$3,$4,$5,$6)', [stage, pipeline, "HR106 disposable", 999, "ACTIVE", []]);
  await client.query('INSERT INTO "Project" ("id","workspaceId","name","updatedAt","typeId","pipelineId","stageId") VALUES ($1,$2,$3,NOW(),$4,$5,$6)', [projectId, id, "HR106 disposable", "wst_deal", pipeline, stage]);
  await attempt("referenced pipeline type change rejected", `UPDATE "Pipeline" SET "typeId"='wst_project' WHERE "id"='${pipeline}'`, "23503");
  await attempt("referenced stage pipeline change rejected", `UPDATE "Stage" SET "pipelineId"='pl_bid' WHERE "id"='${stage}'`, "23503");
  await client.query('DELETE FROM "Stage" WHERE "id"=$1', [stage]);
  let row = await client.query('SELECT "typeId","pipelineId","stageId" FROM "Project" WHERE "id"=$1', [projectId]);
  if (row.rows.length !== 1 || row.rows[0].typeId !== "wst_deal" || row.rows[0].pipelineId !== pipeline || row.rows[0].stageId !== null) {
    throw new Error("HR106_STAGE_DELETE_SEMANTICS");
  }
  cases++;
  await client.query('DELETE FROM "Pipeline" WHERE "id"=$1', [pipeline]);
  row = await client.query('SELECT "typeId","pipelineId","stageId" FROM "Project" WHERE "id"=$1', [projectId]);
  if (row.rows.length !== 1 || row.rows[0].typeId !== "wst_deal" || row.rows[0].pipelineId !== null || row.rows[0].stageId !== null) {
    throw new Error("HR106_PIPELINE_DELETE_SEMANTICS");
  }
  cases++;
  passed = true;
} finally {
  if (connected) {
    try {
      await client.query("ROLLBACK");
      const residue = await client.query('SELECT count(*)::int AS count FROM "Workspace" WHERE "id"=$1', [id]);
      if (residue.rows[0].count !== 0) throw new Error("HR106_FIXTURE_RESIDUE");
    } finally { await client.end(); }
  }
}
if (passed) console.log(JSON.stringify({ finding: "HR-106", result: "PASS", cases, transactionalDdl: true, persisted: false }));
