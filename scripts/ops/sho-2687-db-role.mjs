#!/usr/bin/env node

import { chmod, copyFile, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const { Client } = require("pg");

const ROLE_RE = /^[a-z_][a-z0-9_]{0,62}$/;
const MODE = process.argv[2] ?? "verify";
const allowedModes = new Set(["plan", "apply", "verify"]);

function fail(message) {
  throw new Error(message);
}

function value(name, fallback) {
  return process.env[name] || fallback;
}

function parseEnv(text) {
  const out = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) continue;
    let raw = match[2].trim();
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      raw = raw.slice(1, -1);
    }
    out.set(match[1], raw);
  }
  return out;
}

function safeUrl(raw, name) {
  if (!raw) fail(`${name} is missing from the runtime env file.`);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail(`${name} is not a valid URL.`);
  }
  if (!/^postgres(?:ql)?:$/.test(parsed.protocol)) fail(`${name} is not a PostgreSQL URL.`);
  return parsed;
}

function quoteEnv(raw) {
  return `"${raw.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function replaceEnvValue(text, key, nextValue) {
  const line = `${key}=${quoteEnv(nextValue)}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  if (!pattern.test(text)) fail(`${key} is not declared in the selected env file; refusing to append an override.`);
  return text.replace(pattern, line);
}

function redacted(url) {
  return `${url.protocol}//${url.username}:<redacted>@${url.host}${url.pathname}`;
}

async function query(client, text, params = []) {
  return client.query({ text, values: params });
}

async function connect(connectionString, applicationName) {
  const parsed = new URL(connectionString);
  const sslmode = parsed.searchParams.get("sslmode");
  if (sslmode === "require") {
    // `sslmode` in a connection string overrides a separately supplied `ssl`
    // object in node-postgres. Use its documented compatibility flag so the
    // URL keeps libpq `require` semantics instead of being promoted to
    // `verify-full` by the current parser.
    parsed.searchParams.set("uselibpqcompat", "true");
  }
  const client = new Client({
    connectionString: parsed.toString(),
    application_name: applicationName,
  });
  await client.connect();
  return client;
}

async function roleSnapshot(admin, role, schema) {
  const roleResult = await query(
    admin,
    `SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolreplication, rolbypassrls
       FROM pg_roles WHERE rolname = $1`,
    [role],
  );
  if (roleResult.rowCount !== 1) return { exists: false };
  const privilegeResult = await query(
    admin,
    `SELECT
       (SELECT count(*)::int FROM pg_tables
          WHERE schemaname = $2
            AND NOT (has_table_privilege($1, quote_ident(schemaname)||'.'||quote_ident(tablename), 'SELECT')
                 AND has_table_privilege($1, quote_ident(schemaname)||'.'||quote_ident(tablename), 'INSERT')
                 AND has_table_privilege($1, quote_ident(schemaname)||'.'||quote_ident(tablename), 'UPDATE')
                 AND has_table_privilege($1, quote_ident(schemaname)||'.'||quote_ident(tablename), 'DELETE'))) AS tables_missing_dml,
       (SELECT count(*)::int FROM pg_sequences
          WHERE schemaname = $2
            AND NOT (has_sequence_privilege($1, quote_ident(schemaname)||'.'||quote_ident(sequencename), 'USAGE')
                 AND has_sequence_privilege($1, quote_ident(schemaname)||'.'||quote_ident(sequencename), 'SELECT')
                 AND has_sequence_privilege($1, quote_ident(schemaname)||'.'||quote_ident(sequencename), 'UPDATE'))) AS sequences_missing_dml,
       (SELECT count(*)::int FROM pg_tables
          WHERE schemaname = $2
            AND (has_table_privilege($1, quote_ident(schemaname)||'.'||quote_ident(tablename), 'TRUNCATE')
              OR has_table_privilege($1, quote_ident(schemaname)||'.'||quote_ident(tablename), 'REFERENCES')
              OR has_table_privilege($1, quote_ident(schemaname)||'.'||quote_ident(tablename), 'TRIGGER'))) AS tables_with_ddl_like_rights,
       has_schema_privilege($1, $2, 'USAGE') AS schema_usage,
       has_schema_privilege($1, $2, 'CREATE') AS schema_create,
       (SELECT count(*)::int FROM pg_auth_members WHERE member = (SELECT oid FROM pg_roles WHERE rolname = $1)) AS role_memberships`,
    [role, schema],
  );
  return { exists: true, ...roleResult.rows[0], ...privilegeResult.rows[0] };
}

