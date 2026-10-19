-- Refs APL-2739 (APL-2529 AC3). moveStage refuses a stage whose requiredFields are empty on the deal,
-- but every seeded stage listed none, so no move ever asked for them. Negotiation now needs a value.
-- Currency is listed with it because a value is refused without one (normaliseValue).
-- Only a stage still at the seeded '{}' is changed. Rollback: down.sql in this directory
-- (not applied by Prisma).

UPDATE "Stage" SET "requiredFields" = ARRAY['value','currency']
WHERE "id" = 'st_pro_negotiation' AND "requiredFields" = '{}';
