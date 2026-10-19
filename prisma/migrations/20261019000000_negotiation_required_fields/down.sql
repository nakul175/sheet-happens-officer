-- Rollback for APL-2739: Negotiation lists no required fields again.
UPDATE "Stage" SET "requiredFields" = '{}'
WHERE "id" = 'st_pro_negotiation' AND "requiredFields" = ARRAY['value','currency'];
