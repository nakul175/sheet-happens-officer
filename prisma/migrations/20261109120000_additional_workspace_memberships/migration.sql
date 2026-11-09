-- Additive only: no existing account, role, session or business row is updated.
CREATE UNIQUE INDEX "Session_id_userId_key" ON "Session"(id,"userId");
CREATE TABLE "WorkspaceMembership" (
 "userId" TEXT NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT,
 "workspaceId" TEXT NOT NULL REFERENCES "Workspace"(id) ON DELETE RESTRICT,
 role "OrgRole" NOT NULL DEFAULT 'MEMBER' CHECK (role IN ('MEMBER','ADMIN')),
 generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
 "revokedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY ("userId","workspaceId")
);
CREATE INDEX "WorkspaceMembership_workspaceId_revokedAt_idx" ON "WorkspaceMembership"("workspaceId","revokedAt");
CREATE TABLE "SessionWorkspace" (
 "sessionId" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL,
 generation INTEGER NOT NULL CHECK (generation > 0),
 "selectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY ("sessionId","userId") REFERENCES "Session"(id,"userId") ON DELETE CASCADE,
 FOREIGN KEY ("userId") REFERENCES "User"(id) ON DELETE RESTRICT,
 FOREIGN KEY ("userId","workspaceId") REFERENCES "WorkspaceMembership"("userId","workspaceId") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "SessionWorkspace_sessionId_userId_key" ON "SessionWorkspace"("sessionId","userId");
CREATE TABLE "PortalWorkspaceReceipt" (
 id TEXT PRIMARY KEY, "actorId" TEXT NOT NULL, "targetId" TEXT NOT NULL,
 "workspaceId" TEXT NOT NULL, result JSONB NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- Never allow a second authority row for the person's original workspace.
CREATE FUNCTION sho_additional_workspace_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS (SELECT 1 FROM "User" WHERE id=NEW."userId" AND "workspaceId"=NEW."workspaceId") THEN
  RAISE EXCEPTION 'Original workspace authority must remain on User' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sho_additional_workspace_only BEFORE INSERT OR UPDATE ON "WorkspaceMembership"
 FOR EACH ROW EXECUTE FUNCTION sho_additional_workspace_only();
