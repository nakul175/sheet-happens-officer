-- SHO-US-9.2: the weekly cap counts messages, not model calls. One row per sent message is marked.
ALTER TABLE "ModelUsage" ADD COLUMN "counted" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "ModelUsage_userId_counted_createdAt_idx" ON "ModelUsage"("userId", "counted", "createdAt");
