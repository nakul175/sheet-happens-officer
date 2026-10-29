-- SHO-2587 Stage A: indexed keyword/stem/trigram search. No embeddings/provider.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "Task_search_fts_idx" ON "Task" USING GIN (to_tsvector('english', coalesce("title", '') || ' ' || coalesce("description", ''))) WHERE "deletedAt" IS NULL;
CREATE INDEX "Task_search_trgm_idx" ON "Task" USING GIN (lower(coalesce("title", '') || ' ' || coalesce("description", '')) gin_trgm_ops) WHERE "deletedAt" IS NULL;
CREATE INDEX "Project_search_fts_idx" ON "Project" USING GIN (to_tsvector('english', coalesce("name", '') || ' ' || coalesce("description", '')));
CREATE INDEX "Project_search_trgm_idx" ON "Project" USING GIN (lower(coalesce("name", '') || ' ' || coalesce("description", '')) gin_trgm_ops);
CREATE INDEX "Organisation_search_fts_idx" ON "Organisation" USING GIN (to_tsvector('english', coalesce("name", '') || ' ' || coalesce("kind", '') || ' ' || coalesce("country", '')));
CREATE INDEX "Organisation_search_trgm_idx" ON "Organisation" USING GIN (lower(coalesce("name", '') || ' ' || coalesce("kind", '') || ' ' || coalesce("country", '')) gin_trgm_ops);
CREATE INDEX "Contact_search_fts_idx" ON "Contact" USING GIN (to_tsvector('english', coalesce("name", '') || ' ' || coalesce("role", '') || ' ' || coalesce("email", '') || ' ' || coalesce("phone", ''))) WHERE "removedAt" IS NULL;
CREATE INDEX "Contact_search_trgm_idx" ON "Contact" USING GIN (lower(coalesce("name", '') || ' ' || coalesce("role", '') || ' ' || coalesce("email", '') || ' ' || coalesce("phone", '')) gin_trgm_ops) WHERE "removedAt" IS NULL;
CREATE INDEX "Note_search_fts_idx" ON "Note" USING GIN (to_tsvector('english', coalesce("text", ''))) WHERE "removedAt" IS NULL;
CREATE INDEX "Note_search_trgm_idx" ON "Note" USING GIN (lower(coalesce("text", '')) gin_trgm_ops) WHERE "removedAt" IS NULL;
