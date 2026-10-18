-- APL-2669: task edits carry a positive integer version.
ALTER TABLE "Task" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
