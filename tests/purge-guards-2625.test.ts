import { expect, it, vi } from "vitest";
import { runPurge, type DbConnect } from "../scripts/purge-zz-test";
const safe: NodeJS.ProcessEnv = { NODE_ENV: "test", DATABASE_URL: "postgresql://test:private@localhost:5432/sho_staging", SHO_ALLOW_TEST_PURGE: "1", STAGING_WORKSPACE_ID: "owned", PROD_DB_HOST: "production.invalid", PROD_DB_NAME: "sho_prod" };
it.each([
  "/SHO_STAGING", "/sho_test", "/sho_staging/extra", "/sho_staging?host=production.invalid", "/sho_staging?dbname=sho_prod", "/sho_staging?options=-c%20search_path%3Dpublic", "/sho_staging?service=production", "/sho_staging?database=sho_prod",
])("refuses disallowed database/override %s before connecting, including dry-run", async suffix => {
  const connect = vi.fn(); const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try { expect(await runPurge({ ...safe, DATABASE_URL: `postgresql://test:private@localhost:5432${suffix}` }, ["--workspace", "owned"], connect)).toBe(1); expect(connect).not.toHaveBeenCalled(); expect(error.mock.calls.flat().join(" ")).not.toContain("private"); } finally { error.mockRestore(); }
});
it.each([false, true])("checks current_database for apply=%s before even looking up a workspace", async apply => {
  const workspace = vi.fn(); const disconnect = vi.fn();
  const connect = vi.fn(async () => ({ $queryRaw: async () => [{ name: "sho_test" }], workspace: { findUnique: workspace }, $disconnect: disconnect })) as unknown as DbConnect;
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try { expect(await runPurge(safe, ["--workspace", "owned", ...(apply ? ["--apply", "--confirm=sho_staging"] : [])], connect)).toBe(1); expect(workspace).not.toHaveBeenCalled(); expect(disconnect).toHaveBeenCalledOnce(); } finally { error.mockRestore(); }
});
