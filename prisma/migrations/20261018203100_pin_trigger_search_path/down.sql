-- Rollback for 20261018203100_pin_trigger_search_path.
-- Prisma does not apply this file. Run it on the direct connection (not PgBouncer)
-- after selecting the schema that was migrated:
--   SET search_path TO public;    -- prod and main staging
--   SET search_path TO sho_prN;   -- one preview slot
-- CREATE OR REPLACE keeps a function's existing search_path setting, so the
-- RESET below is what puts the previous definitions back.

CREATE OR REPLACE FUNCTION "enforce_max_sections"() RETURNS trigger AS $$
BEGIN
  PERFORM 1 FROM "Project" WHERE "id" = NEW."projectId" FOR UPDATE;
  IF (SELECT count(*) FROM "Section" WHERE "projectId" = NEW."projectId") >= 8 THEN
    RAISE EXCEPTION 'A project has at most 8 sections' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION "enforce_max_sections"() RESET search_path;

CREATE OR REPLACE FUNCTION "enforce_task_section_in_project"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Section" WHERE "id" = NEW."sectionId" AND "projectId" = NEW."projectId") THEN
    RAISE EXCEPTION 'Section does not belong to the task''s project' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION "enforce_task_section_in_project"() RESET search_path;
