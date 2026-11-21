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

// Production uses separate app and migration identities. Never certify a cut
// while the running app still has the provider's DDL-capable administrator URL.
export function assessRuntimeRole({ runtimeUrl, directUrl, role }) {
  let runtime, direct;
  try {
    runtime = new URL(runtimeUrl);
    direct = new URL(directUrl);
  } catch { return 'RUNTIME_ROLE_URL_INVALID'; }
  if (!['postgres:', 'postgresql:'].includes(runtime.protocol) ||
      !['postgres:', 'postgresql:'].includes(direct.protocol) ||
      decodeURIComponent(runtime.username) !== 'sho_app' ||
      decodeURIComponent(direct.username) === decodeURIComponent(runtime.username) ||
      role?.connectedUser !== decodeURIComponent(runtime.username)) return 'RUNTIME_ROLE_IDENTITY_INVALID';
  if (role.privilegedAttributes || role.databaseCreate || role.schemaCreate ||
      role.roleMemberships !== 0 || role.ownedTables !== 0 || role.tablesWithDdlLikeRights !== 0)
    return 'RUNTIME_ROLE_PRIVILEGED';
  if (!role.schemaUsage || role.tablesTotal < 1 || role.tablesMissingDml !== 0)
    return 'RUNTIME_ROLE_GRANTS_INCOMPLETE';
  return null;
}

/** Preserve the URL's declared libpq `require` TLS semantics in node-postgres. */
export function runtimeConnectionString(raw) {
  const url = new URL(raw);
  if (url.searchParams.get('sslmode') === 'require') url.searchParams.set('uselibpqcompat', 'true');
  return url.toString();
}

export async function readRuntimeRole(client) {
  const { rows } = await client.query(`SELECT current_user AS "connectedUser",
    (SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls
      FROM pg_roles WHERE rolname=current_user) AS "privilegedAttributes",
    has_database_privilege(current_user,current_database(),'create') AS "databaseCreate",
    has_schema_privilege(current_user,'public','usage') AS "schemaUsage",
    has_schema_privilege(current_user,'public','create') AS "schemaCreate",
    (SELECT count(*)::int FROM pg_roles WHERE rolname<>current_user
      AND pg_has_role(current_user,oid,'member')) AS "roleMemberships",
    (SELECT count(*)::int FROM pg_tables WHERE schemaname='public'
      AND tablename<>'_prisma_migrations') AS "tablesTotal",
    (SELECT count(*)::int FROM pg_tables WHERE schemaname='public'
      AND tablename<>'_prisma_migrations' AND tableowner=current_user) AS "ownedTables",
    (SELECT count(*)::int FROM pg_tables WHERE schemaname='public'
      AND tablename<>'_prisma_migrations' AND NOT (
        has_table_privilege(current_user,format('%I.%I',schemaname,tablename),'select') AND
        has_table_privilege(current_user,format('%I.%I',schemaname,tablename),'insert') AND
        has_table_privilege(current_user,format('%I.%I',schemaname,tablename),'update') AND
        has_table_privilege(current_user,format('%I.%I',schemaname,tablename),'delete'))) AS "tablesMissingDml",
    (SELECT count(*)::int FROM pg_tables WHERE schemaname='public'
      AND tablename<>'_prisma_migrations' AND (
        has_table_privilege(current_user,format('%I.%I',schemaname,tablename),'truncate') OR
        has_table_privilege(current_user,format('%I.%I',schemaname,tablename),'references') OR
        has_table_privilege(current_user,format('%I.%I',schemaname,tablename),'trigger'))) AS "tablesWithDdlLikeRights"`);
  return rows[0];
}

export async function readWorkspaceCounts(client) {
  const { rows } = await client.query(`SELECT
    (SELECT count(*)::int FROM "Workspace") AS workspaces,
    (SELECT count(*)::int FROM "User" u WHERE NOT EXISTS
      (SELECT 1 FROM "Workspace" w WHERE w.id = u."workspaceId")) AS "foreignUsers"`);
  return rows[0];
}

const protectedFunctions = [
  'enforce_max_sections',
  'enforce_task_section_in_project',
  'holy_sheet_task_move',
];

export function assessFunctionSearchPaths(rows) {
  if (rows.length !== protectedFunctions.length) return 'CUSTOM_FUNCTION_PATH_DRIFT';
  const configs = new Map(rows.map(({ name, config }) => [name, config]));
  if (configs.size !== protectedFunctions.length) return 'CUSTOM_FUNCTION_PATH_DRIFT';
  return protectedFunctions.every((name) => configs.get(name) === 'search_path=public')
    ? null : 'CUSTOM_FUNCTION_PATH_DRIFT';
}

export async function readFunctionSearchPaths(client) {
  const { rows } = await client.query(`SELECT p.proname AS name,
    coalesce(array_to_string(p.proconfig, ','), '') AS config
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])`, [protectedFunctions]);
  return rows;
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
      client = new pg.Client({ connectionString: runtimeConnectionString(url), connectionTimeoutMillis: 5000, query_timeout: 8000 });
      await client.connect();
      const roleCode = process.env.NODE_ENV === 'production'
        ? assessRuntimeRole({ runtimeUrl: url, directUrl: process.env.DIRECT_DATABASE_URL,
            role: await readRuntimeRole(client) }) : null;
      const counts = roleCode ? null : await readWorkspaceCounts(client);
      const code = roleCode ?? assessWorkspaceContract({ mode: process.env.SHO_MULTI_WORKSPACE_ENABLED, ...counts })
        ?? assessFunctionSearchPaths(await readFunctionSearchPaths(client));
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
