// Name the pending Prisma migrations and refuse a production deploy when one is not expand-only.
// A migration is expand-only when migration.sql has a comment line "-- expand-only",
// or the migration directory contains an empty file named expand-only.
// Prints nothing about the database. Exit 0 when there is nothing to block.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const statusFile = process.argv[2];
const migrationsDir = process.argv[3];
if (!statusFile || !migrationsDir) {
  console.error("migration check needs a status file and a migrations directory");
  process.exit(1);
}

const text = readFileSync(statusFile, "utf8");
if (/Database schema is up to date/.test(text)) process.exit(0);

const names = [...text.matchAll(/^[0-9]{14}_[A-Za-z0-9_]+$/gm)].map((match) => match[0]);
if (names.length === 0) {
  console.error("pending migrations could not be named");
  process.exit(4);
}

function expandOnly(name) {
  const dir = path.join(migrationsDir, name);
  if (existsSync(path.join(dir, "expand-only"))) return true;
  const sqlPath = path.join(dir, "migration.sql");
  if (!existsSync(sqlPath)) return false;
  return readFileSync(sqlPath, "utf8").split(/\r?\n/).some((line) => /^\s*--\s*expand-only\b/.test(line));
}

const blocked = names.filter((name) => !expandOnly(name));
console.log(`pending migrations: ${names.join(" ")}`);
if (blocked.length > 0) {
  console.error(`migrations without an expand-only marker: ${blocked.join(" ")}`);
  process.exit(3);
}
console.log("expand-only: yes");
