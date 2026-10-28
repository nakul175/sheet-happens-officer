-- Additive intake SHO-3044 / SHO-3049. Existing deals remain explicitly unclassified/unknown.
CREATE TYPE "OpportunityType" AS ENUM ('RFP_RFA', 'EOI', 'OTC', 'CV_LTA');
CREATE TYPE "AthenaEntity" AS ENUM ('ATHENA_INDIA', 'APLYD_INDIA', 'ATHENA_USA', 'ATHENA_KENYA', 'ATHENA_UK', 'ATHENA_BANGLADESH', 'TOLADATA');
ALTER TABLE "DealDetails"
  ADD COLUMN "opportunityType" "OpportunityType",
  ADD COLUMN "athenaEntity" "AthenaEntity",
  ADD COLUMN "netFeeRevenueUsd" DECIMAL(15,2),
  ADD CONSTRAINT "DealDetails_netFeeRevenueUsd_nonnegative" CHECK ("netFeeRevenueUsd" >= 0 AND "netFeeRevenueUsd" <> 'NaN'::numeric);