async function assertLeastPrivilege(admin, role, schema) {
  const snapshot = await roleSnapshot(admin, role, schema);
  if (!snapshot.exists) fail(`${role} does not exist.`);
  for (const attribute of ["rolsuper", "rolcreatedb", "rolcreaterole", "rolreplication", "rolbypassrls"]) {
    if (snapshot[attribute]) fail(`${role} retains forbidden role attribute ${attribute}.`);
  }
  if (!snapshot.schema_usage || snapshot.schema_create) fail(`${role} schema privileges are not DML-only.`);
  if (snapshot.role_memberships !== 0) fail(`${role} belongs to ${snapshot.role_memberships} roles; refusing an indirect privilege path.`);
  if (snapshot.tables_missing_dml !== 0 || snapshot.sequences_missing_dml !== 0 || snapshot.tables_with_ddl_like_rights !== 0) {
    fail(`${role} is missing required DML rights on ${snapshot.tables_missing_dml} tables and ${snapshot.sequences_missing_dml} sequences.`);
  }
  return snapshot;
}

async function assertRuntimeConnection(connectionString, role, schema) {
  const app = await connect(connectionString, "sho-2687-runtime-verification");
  try {
    const current = await query(app, "SELECT current_user AS current_user, current_schema() AS current_schema");
    if (current.rows[0]?.current_user !== role) fail(`Runtime connected as ${current.rows[0]?.current_user}, not ${role}.`);
    await query(app, `SELECT 1 FROM ${JSON.stringify(schema)}."User" LIMIT 1`);
    let ddlDenied = false;
    await query(app, "BEGIN");
    try {
      await query(app, `CREATE TABLE ${JSON.stringify(schema)}."sho_2687_must_not_exist" (id integer)`);
    } catch (error) {
      ddlDenied = /permission denied|not authorized/i.test(String(error?.message));
    } finally {
      await query(app, "ROLLBACK");
    }
    if (!ddlDenied) {
      fail(`${role} can create tables in ${schema}; DDL was not denied.`);
    }
  } finally {
    await app.end();
  }
}

