import { describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const implementation = readFileSync(resolve(root, "scripts/ops/sho-2687-db-role.mjs"), "utf8");
const wrapper = readFileSync(resolve(root, "scripts/ops/sho-2687-apply.sh"), "utf8");
const runbook = readFileSync(resolve(root, "docs/runbooks/database-roles.md"), "utf8");

describe("SHO-2687 least-privilege database rollout contract", () => {
  it("keeps runtime and migration identities separate without printing secrets", () => {
    expect(implementation).toContain('parsed.get("DATABASE_URL")');
    expect(implementation).toContain('parseEnv(adminText).get("DIRECT_DATABASE_URL")');
    expect(implementation).toContain("DIRECT_DATABASE_URL must remain");
    expect(implementation).toContain("<redacted>");
    expect(implementation).not.toMatch(/console\.(?:log|error)\([^\n]*(?:password|connectionString)/i);
  });

  it("plans from a root-only env file while redacting both credentials", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "sho-2687-"));
    const envFile = resolve(dir, "app.env");
    writeFileSync(
      envFile,
      [
        'DATABASE_URL="postgresql://doadmin:runtime-secret@db.example.test:25060/pool?sslmode=require&pgbouncer=true"',
        'DIRECT_DATABASE_URL="postgresql://doadmin:direct-secret@db.example.test:25060/defaultdb?sslmode=require"',
      ].join("\n"),
    );
    chmodSync(envFile, 0o600);
    const stdout = execFileSync(process.execPath, [resolve(root, "scripts/ops/sho-2687-db-role.mjs"), "plan"], {
      encoding: "utf8",
      env: { ...process.env, SHO_2687_ENV_FILE: envFile },
    });
    expect(stdout).toContain("<redacted>");
    expect(stdout).toContain('"role":"sho_app"');
    expect(stdout).not.toContain("runtime-secret");
    expect(stdout).not.toContain("direct-secret");
  });

  it("can source cluster-admin credentials separately while pinning the staging database", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "sho-2687-admin-"));
    const envFile = resolve(dir, "staging.env");
    const adminEnvFile = resolve(dir, "admin.env");
    writeFileSync(
      envFile,
      [
        'DATABASE_URL="postgresql://sho_staging:runtime-secret@db.example.test:25060/sho_staging?sslmode=require"',
        'DIRECT_DATABASE_URL="postgresql://sho_staging:direct-secret@db.example.test:25060/sho_staging?sslmode=require"',
      ].join("\n"),
    );
    writeFileSync(
      adminEnvFile,
      'DIRECT_DATABASE_URL="postgresql://doadmin:admin-secret@db.example.test:25060/defaultdb?sslmode=require"',
    );
    chmodSync(envFile, 0o600);
    chmodSync(adminEnvFile, 0o600);
    const stdout = execFileSync(process.execPath, [resolve(root, "scripts/ops/sho-2687-db-role.mjs"), "plan"], {
      encoding: "utf8",
      env: {
        ...process.env,
        SHO_2687_ENV_FILE: envFile,
        SHO_2687_ADMIN_ENV_FILE: adminEnvFile,
        SHO_2687_ADMIN_ROLE: "doadmin",
      },
    });
    expect(stdout).toContain(`"adminEnvFile":"${adminEnvFile}"`);
    expect(stdout).toContain("doadmin:<redacted>@db.example.test:25060/sho_staging");
    expect(stdout).not.toContain("runtime-secret");
    expect(stdout).not.toContain("direct-secret");
    expect(stdout).not.toContain("admin-secret");
  });

  it("preserves the declared libpq TLS contract for managed PostgreSQL", () => {
    expect(implementation).toContain('sslmode === "require"');
    expect(implementation).toContain('parsed.searchParams.set("uselibpqcompat", "true")');
    expect(implementation).toContain("connectionString: parsed.toString()");
    expect(implementation).toContain("connection string overrides a separately supplied `ssl`");
    expect(implementation).not.toContain("NODE_TLS_REJECT_UNAUTHORIZED");
  });

  it("enforces DML-only rights and forbidden role attributes", () => {
    for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
      expect(implementation).toContain(privilege);
    }
    for (const forbidden of ["NOSUPERUSER", "NOCREATEDB", "NOCREATEROLE", "NOINHERIT", "NOREPLICATION", "NOBYPASSRLS"]) {
      expect(implementation).toContain(forbidden);
    }
    expect(implementation).toContain("REVOKE ALL ON SCHEMA");
    expect(implementation).toContain("GRANT USAGE ON SCHEMA");
    expect(implementation).toContain("ALTER DEFAULT PRIVILEGES");
    expect(implementation).toContain("GRANT CONNECT ON DATABASE");
    expect(implementation).toContain("tables_with_ddl_like_rights");
    expect(implementation).toContain("role_memberships");
    expect(implementation).toContain("REVOKE ALL PRIVILEGES ON ALL TABLES");
    expect(implementation).toContain("DDL was not denied");
  });

  it("pins the production release and verifies exact post-restart health", () => {
    expect(wrapper).toContain("SHO_2687_EXPECTED_RELEASE is required");
    expect(wrapper).toContain("SHO_2687_RELEASE_ROOT");
    expect(wrapper).toContain("selected service release changed");
    expect(wrapper).toContain('current_health="$(curl -fsS');
    expect(wrapper).toContain('health.release !== expected');
    expect(wrapper).toContain('systemctl is-active --quiet');
    expect(wrapper).toContain("prisma migrate status");
    expect(wrapper).toContain("rollback_runtime");
  });

  it("documents staging-first execution, production execution and rollback", () => {
    expect(runbook).toContain("isolated staging first");
    expect(runbook).toContain("sho_staging_app");
    expect(runbook).toContain("sho_app");
    expect(runbook).toContain("rollback");
    expect(runbook).toContain("doadmin");
  });
});
