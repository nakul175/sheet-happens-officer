CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "Organisation_name_trgm_idx" ON "Organisation" USING gin (lower(name) gin_trgm_ops);
CREATE INDEX "Contact_name_trgm_idx" ON "Contact" USING gin (lower(name) gin_trgm_ops);
CREATE INDEX "Project_name_trgm_idx" ON "Project" USING gin (lower(name) gin_trgm_ops);
CREATE TABLE "DuplicateDismissal" (
  "workspaceId" TEXT NOT NULL REFERENCES "Workspace"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('organisation', 'contact')),
  "leftId" TEXT NOT NULL,
  "rightId" TEXT NOT NULL,
  "dismissedById" TEXT NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("workspaceId", kind, "leftId", "rightId"),
  CHECK ("leftId" < "rightId")
);
