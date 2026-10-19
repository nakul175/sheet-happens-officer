-- Refs APL-2700. Preview slots connect through PgBouncer in transaction mode with
-- ?schema=sho_prN. Prisma schema-qualifies its own SQL, but these trigger functions
-- look up "Section" and "Project" unqualified. The session then has the role's
-- default search_path ("$user", public), so the functions read public."Section"
-- and raise 23514 (Section does not belong to the task's project) on task create.
--
-- Migrations run on the direct connection with that schema already selected, so
-- SET search_path FROM CURRENT stores it on the function. Prod and main staging
-- migrate with schema=public, which pins public and keeps the current behaviour.
-- The trigger Section_max_8 calls enforce_max_sections; Task_section_in_project
-- calls enforce_task_section_in_project. Rollback: down.sql in this directory
-- (not applied by Prisma; run it on the same direct connection).

CREATE OR REPLACE FUNCTION "enforce_max_sections"() RETURNS trigger AS $$
BEGIN
  PERFORM 1 FROM "Project" WHERE "id" = NEW."projectId" FOR UPDATE;
  IF (SELECT count(*) FROM "Section" WHERE "projectId" = NEW."projectId") >= 8 THEN
    RAISE EXCEPTION 'A project has at most 8 sections' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION "enforce_max_sections"() SET search_path FROM CURRENT;

CREATE OR REPLACE FUNCTION "enforce_task_section_in_project"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Section" WHERE "id" = NEW."sectionId" AND "projectId" = NEW."projectId") THEN
    RAISE EXCEPTION 'Section does not belong to the task''s project' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION "enforce_task_section_in_project"() SET search_path FROM CURRENT;
