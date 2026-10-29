CREATE TABLE "ScreenSavedView" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspaceId" TEXT NOT NULL REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "screen" TEXT NOT NULL CHECK ("screen" IN ('DEALS', 'ACCOUNTS', 'REVIEW')),
  "name" TEXT NOT NULL,
  "scope" TEXT NOT NULL DEFAULT 'PRIVATE' CHECK ("scope" IN ('PRIVATE', 'WORKSPACE', 'PROJECT')),
  "projectId" TEXT REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "state" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ScreenSavedView_scope_project" CHECK (("scope" = 'PROJECT') = ("projectId" IS NOT NULL))
);
CREATE INDEX "ScreenSavedView_workspaceId_screen_scope_idx" ON "ScreenSavedView"("workspaceId", "screen", "scope");
CREATE INDEX "ScreenSavedView_userId_screen_idx" ON "ScreenSavedView"("userId", "screen");
CREATE INDEX "ScreenSavedView_projectId_idx" ON "ScreenSavedView"("projectId");
