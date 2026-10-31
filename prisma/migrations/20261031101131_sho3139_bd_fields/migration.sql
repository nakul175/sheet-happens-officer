-- SHO-3139: additive nullable commercial fields; existing deals remain unknown.
-- Apply only with direct NJ approval for this exact story migration.
BEGIN;

CREATE TYPE "AthenaRole" AS ENUM ('PRIME', 'SUB', 'SOLO');

ALTER TABLE "DealDetails"
  ADD COLUMN "partner" TEXT,
  ADD COLUMN "athenaRole" "AthenaRole",
  ADD COLUMN "budgetUsd" DECIMAL(15,2),
  ADD COLUMN "pwinAdjustedNfrUsd" DECIMAL(15,2);

COMMIT;
