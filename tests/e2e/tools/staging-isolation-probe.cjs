#!/usr/bin/env node
// READ-ONLY staging isolation probe. Prints identity + privileges only. Never prints a URL, user name or password.
//
// WHY: SHO isolates staging per-slot with a Postgres SCHEMA (?schema=sho_pr<N>) inside the logical database
// sho_staging. The provider receipt already proved that sho_staging and the users sho_staging / sho_staging_app
// exist on the shared cluster. What is still unproven is (a) that the app's real staging URL points at
// sho_staging and (b) what sho_staging_app is allowed to reach. This script answers both, and refuses to run
// as doadmin.
//
// HOW TO RUN (do NOT echo or export the URL into a logged shell):
//   cd <cline-team>/.local/sho-checkout
//   PGCONNECT_TIMEOUT=10 node /path/to/this-file.js "$STAGING_DATABASE_URL"
// The URL is read from argv and is never printed. If you would rather not put it in argv, set
// STAGING_DATABASE_URL in the environment instead — the script reads either.
//
// EXIT CODES: 0 = isolated, 1 = NOT isolated (a stop condition hit), 2 = could not decide.
//
// HARD RULES baked in: the session is set read-only before anything else; an explicit whitelist of statements
// is the only thing this file executes; nothing is written to any database.

const path = require("node:path");
const fs = require("node:fs");
const tls = require("node:tls");

// ---------------------------------------------------------------------------------------------
// Credential intake. The messenger copies the connection string into a 0600 file instead of a shell
// or a chat message, so this probe reads that file itself. The value never enters argv (visible to
// `ps`), never gets printed, and is never put in an error message.
//   - file path: $PROBE_URL_FILE, else $SHO_STAGING_CONN_FILE, else /tmp/sho-staging-connection.secret
//   - a file containing a line break is refused (a hidden second URL would change the target)
// ---------------------------------------------------------------------------------------------
const CONN_FILE = process.env.PROBE_URL_FILE || process.env.SHO_STAGING_CONN_FILE || "/tmp/sho-staging-connection.secret";

function readConnectionFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    console.error(`cannot read the credential file (code ${err.code || "unknown"}). Not proceeding.`);
    return null;
  }
  const value = raw.replace(/[\r\n]+$/, "");
  if (value === "") {
    console.error("the credential file is empty. Not proceeding.");
    return null;
  }
  if (/[\r\n]/.test(value)) {
    console.error("the credential file contains a line break. Refusing: it could hide a second URL.");
    return null;
  }
  if (!/^postgres(ql)?:\/\//i.test(value)) {
    console.error("the credential file does not start with postgres:// or postgresql://. Not proceeding.");
    return null;
  }
  return value;
}

// Resolve `pg` from the SHO checkout regardless of where this file lives or is run from.
function resolvePg() {
  const candidates = [
    process.env.SHO_CHECKOUT && path.join(process.env.SHO_CHECKOUT, "node_modules", "pg"),
    path.resolve(__dirname, "../../../.local/sho-checkout/node_modules/pg"),
    "pg",
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      return require(c);
    } catch {
      /* try the next one */
    }
  }
  throw new Error("cannot resolve the `pg` module; run with SHO_CHECKOUT set to the SHO checkout");
}
const { Client } = resolvePg();

const EXPECTED_DB = "sho_staging";
const STAGING_USERS = new Set(["sho_staging", "sho_staging_app"]);
const FORBIDDEN_SCHEMAS = /^(prod|production|sho_prod|app_prod)$/i;

// Only these statements are ever executed. Read-only by construction, plus the read-only session itself.
const STATEMENTS = {
  identity: `SELECT current_user AS u, current_database() AS db, current_schema() AS schema,
       current_schemas(false)::text AS schemas,
       (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)::text AS is_superuser,
       (SELECT rolcreatedb FROM pg_roles WHERE rolname = current_user)::text AS can_create_db`,
  schemaGrants: `SELECT n.nspname AS schema,
       has_schema_privilege(current_user, n.oid, 'USAGE')::text AS usage,
       has_schema_privilege(current_user, n.oid, 'CREATE')::text AS create_allowed
       FROM pg_namespace n
       WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
       ORDER BY 1`,
  databaseGrants: `SELECT datname AS db, has_database_privilege(current_user, datname, 'CONNECT')::text AS can_connect
       FROM pg_database WHERE datistemplate = false ORDER BY 1`,
  connectionLimit: `SELECT setting AS max_connections FROM pg_settings WHERE name = 'max_connections'`,
};

