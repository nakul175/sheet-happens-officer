CREATE TABLE "PortalOrgRoleReceipt" (
  id UUID PRIMARY KEY,
  "actorId" TEXT NOT NULL,
  "targetId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  result JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