async function main() {
  if (!allowedModes.has(MODE)) fail(`Usage: ${process.argv[1]} plan|apply|verify`);

  const envFile = resolve(value("SHO_2687_ENV_FILE", "/etc/sho/app.env"));
  const backupFile = resolve(value("SHO_2687_BACKUP_FILE", `${envFile}.sho-2687-backup`));
  const receiptFile = resolve(value("SHO_2687_RECEIPT_FILE", "/var/lib/sho/sho-2687-receipt.json"));
  const role = value("SHO_2687_APP_ROLE", "sho_app");
  const schema = value("SHO_2687_SCHEMA", "public");
  const expectedAdmin = value("SHO_2687_ADMIN_ROLE", "doadmin");
  const expectedRelease = value("SHO_2687_EXPECTED_RELEASE", "");
  const service = value("SHO_2687_SERVICE", "sho.service");
  const healthUrl = value("SHO_2687_HEALTH_URL", "http://127.0.0.1:3000/api/health");
  const passwordFile = process.env.SHO_2687_PASSWORD_FILE;
  const managedRole = value("SHO_2687_MANAGED_ROLE", "false") === "true";

  if (!ROLE_RE.test(role) || !ROLE_RE.test(schema) || !ROLE_RE.test(expectedAdmin)) fail("Role/schema names must be plain PostgreSQL identifiers.");
  const stat = await lstat(envFile);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) fail(`${envFile} must be a regular file inaccessible to group/other.`);

  const originalText = await readFile(envFile, "utf8");
  const parsed = parseEnv(originalText);
  const runtimeUrl = safeUrl(parsed.get("DATABASE_URL"), "DATABASE_URL");
  const adminEnvFile = process.env.SHO_2687_ADMIN_ENV_FILE
    ? resolve(process.env.SHO_2687_ADMIN_ENV_FILE)
    : envFile;
  let adminText = originalText;
  if (adminEnvFile !== envFile) {
    const adminStat = await lstat(adminEnvFile);
    if (!adminStat.isFile() || (adminStat.mode & 0o077) !== 0) {
      fail(`${adminEnvFile} must be a regular file inaccessible to group/other.`);
    }
    adminText = await readFile(adminEnvFile, "utf8");
  }
  const directUrl = safeUrl(parseEnv(adminText).get("DIRECT_DATABASE_URL"), "DIRECT_DATABASE_URL");
  if (adminEnvFile !== envFile) {
    // A managed-cluster admin URL can name its maintenance database. Force
    // the connection back to the runtime database so grants cannot land in a
    // different database than the selected staging environment.
    directUrl.pathname = runtimeUrl.pathname;
  }
  if (directUrl.username !== expectedAdmin) fail(`DIRECT_DATABASE_URL must remain ${expectedAdmin}; found ${directUrl.username}.`);
  if (MODE === "plan") {
    console.log(JSON.stringify({ mode: MODE, envFile, adminEnvFile, runtime: redacted(runtimeUrl), direct: redacted(directUrl), role, schema, service, healthUrl, managedRole }));
    return;
  }

  let password = "";
  if (MODE === "apply") {
    if (!passwordFile) fail("SHO_2687_PASSWORD_FILE is required for apply mode.");
    const passwordStat = await lstat(passwordFile);
    if (!passwordStat.isFile() || (passwordStat.mode & 0o077) !== 0) fail("The app-password file must be inaccessible to group/other.");
    password = (await readFile(passwordFile, "utf8")).trim();
    // DigitalOcean generates 24-character passwords for managed database
    // users. Accept the provider's fixed length only when the control plane
    // owns the role; locally managed roles retain the stronger minimum.
    const minimumPasswordLength = managedRole ? 24 : 32;
    if (password.length < minimumPasswordLength) {
      fail(`The app password must contain at least ${minimumPasswordLength} characters${managedRole ? " for a managed role" : ""}.`);
    }
  }

  const admin = await connect(directUrl.toString(), "sho-2687-admin");
  let backupCreated = false;
  let envChanged = false;
  try {
    if (MODE === "apply") {
      await query(admin, "BEGIN");
      try {
        const existing = await query(admin, "SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
        if (managedRole && existing.rowCount === 0) {
          fail(`${role} must already exist because SHO_2687_MANAGED_ROLE=true.`);
        }
        if (!managedRole && existing.rowCount === 0) {
          await query(admin, `CREATE ROLE ${JSON.stringify(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS`);
        }
        if (!managedRole) {
          const passwordLiteral = (await query(admin, "SELECT quote_literal($1) AS value", [password])).rows[0].value;
          await query(admin, `ALTER ROLE ${JSON.stringify(role)} WITH LOGIN PASSWORD ${passwordLiteral} NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS`);
        }
        const database = (await query(admin, "SELECT current_database() AS value")).rows[0].value;
        await query(admin, `REVOKE ALL PRIVILEGES ON DATABASE ${JSON.stringify(database)} FROM ${JSON.stringify(role)}`);
        await query(admin, `GRANT CONNECT ON DATABASE ${JSON.stringify(database)} TO ${JSON.stringify(role)}`);
        await query(admin, `REVOKE ALL ON SCHEMA ${JSON.stringify(schema)} FROM ${JSON.stringify(role)}`);
        await query(admin, `GRANT USAGE ON SCHEMA ${JSON.stringify(schema)} TO ${JSON.stringify(role)}`);
        await query(admin, `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${JSON.stringify(schema)} FROM ${JSON.stringify(role)}`);
        await query(admin, `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${JSON.stringify(schema)} TO ${JSON.stringify(role)}`);
        await query(admin, `REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${JSON.stringify(schema)} FROM ${JSON.stringify(role)}`);
        await query(admin, `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ${JSON.stringify(schema)} TO ${JSON.stringify(role)}`);
        await query(admin, `ALTER DEFAULT PRIVILEGES FOR ROLE ${JSON.stringify(expectedAdmin)} IN SCHEMA ${JSON.stringify(schema)} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${JSON.stringify(role)}`);
        await query(admin, `ALTER DEFAULT PRIVILEGES FOR ROLE ${JSON.stringify(expectedAdmin)} IN SCHEMA ${JSON.stringify(schema)} GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${JSON.stringify(role)}`);
        await query(admin, "COMMIT");
      } catch (error) {
        await query(admin, "ROLLBACK");
        throw error;
      }

      await assertLeastPrivilege(admin, role, schema);
      const nextRuntime = new URL(runtimeUrl);
      nextRuntime.username = role;
      nextRuntime.password = password;
      await copyFile(envFile, backupFile);
      await chmod(backupFile, 0o600);
      backupCreated = true;
      const staged = `${envFile}.sho-2687-new`;
      await writeFile(staged, replaceEnvValue(originalText, "DATABASE_URL", nextRuntime.toString()), { mode: 0o600 });
      await rename(staged, envFile);
      envChanged = true;
      runtimeUrl.username = role;
      runtimeUrl.password = password;
    }

    const effectiveRuntime = MODE === "apply" ? runtimeUrl : safeUrl(parsed.get("DATABASE_URL"), "DATABASE_URL");
    if (effectiveRuntime.username !== role) fail(`DATABASE_URL still uses ${effectiveRuntime.username}, not ${role}.`);
    await assertLeastPrivilege(admin, role, schema);
    await assertRuntimeConnection(effectiveRuntime.toString(), role, schema);

    const receipt = {
      issue: "SHO-2687",
      mode: MODE,
      role,
      schema,
      runtimeUsesAppRole: true,
      directUsesAdminRole: directUrl.username === expectedAdmin,
      adminSourceSeparate: adminEnvFile !== envFile,
      managedRole,
      dmlPrivilegesVerified: true,
      ddlDenied: true,
      service,
      healthUrl,
      expectedRelease: expectedRelease || null,
      rollbackFile: backupCreated ? backupFile : null,
      verifiedAt: new Date().toISOString(),
    };
    await mkdir(dirname(receiptFile), { recursive: true, mode: 0o700 });
    await writeFile(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify(receipt));
  } catch (error) {
    if (envChanged && backupCreated) {
      await copyFile(backupFile, envFile);
      await chmod(envFile, 0o600);
      console.error("Runtime env restored from the SHO-2687 backup after failure.");
    }
    throw error;
  } finally {
    await admin.end();
  }
}

main().catch((error) => {
  console.error(`SHO-2687: ${error.message}`);
  process.exitCode = 1;
});
