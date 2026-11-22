-- HR-106 review draft. NOT a Prisma migration and NOT approved for shared databases.
-- The caller must run this in a bounded transaction after a fresh data inventory.
-- PostgreSQL 16 column-specific SET NULL preserves Project.typeId and pipelineId.
-- Freeze writers before the authoritative scan; the caller sets lock_timeout and
-- statement_timeout and aborts the entire transaction if this lock cannot be held.
LOCK TABLE "Project", "Pipeline", "Stage" IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Project" p
    JOIN "Pipeline" pl ON pl."id" = p."pipelineId"
    WHERE p."pipelineId" IS NOT NULL AND pl."typeId" <> p."typeId"
  ) THEN
    RAISE EXCEPTION 'HR106_PIPELINE_TYPE_MISMATCH';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "Project" p
    JOIN "Stage" s ON s."id" = p."stageId"
    WHERE p."stageId" IS NOT NULL AND s."pipelineId" <> p."pipelineId"
  ) THEN
    RAISE EXCEPTION 'HR106_STAGE_PIPELINE_MISMATCH';
  END IF;
END $$;

ALTER TABLE "Pipeline" ADD CONSTRAINT "hr106_pipeline_id_type_key" UNIQUE ("id", "typeId");
ALTER TABLE "Stage" ADD CONSTRAINT "hr106_stage_id_pipeline_key" UNIQUE ("id", "pipelineId");
ALTER TABLE "Project" ADD CONSTRAINT "hr106_project_pipeline_type_fkey"
  FOREIGN KEY ("pipelineId", "typeId") REFERENCES "Pipeline" ("id", "typeId")
  ON DELETE SET NULL ("pipelineId") NOT VALID;
ALTER TABLE "Project" ADD CONSTRAINT "hr106_project_stage_pipeline_fkey"
  FOREIGN KEY ("stageId", "pipelineId") REFERENCES "Stage" ("id", "pipelineId")
  ON DELETE SET NULL ("stageId") NOT VALID;
ALTER TABLE "Project" VALIDATE CONSTRAINT "hr106_project_pipeline_type_fkey";
ALTER TABLE "Project" VALIDATE CONSTRAINT "hr106_project_stage_pipeline_fkey";
