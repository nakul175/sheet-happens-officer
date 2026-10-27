ALTER TABLE "Project" ADD COLUMN "isVertical" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN "verticalId" TEXT;
CREATE INDEX "Project_verticalId_idx" ON "Project"("verticalId");
ALTER TABLE "Project" ADD CONSTRAINT "Project_verticalId_fkey" FOREIGN KEY ("verticalId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE UNIQUE INDEX "Project_live_vertical_name_idx" ON "Project"("workspaceId", lower("name")) WHERE "isVertical" = true AND "deletedAt" IS NULL;
