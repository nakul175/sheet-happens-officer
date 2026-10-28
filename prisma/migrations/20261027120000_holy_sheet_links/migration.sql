CREATE TABLE "HolySheetLink" (
 "id" TEXT PRIMARY KEY, "projectId" TEXT NOT NULL REFERENCES "Project"("id") ON DELETE CASCADE,
 "taskId" TEXT REFERENCES "Task"("id") ON DELETE CASCADE,
 "originKey" TEXT NOT NULL, "pageId" TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "HolySheetLink_origin_check" CHECK (("taskId" IS NULL AND "originKey"='project') OR ("taskId" IS NOT NULL AND "originKey"='task:'||"taskId"))
);
CREATE UNIQUE INDEX "HolySheetLink_projectId_originKey_pageId_key" ON "HolySheetLink"("projectId","originKey","pageId");
CREATE TABLE "HolySheetDefault" (
 "projectId" TEXT PRIMARY KEY REFERENCES "Project"("id") ON DELETE CASCADE, "spaceId" TEXT NOT NULL
);

-- A native cross-project move carries the reference; HS permissions do not change.
CREATE FUNCTION holy_sheet_task_move() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE "HolySheetLink" SET "projectId"=NEW."projectId" WHERE "taskId"=NEW.id;
 RETURN NEW;
END $$;
ALTER FUNCTION holy_sheet_task_move() SET search_path FROM CURRENT;
CREATE TRIGGER holy_sheet_task_move AFTER UPDATE OF "projectId" ON "Task"
FOR EACH ROW WHEN (OLD."projectId" IS DISTINCT FROM NEW."projectId") EXECUTE FUNCTION holy_sheet_task_move();
