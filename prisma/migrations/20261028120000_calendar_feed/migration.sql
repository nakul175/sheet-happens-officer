-- FEED subscriptions never expire; VERIFY/RESET still require an expiry in the application.
ALTER TYPE "AuthTokenType" ADD VALUE 'FEED';
ALTER TABLE "AuthToken" ALTER COLUMN "expiresAt" DROP NOT NULL;
