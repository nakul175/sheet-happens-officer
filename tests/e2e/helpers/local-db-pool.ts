// SHO-3011 (APL-2742). The story specs read the app's rows with `pg`, not Prisma. Prisma reads ?schema= from
// DATABASE_URL and sets search_path on every connection; a plain pg connection parses only pg's own parameters and
// drops ?schema= (tests/seed-schema-search-path.test.ts proves why), so `new pg.Pool({ connectionString })` reads the
// default schema - usually public - while the app writes the schema the URL names. That is a wrong-answer bug, not a
// crash: the reads return no rows, another run's rows, or a missing-table error.
//
// localPgPool keeps both readers on one schema. The start-up `options` parameter is the only lever pg has, and it
// applies to every connection the pool opens. Without ?schema= the pool is exactly the one it was before.
import pg from "pg";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * The only schema names this helper will put in a start-up option: no quote, space, backslash or separator can reach
 * the option string, so a hostile ?schema= cannot add another setting. The schema is still quoted in the option, so a
 * mixed-case name keeps its case (Prisma would have created it that way).
 */
const PLAIN_SCHEMA = /^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/;

/** The host pg will connect to, or throws when the value is not a URL. Never returns the string itself. */
function hostOf(databaseUrl: string): string {
  let host: string;
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    throw new Error("DATABASE_URL is not a URL. Refusing.");
  }
  return host.replace(/^\[|\]$/g, "").toLowerCase();
}

/** Throws unless DATABASE_URL names a local TCP database. The message never carries the URL (it holds a password). */
export function assertLocalDatabaseUrl(databaseUrl: string | undefined): string {
  if (!databaseUrl) throw new Error("DATABASE_URL is not set. Refusing.");
  if (!LOCAL_HOSTS.has(hostOf(databaseUrl))) throw new Error("Refusing to run: DATABASE_URL must point at a local database.");
  return databaseUrl;
}

/**
 * The schema Prisma would use for this URL: the `schema` query parameter, or undefined when there is none (Prisma's
 * default). A repeated or empty value is ambiguous and refused rather than guessed.
 */
export function schemaFromDatabaseUrl(databaseUrl: string): string | undefined {
  const url = new URL(databaseUrl);
  const names = url.searchParams.getAll("schema");
  if (names.length === 0) return undefined;
  if (names.length > 1) throw new Error("DATABASE_URL names more than one schema. Refusing.");
  if (!PLAIN_SCHEMA.test(names[0])) throw new Error("DATABASE_URL names a schema that is not a plain identifier. Refusing.");
  return names[0];
}

/**
 * A small pool for the spec's read-only SELECTs that reads the same schema Prisma does. max stays 1 by default, as it
 * was. With ?schema=<name> every connection starts with search_path set to that one schema, exactly as Prisma's own
 * connections do; with no ?schema= nothing is added to the connection.
 */
export function localPgPool(databaseUrl: string | undefined, max = 1): pg.Pool {
  const url = assertLocalDatabaseUrl(databaseUrl);
  const schema = schemaFromDatabaseUrl(url);
  if (schema === undefined) return new pg.Pool({ connectionString: url, max });
  // pg's ConnectionParameters lets the parsed connection string override the config passed beside it, so an
  // ?options= in the URL would silently win over the schema. Refuse rather than read the wrong schema.
  const keys = [...new URL(url).searchParams.keys()].map((k) => k.toLowerCase());
  if (keys.includes("options")) throw new Error("DATABASE_URL carries both ?schema= and ?options=. Refusing.");
  return new pg.Pool({ connectionString: url, max, options: `-c search_path="${schema}"` });
}
