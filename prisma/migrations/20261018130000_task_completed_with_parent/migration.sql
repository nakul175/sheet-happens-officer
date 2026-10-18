-- APL-2610 AC4 / APL-2671: mark subtasks closed because their parent closed, so only those reopen with it.
ALTER TABLE "Task" ADD COLUMN "completedWithParent" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: a cascade closes the parent and its subtasks with the same timestamp; a subtask ticked done on its own never shares it.
UPDATE "Task" AS s SET "completedWithParent" = true
FROM "Task" AS p
WHERE s."parentId" = p."id" AND s."completedAt" IS NOT NULL AND s."completedAt" = p."completedAt";
