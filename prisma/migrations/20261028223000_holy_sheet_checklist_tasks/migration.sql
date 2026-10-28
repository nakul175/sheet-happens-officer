CREATE TABLE "HolySheetTaskIntent" (
    "intentId" UUID NOT NULL,
    "subject" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "sourcePageId" TEXT NOT NULL,
    "sourceItemId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "HolySheetTaskIntent_pkey" PRIMARY KEY ("intentId")
);

CREATE UNIQUE INDEX "HolySheetTaskIntent_taskId_key" ON "HolySheetTaskIntent"("taskId");
CREATE INDEX "HolySheetTaskIntent_subject_createdAt_idx" ON "HolySheetTaskIntent"("subject", "createdAt");
CREATE INDEX "HolySheetTaskIntent_projectId_createdAt_idx" ON "HolySheetTaskIntent"("projectId", "createdAt");

ALTER TABLE "HolySheetTaskIntent" ADD CONSTRAINT "HolySheetTaskIntent_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HolySheetTaskIntent" ADD CONSTRAINT "HolySheetTaskIntent_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HolySheetTaskIntent" ADD CONSTRAINT "HolySheetTaskIntent_taskId_fkey"
  FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
