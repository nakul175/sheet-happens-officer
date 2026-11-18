// Read-only release preflight for the owner-approved one-organisation deployment.
// It must run before any service switch, with the same effective environment as the app.
import pg from 'pg';
import { pathToFileURL } from 'node:url';

export function assessWorkspaceContract({ mode, workspaces, foreignUsers }) {
  if (mode === 'true') return 'WORKSPACE_MODE_UNAPPROVED';
  if (workspaces !== 1) return 'WORKSPACE_COUNT_INVALID';
  if (foreignUsers !== 0) return 'WORKSPACE_USER_MISMATCH';
  return null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) {
    console.error('WORKSPACE_DATABASE_URL_MISSING');
    process.exitCode = 1;
  } else {
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000, query_timeout: 8000 });
    try {
      await client.connect();
      const { rows } = await client.query(`SELECT
        (SELECT count(*)::int FROM "Workspace") AS workspaces,
        (SELECT count(*)::int FROM "User" u WHERE NOT EXISTS
          (SELECT 1 FROM "Workspace" w WHERE w.id = u."workspaceId")) AS "foreignUsers"`);
      const code = assessWorkspaceContract({ mode: process.env.SHO_MULTI_WORKSPACE_ENABLED, ...rows[0] });
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
      await client.end().catch(() => {});
    }
  }
}
