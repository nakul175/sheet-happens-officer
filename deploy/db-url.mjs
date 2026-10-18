// Describe a Postgres URL without printing the user, the password, or the URL.
// The caller passes the URL in DB_URL_CHECK, never as an argument.
const raw = process.env.DB_URL_CHECK ?? "";
if (!raw) {
  console.error("database url is missing");
  process.exit(1);
}

let url;
try {
  url = new URL(raw);
} catch {
  console.error("database url is not valid");
  process.exit(1);
}
if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
  console.error("database url must be a postgres URL");
  process.exit(1);
}

const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
const pgbouncer = url.searchParams.get("pgbouncer") === "true";
const port = url.port || "5432";
process.stdout.write(JSON.stringify({
  host: url.hostname.toLowerCase(),
  database: database.toLowerCase(),
  port,
  pgbouncer,
  pool: pgbouncer || port === "25061",
  connectionLimit: url.searchParams.get("connection_limit") ?? "",
  poolTimeout: url.searchParams.get("pool_timeout") ?? "",
}));
