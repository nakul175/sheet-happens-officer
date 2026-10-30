-- UNAPPLIED REVIEW DRAFT: SHO-2587. NOT a Prisma migration.
-- NJ migration hold remains in force. Do not execute anywhere until NJ YES.
-- Jim/Oscar must review pg_trgm availability/privileges, build time and lock
-- behavior on an isolated acceptance copy before selecting a production cut.
-- These expression indexes match the query expressions exactly; no business
-- columns, user data, grants, suite routes or provider configuration change.
-- This transactional draft is suitable for a disposable database ONLY after
-- approval. For a populated production database, separately review concurrent
-- index creation outside a transaction and its failure/retry cleanup.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX sho2587_task_title_fts ON "Task" USING gin (to_tsvector('english', title)) WHERE "deletedAt" IS NULL;
CREATE INDEX sho2587_task_title_trgm ON "Task" USING gin (lower(title) gin_trgm_ops) WHERE "deletedAt" IS NULL;
CREATE INDEX sho2587_task_description_fts ON "Task" USING gin (to_tsvector('english', COALESCE(description,''))) WHERE "deletedAt" IS NULL;
CREATE INDEX sho2587_task_description_trgm ON "Task" USING gin (lower(COALESCE(description,'')) gin_trgm_ops) WHERE "deletedAt" IS NULL;
CREATE INDEX sho2587_project_name_fts ON "Project" USING gin (to_tsvector('english', name)) WHERE "deletedAt" IS NULL;
CREATE INDEX sho2587_project_name_trgm ON "Project" USING gin (lower(name) gin_trgm_ops) WHERE "deletedAt" IS NULL;
CREATE INDEX sho2587_project_description_fts ON "Project" USING gin (to_tsvector('english', COALESCE(description,''))) WHERE "deletedAt" IS NULL;
CREATE INDEX sho2587_project_description_trgm ON "Project" USING gin (lower(COALESCE(description,'')) gin_trgm_ops) WHERE "deletedAt" IS NULL;
CREATE INDEX sho2587_deal_details_fts ON "DealDetails" USING gin (to_tsvector('english', "whyPursue" || ' ' || COALESCE(need,'') || ' ' || COALESCE("serviceLine",'') || ' ' || COALESCE("introducedBy",'')));
CREATE INDEX sho2587_deal_details_trgm ON "DealDetails" USING gin (lower("whyPursue" || ' ' || COALESCE(need,'') || ' ' || COALESCE("serviceLine",'') || ' ' || COALESCE("introducedBy",'')) gin_trgm_ops);
CREATE INDEX sho2587_organisation_name_fts ON "Organisation" USING gin (to_tsvector('english', name));
CREATE INDEX sho2587_organisation_name_trgm ON "Organisation" USING gin (lower(name) gin_trgm_ops);
CREATE INDEX sho2587_organisation_details_fts ON "Organisation" USING gin (to_tsvector('english', COALESCE(kind,'') || ' ' || COALESCE(country,'')));
CREATE INDEX sho2587_organisation_details_trgm ON "Organisation" USING gin (lower(COALESCE(kind,'') || ' ' || COALESCE(country,'')) gin_trgm_ops);
CREATE INDEX sho2587_contact_name_fts ON "Contact" USING gin (to_tsvector('english', name)) WHERE "removedAt" IS NULL;
CREATE INDEX sho2587_contact_name_trgm ON "Contact" USING gin (lower(name) gin_trgm_ops) WHERE "removedAt" IS NULL;
CREATE INDEX sho2587_contact_details_fts ON "Contact" USING gin (to_tsvector('english', COALESCE(role,'') || ' ' || COALESCE(email,'') || ' ' || COALESCE(phone,''))) WHERE "removedAt" IS NULL;
CREATE INDEX sho2587_contact_details_trgm ON "Contact" USING gin (lower(COALESCE(role,'') || ' ' || COALESCE(email,'') || ' ' || COALESCE(phone,'')) gin_trgm_ops) WHERE "removedAt" IS NULL;
CREATE INDEX sho2587_note_text_fts ON "Note" USING gin (to_tsvector('english', text)) WHERE "removedAt" IS NULL;
CREATE INDEX sho2587_note_text_trgm ON "Note" USING gin (lower(text) gin_trgm_ops) WHERE "removedAt" IS NULL;
COMMIT;

-- Rollback of application behavior: unset SEARCH_STAGE_A_ENABLED (default off).
-- Retain additive indexes during application rollback; separately approved
-- cleanup may drop only the sho2587_* indexes. Never drop pg_trgm blindly:
-- other applications/indexes can depend on the extension.
