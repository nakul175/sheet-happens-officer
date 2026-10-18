import { existsSync } from "node:fs";
import { defineConfig, env } from "prisma/config";

// Local `prisma` commands read .env. The release tarball omits devDependencies, so this does not
// import dotenv. On the droplet the release script exports the variables before migrating.
if (existsSync(".env")) process.loadEnvFile();

// DIRECT_DATABASE_URL bypasses PgBouncer for migrations; it falls back to DATABASE_URL while unset.
// Set on process.env (not just below) because the CLI still validates env("DIRECT_DATABASE_URL") in schema.prisma.
// Production release.sh refuses to migrate unless DIRECT_DATABASE_URL is set to the direct database.
process.env.DIRECT_DATABASE_URL ||= process.env.DATABASE_URL;

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  engine: "classic",
  // Overrides the url and directUrl in schema.prisma, so directUrl must be set here too.
  datasource: {
    url: env("DATABASE_URL"),
    directUrl: env("DIRECT_DATABASE_URL"),
  },
});