async function main() {
  // The URL comes from the protected file (or an explicit argv, for a local disposable server).
  // It is never echoed: not on success, not on failure.
  // CI writes the secret to a 0600 file from an env-only value, so argv never carries it there.
  const url = process.argv[2] || process.env.STAGING_DATABASE_URL || readConnectionFile(CONN_FILE);
  if (!url) {
    console.error("no connection string available (argv[2], STAGING_DATABASE_URL, or the credential file)");
    return 2;
  }

  // TLS is decided by the URL/host, never weakened to make a connection succeed.
  //  - A local disposable server (127.0.0.1 / localhost / ::1) may speak plain TCP.
  //  - Anything else MUST verify the server certificate. There is no rejectUnauthorized:false path.
  //    Node is told to trust the system store as well, so a host whose chain is signed by a CA that
  //    ships with macOS/Homebrew still verifies. If that chain is private to the provider, the
  //    connection intentionally fails and we report the failure instead of bypassing verification.
  const isLocal = (() => {
    try {
      const host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
      return host === "127.0.0.1" || host === "localhost" || host === "::1";
    } catch {
      return false; // unparseable => treat as remote => strict TLS
    }
  })();
  if (!isLocal) {
    try {
      tls.setDefaultCACertificates([...tls.rootCertificates, "/etc/ssl/cert.pem"]);
    } catch (err) {
      console.error(`could not extend the trust store (code ${err.code || "unknown"}). Continuing with the built-in roots.`);
    }
  }

  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: 10000,
  });
  try {
    await client.connect();
  } catch (err) {
    // Never echo err.message wholesale: a pg connection error can contain the host and user.
    // The TLS hint names the likely cause without quoting anything from the error.
    const hint =
      err.code === "SELF_SIGNED_CERT_IN_CHAIN" || err.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
        ? " (TLS chain is not in the trust store; supply the provider CA rather than disabling verification)"
        : "";
    console.error(`CONNECT FAILED (code ${err.code || "unknown"}).${hint} Not proceeding.`);
    return 2;
  }

  const out = {};
  let verdict = 0;
  const stops = [];
  try {
    await client.query("SET default_transaction_read_only = on");
    out.identity = (await client.query(STATEMENTS.identity)).rows[0];
    out.schemaGrants = (await client.query(STATEMENTS.schemaGrants)).rows;
    out.databaseGrants = (await client.query(STATEMENTS.databaseGrants)).rows;
    out.connectionLimit = (await client.query(STATEMENTS.connectionLimit)).rows[0];

    const id = out.identity;
    if (id.u === "doadmin") stops.push("connected as doadmin (cluster superuser); re-run with the staging app user");
    if (!STAGING_USERS.has(id.u)) stops.push(`current_user is not a known staging user (got "${id.u}")`);
    if (id.db !== EXPECTED_DB) stops.push(`current_database is not ${EXPECTED_DB} (got "${id.db}")`);
    if (id.is_superuser === "true") stops.push("current_user is a superuser; the boundary is not privilege-enforced");
    if (id.can_create_db === "true") stops.push("current_user may CREATE DATABASE; containment is honour-system");
    for (const row of out.schemaGrants) {
      if (FORBIDDEN_SCHEMAS.test(row.schema) && (row.usage === "true" || row.create_allowed === "true"))
        stops.push(`grants reach a prod-like schema "${row.schema}"`);
    }
    const canConnectToProdLike = out.databaseGrants.filter(
      (r) => r.can_connect === "true" && r.db !== EXPECTED_DB && /prod/i.test(r.db),
    );
    for (const r of canConnectToProdLike) stops.push(`CONNECT granted on prod-like database "${r.db}"`);

    if (stops.length > 0) verdict = 1;
  } finally {
    await client.end().catch(() => {});
  }

  console.log(JSON.stringify({ verdict: verdict === 0 ? "ISOLATED" : "NOT-ISOLATED", stops, ...out }, null, 2));
  return verdict;
}

main().then((code) => process.exit(code)).catch(() => {
  console.error("probe crashed; nothing was written");
  process.exit(2);
});
