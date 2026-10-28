CREATE TABLE "TaskAttachment" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "taskId" TEXT NOT NULL,
 "filename" TEXT NOT NULL,
 "mimeType" TEXT NOT NULL,
 "size" INTEGER NOT NULL,
 "storageKey" TEXT NOT NULL,
 "uploadedById" TEXT NOT NULL,
 "removedAt" TIMESTAMP(3),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "TaskAttachment_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "TaskAttachment_size_check" CHECK ("size" >= 0)
);
CREATE UNIQUE INDEX "TaskAttachment_storageKey_key" ON "TaskAttachment"("storageKey");
CREATE INDEX "TaskAttachment_taskId_removedAt_idx" ON "TaskAttachment"("taskId", "removedAt");
CREATE INDEX "TaskAttachment_removedAt_idx" ON "TaskAttachment"("removedAt");
