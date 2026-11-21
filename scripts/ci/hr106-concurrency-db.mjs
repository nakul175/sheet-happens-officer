// Audit-only committed-FK race on CI's disposable PostgreSQL. Restores its schema/data.
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const url = new URL(process.env.DATABASE_URL || "");
if (process.env.CI !== "true" || process.env.GITHUB_ACTIONS !== "true" ||
    !["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/sho_test") {
  throw new Error("HR106_DISPOSABLE_CI_ONLY");
}
const connectionString = url.toString();
const admin = new Client({ connectionString });
const writer = new Client({ connectionString });
const updater = new Client({ connectionString });
const id = `hr106-race-${randomUUID()}`;
const pipeline = `${id}-pipeline`;
const stage = `${id}-stage`;
let setup = false;
let cases = 0;

async function race(label, projectId, stageId, updateSql, updateParams) {
  await writer.query("BEGIN");
  await updater.query("BEGIN");
  try {
    await writer.query('INSERT INTO "Project" ("id","workspaceId","name","updatedAt","typeId","pipelineId","stageId") VALUES ($1,$2,$3,NOW(),$4,$5,$6)',
      [projectId, id, "HR106 disposable", "wst_deal", pipeline, stageId]);
    await updater.query("SET LOCAL statement_timeout = '10s'");
    let settled = false;
    const pending = updater.query(updateSql, updateParams).then(
      () => { settled = true; return null; },
      (error) => { settled = true; return error.code; },
    );
    await delay(150);
    if (settled) throw new Error(`${label}: parent update did not wait for uncommitted child`);
    await writer.query("COMMIT");
    const code = await pending;
    if (code !== "23503") throw new Error(`${label}: expected 23503 after child commit, got ${code || "success"}`);
    await updater.query("ROLLBACK");
    cases++;
  } catch (error) {
    await Promise.allSettled([writer.query("ROLLBACK"), updater.query("ROLLBACK")]);
    throw error;
  }
}

try {
  await admin.connect();
  await admin.query("BEGIN");
  await admin.query("SET LOCAL lock_timeout = '5s'");
  await admin.query('ALTER TABLE "Pipeline" ADD CONSTRAINT "hr106_race_pipeline_type_key" UNIQUE ("id","typeId")');
  await admin.query('ALTER TABLE "Stage" ADD CONSTRAINT "hr106_race_stage_pipeline_key" UNIQUE ("id","pipelineId")');
  await admin.query('ALTER TABLE "Project" ADD CONSTRAINT "hr106_race_project_pipeline_type_fkey" FOREIGN KEY ("pipelineId","typeId") REFERENCES "Pipeline"("id","typeId") ON DELETE SET NULL ("pipelineId")');
  await admin.query('ALTER TABLE "Project" ADD CONSTRAINT "hr106_race_project_stage_pipeline_fkey" FOREIGN KEY ("stageId","pipelineId") REFERENCES "Stage"("id","pipelineId") ON DELETE SET NULL ("stageId")');
  await admin.query('INSERT INTO "Workspace" ("id","name") VALUES ($1,$2)', [id, "HR106 disposable"]);
  await admin.query('INSERT INTO "Pipeline" ("id","typeId","key","name","position") VALUES ($1,$2,$3,$4,$5)', [pipeline, "wst_deal", pipeline, "HR106 disposable", 999]);
  await admin.query('INSERT INTO "Stage" ("id","pipelineId","name","position","category","requiredFields") VALUES ($1,$2,$3,$4,$5,$6)', [stage, pipeline, "HR106 disposable", 999, "ACTIVE", []]);
  await admin.query("COMMIT");
  setup = true;
  await Promise.all([writer.connect(), updater.connect()]);

  await race("stage-parent race", `${id}-stage-project`, stage,
    'UPDATE "Stage" SET "pipelineId"=$1 WHERE "id"=$2', ["pl_bid", stage]);
  // The second parent must be referenced only by its new uncommitted child.
  await admin.query('DELETE FROM "Project" WHERE "id"=$1', [`${id}-stage-project`]);
  await race("pipeline-type race", `${id}-type-project`, null,
    'UPDATE "Pipeline" SET "typeId"=$1 WHERE "id"=$2', ["wst_project", pipeline]);

  const invalid = await admin.query('SELECT count(*)::int AS count FROM "Project" p LEFT JOIN "Pipeline" pl ON pl."id"=p."pipelineId" LEFT JOIN "Stage" s ON s."id"=p."stageId" WHERE p."workspaceId"=$1 AND ((p."pipelineId" IS NOT NULL AND pl."typeId" IS DISTINCT FROM p."typeId") OR (p."stageId" IS NOT NULL AND s."pipelineId" IS DISTINCT FROM p."pipelineId"))', [id]);
  if (invalid.rows[0].count !== 0) throw new Error("HR106_CONCURRENT_INVALID_ROW");
} finally {
  await Promise.allSettled([writer.end(), updater.end()]);
  if (setup) {
    await admin.query("BEGIN");
    try {
      await admin.query('DELETE FROM "Project" WHERE "workspaceId"=$1', [id]);
      await admin.query('DELETE FROM "Stage" WHERE "id"=$1', [stage]);
      await admin.query('DELETE FROM "Pipeline" WHERE "id"=$1', [pipeline]);
      await admin.query('DELETE FROM "Workspace" WHERE "id"=$1', [id]);
      await admin.query('ALTER TABLE "Project" DROP CONSTRAINT "hr106_race_project_stage_pipeline_fkey"');
      await admin.query('ALTER TABLE "Project" DROP CONSTRAINT "hr106_race_project_pipeline_type_fkey"');
      await admin.query('ALTER TABLE "Stage" DROP CONSTRAINT "hr106_race_stage_pipeline_key"');
      await admin.query('ALTER TABLE "Pipeline" DROP CONSTRAINT "hr106_race_pipeline_type_key"');
      await admin.query("COMMIT");
    } catch (error) { await admin.query("ROLLBACK"); throw error; }
  } else {
    await admin.query("ROLLBACK").catch(() => {});
  }
  const remaining = await admin.query('SELECT count(*)::int AS count FROM "Workspace" WHERE "id"=$1', [id]);
  const constraints = await admin.query("SELECT count(*)::int AS count FROM pg_constraint WHERE conname LIKE 'hr106_race_%'");
  await admin.end();
  if (remaining.rows[0].count !== 0 || constraints.rows[0].count !== 0) throw new Error("HR106_RACE_RESIDUE");
}
console.log(JSON.stringify({ finding: "HR-106", result: "PASS", concurrentCases: cases, residue: 0 }));
