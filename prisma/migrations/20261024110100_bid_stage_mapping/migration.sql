-- Owner-approved seeded Bid-only mapping. Abort on customization; never guess a migration.
-- Stage IDs and historical Undo/action JSON references remain valid, including Awaiting result.
BEGIN;
LOCK TABLE "Pipeline", "Stage", "Project" IN SHARE ROW EXCLUSIVE MODE;
DO $$
DECLARE
  seed_ids text[] := ARRAY['st_bid_identified','st_bid_gonogo','st_bid_preparing','st_bid_submitted','st_bid_awaiting','st_bid_won','st_bid_lost'];
  old_ids text[];
  other_stages jsonb;
  other_pipelines jsonb;
  other_projects jsonb;
  bid_projects jsonb;
  project_count bigint;
  awaiting_count bigint;
  moved_count bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Pipeline" WHERE "id"='pl_bid' AND "key"='DEAL_BID' AND "typeId"='wst_deal') THEN
    RAISE EXCEPTION 'Bid stage mapping refused: expected seeded pl_bid / DEAL_BID pipeline is missing or changed';
  END IF;
  IF (SELECT count(*) FROM "Stage" WHERE "pipelineId"='pl_bid') <> 7 OR
     (SELECT count(*) FROM "Stage" WHERE "pipelineId"='pl_bid' AND "id"=ANY(seed_ids)) <> 7 THEN
    RAISE EXCEPTION 'Bid stage mapping refused: custom, missing or unexpected Bid stage IDs require explicit mapping';
  END IF;
  IF EXISTS (
    SELECT 1 FROM (VALUES
      ('st_bid_identified','Identified',0,'ACTIVE',false),
      ('st_bid_gonogo','Go/No-go',1,'ACTIVE',false),
      ('st_bid_preparing','Preparing',2,'ACTIVE',false),
      ('st_bid_submitted','Submitted',3,'ACTIVE',false),
      ('st_bid_awaiting','Awaiting result',4,'ACTIVE',false),
      ('st_bid_won','Won',5,'DONE',false),
      ('st_bid_lost','Lost',6,'LOST',true)
    ) AS expected(id,name,position,category,needs_reason)
    JOIN "Stage" s ON s."id"=expected.id
    WHERE s."name"<>expected.name OR s."position"<>expected.position OR s."category"::text<>expected.category
       OR s."needsReason"<>expected.needs_reason OR s."requiredFields"<>ARRAY[]::text[]
  ) THEN
    RAISE EXCEPTION 'Bid stage mapping refused: seeded stage names, categories, positions or validation rules have changed';
  END IF;
  IF EXISTS (SELECT 1 FROM "Stage" WHERE "id" IN ('st_bid_nogo','st_bid_onhold','st_bid_ongoing')) THEN
    RAISE EXCEPTION 'Bid stage mapping refused: a new reserved stage ID already exists';
  END IF;
  IF EXISTS (SELECT 1 FROM "Project" WHERE ("pipelineId"='pl_bid' AND ("stageId" IS NULL OR NOT ("stageId"=ANY(seed_ids))))
      OR ("stageId"=ANY(seed_ids) AND "pipelineId" IS DISTINCT FROM 'pl_bid')) THEN
    RAISE EXCEPTION 'Bid stage mapping refused: project pipeline/stage references are inconsistent';
  END IF;
  -- All preconditions are checked before changing schema or rows.
  ALTER TABLE "Stage" ADD COLUMN "isRetired" BOOLEAN NOT NULL DEFAULT false;
  SELECT array_agg("id" ORDER BY "id") INTO old_ids FROM "Stage";
  SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s."id"),'[]'::jsonb) INTO other_stages FROM "Stage" s WHERE s."pipelineId"<>'pl_bid';
  SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p."id"),'[]'::jsonb) INTO other_pipelines FROM "Pipeline" p;
  SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p."id"),'[]'::jsonb) INTO other_projects FROM "Project" p WHERE p."pipelineId" IS DISTINCT FROM 'pl_bid';
  SELECT coalesce(jsonb_agg(to_jsonb(p) || jsonb_build_object('stageId',CASE WHEN p."stageId"='st_bid_awaiting' THEN 'st_bid_submitted' ELSE p."stageId" END) ORDER BY p."id"),'[]'::jsonb) INTO bid_projects FROM "Project" p WHERE p."pipelineId"='pl_bid';
  SELECT count(*) INTO project_count FROM "Project";
  SELECT count(*) INTO awaiting_count FROM "Project" WHERE "pipelineId"='pl_bid' AND "stageId"='st_bid_awaiting';

  UPDATE "Stage" SET "name"='Leads' WHERE "id"='st_bid_identified';
  UPDATE "Stage" SET "name"='Under Evaluation' WHERE "id"='st_bid_gonogo';
  UPDATE "Stage" SET "name"='Go' WHERE "id"='st_bid_preparing';
  UPDATE "Stage" SET "position"=4 WHERE "id"='st_bid_submitted';
  UPDATE "Stage" SET "isRetired"=true WHERE "id"='st_bid_awaiting';
  INSERT INTO "Stage" ("id","pipelineId","name","position","category","needsReason","requiredFields") VALUES
    ('st_bid_nogo','pl_bid','No-Go',3,'LOST',true,'{}'),
    ('st_bid_onhold','pl_bid','On Hold',7,'PAUSED',true,'{}'),
    ('st_bid_ongoing','pl_bid','Ongoing Projects',8,'DELIVERY',false,'{}');
  -- Includes archived records; preserve stageChangedAt, stageReason, updatedAt and all other columns.
  UPDATE "Project" SET "stageId"='st_bid_submitted' WHERE "pipelineId"='pl_bid' AND "stageId"='st_bid_awaiting';
  GET DIAGNOSTICS moved_count = ROW_COUNT;

  IF moved_count<>awaiting_count OR project_count<>(SELECT count(*) FROM "Project") THEN
    RAISE EXCEPTION 'Bid stage mapping invariant failed: project count or Awaiting move count';
  END IF;
  IF EXISTS (SELECT unnest(old_ids) EXCEPT SELECT "id" FROM "Stage") THEN
    RAISE EXCEPTION 'Bid stage mapping invariant failed: a historical stage ID was removed';
  END IF;
  IF other_stages IS DISTINCT FROM (SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s."id"),'[]'::jsonb) FROM "Stage" s WHERE s."pipelineId"<>'pl_bid')
     OR other_pipelines IS DISTINCT FROM (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p."id"),'[]'::jsonb) FROM "Pipeline" p)
     OR other_projects IS DISTINCT FROM (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p."id"),'[]'::jsonb) FROM "Project" p WHERE p."pipelineId" IS DISTINCT FROM 'pl_bid')
     OR bid_projects IS DISTINCT FROM (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p."id"),'[]'::jsonb) FROM "Project" p WHERE p."pipelineId"='pl_bid') THEN
    RAISE EXCEPTION 'Bid stage mapping invariant failed: unrelated pipeline/stage/project data changed';
  END IF;
END $$;
COMMIT;
