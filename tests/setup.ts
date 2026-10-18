import { assertProdHostGuard } from "../deploy/prod-host-guard.mjs";

assertProdHostGuard(process.argv, process.env);
