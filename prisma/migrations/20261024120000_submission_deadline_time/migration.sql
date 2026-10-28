-- SHO-3054. Preserve every legacy calendar date as UTC-midnight timestamp with explicit date-only precision.
-- A separate flag distinguishes an explicit 05:30 IST deadline (also UTC midnight) from a date-only deadline.
BEGIN;
ALTER TABLE "DealDetails"
  ALTER COLUMN "submissionDeadline" TYPE TIMESTAMP(3) USING "submissionDeadline"::timestamp,
  ADD COLUMN "submissionDeadlineHasTime" BOOLEAN NOT NULL DEFAULT false;
COMMIT;
-- Do not blindly downcast to DATE: that destroys newly entered times. A data rollback must first
-- refuse/resolve hasTime=true rows and preserve their exact instant in a private reviewed manifest.
