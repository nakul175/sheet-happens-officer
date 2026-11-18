// Read-only release preflight for the owner-approved one-organisation deployment.
// It must run before any service switch, with the same effective environment as the app.
import { pathToFileURL } from 'node:url';

export function assessWorkspaceContract({ mode, workspaces, foreignUsers }) {
  if (mode === 'true') return 'WORKSPACE_MODE_UNAPPROVED';
  if (workspaces !== 1) return 'WORKSPACE_COUNT_INVALID';
  if (foreignUsers !== 0) return 'WORKSPACE_USER_MISMATCH';
  return null;
}

export const runtimeDatabaseUrl = (env) => env.DATABASE_URL || null;

export async function readWorkspaceCounts(client) {
  const { rows } = await client.query(`SELECT
    (SELECT count(*)::int FROM "Workspace") AS workspaces,
    (SELECT count(*)::int FROM "User" u WHERE NOT EXISTS
      (SELECT 1 FROM "Workspace" w WHERE w.id = u."workspaceId")) AS "foreignUsers"`);
  return rows[0];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // The app authenticates through DATABASE_URL. An admin/direct URL may point
  // elsewhere and must never certify the runtime database by proxy.
  const url = runtimeDatabaseUrl(process.env);
  if (!url) {
    console.error('WORKSPACE_DATABASE_URL_MISSING');
    process.exitCode = 1;
  } else {
    let client;
    try {
      // Node script tests import the pure guard before npm ci; runtime dependencies
      // are installed before release.sh executes this preflight.
      const { default: pg } = await import('pg');
      client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000, query_timeout: 8000 });
      await client.connect();
      const counts = await readWorkspaceCounts(client);
      const code = assessWorkspaceContract({ mode: process.env.SHO_MULTI_WORKSPACE_ENABLED, ...counts });
      if (code) {
        console.error(code);
        process.exitCode = 1;
      } else {
        console.log('WORKSPACE_CONTRACT_OK');
      }
    } catch {
      // Avoid printing connection strings, SQL error details, or database identifiers.
      console.error('WORKSPACE_PREFLIGHT_UNAVAILABLE');
      process.exitCode = 1;
    } finally {
      await client?.end().catch(() => {});
    }
  }
}
