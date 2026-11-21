-- HR-106 rollback review draft. NOT approved for shared databases.
-- Run only as one bounded transaction after catalog/data readback and a separate GO.
-- These four names belong exclusively to the additive HR-106 draft; strict DROP
-- refuses a partial or unexpected state instead of hiding it with IF EXISTS.
-- Existing Project, Pipeline, Stage rows and Project_stage_needs_pipeline remain.
LOCK TABLE "Project", "Pipeline", "Stage" IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE "Project" DROP CONSTRAINT "hr106_project_stage_pipeline_fkey";
ALTER TABLE "Project" DROP CONSTRAINT "hr106_project_pipeline_type_fkey";
ALTER TABLE "Stage" DROP CONSTRAINT "hr106_stage_id_pipeline_key";
ALTER TABLE "Pipeline" DROP CONSTRAINT "hr106_pipeline_id_type_key";
