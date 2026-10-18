// Backup the direct database before a production migration.
// The connection string stays in this process. pg_dump receives host, port, user and
// password through its environment, not on the command line, and this script never prints them.
import { spawn } from "node:child_process";
import { chmod } from "node:fs";

const out = process.argv[2];
if (!out) {
  console.error("backup path is missing");
  process.exit(1);
}
const raw = process.env.DIRECT_DATABASE_URL ?? "";
if (!raw) {
  console.error("DIRECT_DATABASE_URL is not set");
  process.exit(1);
}

let url;
try {
  url = new URL(raw);
} catch {
  console.error("DIRECT_DATABASE_URL is not a valid connection URL");
  process.exit(1);
}
if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
  console.error("DIRECT_DATABASE_URL must be a postgres URL");
  process.exit(1);
}
const port = url.port || "5432";
if (port === "25061" || url.searchParams.get("pgbouncer") === "true") {
  console.error("refusing to dump through the PgBouncer pool");
  process.exit(1);
}
if (!url.hostname || !url.username || !url.password) {
  console.error("DIRECT_DATABASE_URL is missing a host, user or password");
  process.exit(1);
}
const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
if (!database) {
  console.error("DIRECT_DATABASE_URL is missing a database name");
  process.exit(1);
}

process.umask(0o077);
const env = { ...process.env };
delete env.DATABASE_URL;
delete env.DIRECT_DATABASE_URL;
env.PGHOST = url.hostname;
env.PGPORT = port;
env.PGUSER = decodeURIComponent(url.username);
env.PGPASSWORD = decodeURIComponent(url.password);
env.PGDATABASE = database;
env.PGSSLMODE = url.searchParams.get("sslmode") || "require";

const child = spawn(
  "pg_dump",
  ["--format=custom", "--no-owner", "--no-acl", "--file", out],
  { env, stdio: ["ignore", "inherit", "inherit"] },
);
child.on("error", () => {
  console.error("pg_dump could not be started");
  process.exit(1);
});
child.on("exit", (code) => {
  if (code !== 0) process.exit(code ?? 1);
  chmod(out, 0o600, () => process.exit(0));
});
