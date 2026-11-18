// Audit-only characterization. Transactional DDL/data on disposable CI PostgreSQL.
import { Client } from "pg";
import { randomUUID } from "node:crypto";

const url = new URL(process.env.DATABASE_URL || "");
if (process.env.CI !== "true" || !["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/sho_test") {
  throw new Error("HR106_LOCAL_CI_ONLY");
}
const client = new Client({ connectionString: url.toString() });
const id = `hr106-${randomUUID()}`;
let cases = 0;

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
  await client.query("BEGIN");
  await client.query("SET LOCAL lock_timeout = '5s'");
  await client.query("SET LOCAL statement_timeout = '15s'");
  await client.query('INSERT INTO "Workspace" ("id","name") VALUES ($1,$2)', [id, "HR106 disposable"]);

  // Confirm the gap on the exact migrated schema before testing the proposed additive keys.
  await attempt("baseline wrong pipeline type is accepted", project("wrong-type-before", "wst_project", "pl_proactive", null), null);
  await attempt("baseline wrong stage pipeline is accepted", project("wrong-stage-before", "wst_deal", "pl_bid", "st_pro_lead"), null);
  await attempt("existing stage-needs-pipeline check", project("no-pipeline", "wst_deal", null, "st_pro_lead"), "23514");

  await client.query('ALTER TABLE "Pipeline" ADD CONSTRAINT "hr106_pipeline_id_type_key" UNIQUE ("id","typeId")');
  await client.query('ALTER TABLE "Stage" ADD CONSTRAINT "hr106_stage_id_pipeline_key" UNIQUE ("id","pipelineId")');
  await client.query('ALTER TABLE "Project" ADD CONSTRAINT "hr106_project_pipeline_type_fkey" FOREIGN KEY ("pipelineId","typeId") REFERENCES "Pipeline"("id","typeId") ON DELETE SET NULL ("pipelineId")');
  await client.query('ALTER TABLE "Project" ADD CONSTRAINT "hr106_project_stage_pipeline_fkey" FOREIGN KEY ("stageId","pipelineId") REFERENCES "Stage"("id","pipelineId") ON DELETE SET NULL ("stageId")');

  await attempt("matching stage pipeline and type", project("valid", "wst_deal", "pl_proactive", "st_pro_lead"), null);
  await attempt("plain project remains valid", project("plain", "wst_project", null, null), null);
  await attempt("wrong pipeline type rejected", project("wrong-type-after", "wst_project", "pl_proactive", null), "23503");
  await attempt("wrong stage pipeline rejected", project("wrong-stage-after", "wst_deal", "pl_bid", "st_pro_lead"), "23503");
  await attempt("stage without pipeline remains rejected", project("no-pipeline-after", "wst_deal", null, "st_pro_lead"), "23514");
  console.log(JSON.stringify({ finding: "HR-106", result: "PASS", cases, transactionalDdl: true, persisted: false }));
} finally {
  try { await client.query("ROLLBACK"); } finally { await client.end(); }
}
