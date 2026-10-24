ALTER TABLE "SuiteGrant" ADD COLUMN "clientId" TEXT NOT NULL DEFAULT 'bugoff';
CREATE TABLE "CentralSessionLink" (
  "sessionId" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "sessionUid" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CentralSessionLink_pkey" PRIMARY KEY ("sessionId"),
  CONSTRAINT "CentralSessionLink_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE
);
