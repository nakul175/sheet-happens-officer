-- Nullable expansion: legacy calendar dates are unchanged, with no inferred cutoff.
ALTER TABLE "DealDetails" ADD COLUMN "submissionDeadlineAt" TIMESTAMPTZ(3), ADD COLUMN "submissionDeadlineZone" TEXT;
