CREATE TABLE "SuiteGrant" (
 "id" TEXT NOT NULL, "codeHash" TEXT NOT NULL, "accessTokenHash" TEXT,
 "userId" TEXT NOT NULL, "sessionId" TEXT NOT NULL, "challenge" TEXT NOT NULL,
 "expiresAt" TIMESTAMP(3) NOT NULL, "redeemedAt" TIMESTAMP(3),
 "accessExpiresAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "SuiteGrant_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SuiteGrant_codeHash_key" ON "SuiteGrant"("codeHash");
CREATE UNIQUE INDEX "SuiteGrant_accessTokenHash_key" ON "SuiteGrant"("accessTokenHash");
CREATE INDEX "SuiteGrant_expiresAt_idx" ON "SuiteGrant"("expiresAt");
