import { assertProdHostGuard } from "../deploy/prod-host-guard.mjs";

// The guard fails closed until the production database is named. These placeholders
// are not a real host. Values already set by a run are left alone, so a production
// target is still refused.
if (!process.env.PROD_DB_HOST?.trim()) process.env.PROD_DB_HOST = "prod-db.invalid";
if (!process.env.PROD_DB_NAME?.trim()) process.env.PROD_DB_NAME = "prod_placeholder";

assertProdHostGuard(process.argv, process.env);
