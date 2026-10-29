DROP INDEX IF EXISTS "Note_search_trgm_idx";
DROP INDEX IF EXISTS "Note_search_fts_idx";
DROP INDEX IF EXISTS "Contact_search_trgm_idx";
DROP INDEX IF EXISTS "Contact_search_fts_idx";
DROP INDEX IF EXISTS "Organisation_search_trgm_idx";
DROP INDEX IF EXISTS "Organisation_search_fts_idx";
DROP INDEX IF EXISTS "Project_search_trgm_idx";
DROP INDEX IF EXISTS "Project_search_fts_idx";
DROP INDEX IF EXISTS "Task_search_trgm_idx";
DROP INDEX IF EXISTS "Task_search_fts_idx";
-- pg_trgm may be shared by other objects; rollback deliberately leaves it installed.
