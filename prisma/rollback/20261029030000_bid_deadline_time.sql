-- Optional schema reversal for an empty/legacy-only dataset. Application rollback normally keeps the nullable columns.
-- Refuse to discard exact cutoffs. Export/retain timed metadata before considering a schema downgrade.
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "DealDetails" WHERE "submissionDeadlineAt" IS NOT NULL OR "submissionDeadlineZone" IS NOT NULL) THEN
    RAISE EXCEPTION 'Timed submission deadlines exist: retain the nullable columns or preserve their data before schema reversal';
  END IF;
END $$;
ALTER TABLE "DealDetails" DROP COLUMN "submissionDeadlineAt", DROP COLUMN "submissionDeadlineZone";
COMMIT;
