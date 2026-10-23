// Time rules the story specs cannot wait out (30 days, 12 months).
// The source of the rule is always checked. A row is aged only when both the app and the database
// are the local taskboard, so a staging or preview run never writes a timestamp.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, type APIRequestContext } from "@playwright/test";
import { resolveBaseUrl, type TargetEnv } from "../base-url";

/** Local taskboard only. Anything else, including staging and preview, returns null. */
export function localDatabaseUrl(env: TargetEnv = process.env): string | null {
  // Same target as playwright.config.ts: BASE_URL, TASKBOARD_URL, STAGING_URL, else the local server (APL-2879 D1).
  const base = resolveBaseUrl(env);
  let appHost = "";
  try { appHost = new URL(base).hostname.toLowerCase(); } catch { return null; }
  if (appHost !== "localhost" && appHost !== "127.0.0.1") return null;
  const raw = env.DATABASE_URL ?? "";
  let db: URL;
  try { db = new URL(raw); } catch { return null; }
  const host = db.hostname.toLowerCase();
  if (host !== "localhost" && host !== "127.0.0.1") return null;
  const name = db.pathname.replace(/^\//, "").split("?")[0];
  if (name !== "taskboard") return null;
  if (/prod|staging|preview|neon|supabase|pooler/i.test(raw)) return null;
  return raw;
}

/** Extra instructions for localSql(). `schema` overrides ?schema= in DATABASE_URL: the only way to ask for `public`. */
export type LocalSqlOptions = { schema?: string };

/**
 * The psql connection for one statement: the local URL without Prisma's parameters, and the schema to pin.
 * SHO-3011: Prisma's ?schema= is not a libpq setting, so it cannot stay in the URL - and dropping it left an
 * unqualified statement on the server default (public) while the app under test writes the schema DATABASE_URL names,
 * where it "succeeds" against zero rows and the spec's assertion reads like a product bug. The schema therefore travels
 * in the statement, and a URL that does not name one is refused by name rather than guessed: a caller that genuinely
 * means the server default says so - localSql(sql, { schema: "public" }).
 */
function psqlTarget(opts: LocalSqlOptions = {}): { url: string; schema: string } | null {
  const raw = localDatabaseUrl();
  if (!raw) return null;
  const db = new URL(raw);
  const schema = opts.schema ?? db.searchParams.get("schema");
  if (!schema) {
    throw new Error(
      "SHO-3011: DATABASE_URL names no ?schema=, so psql would run this statement in the server's default schema " +
        "(public) while the app writes another. Add ?schema=<name> to DATABASE_URL, or pass { schema: \"public\" } " +
        "to say public out loud.",
    );
  }
  if (!/^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/.test(schema)) {
    throw new Error(`Refusing to put an unexpected schema into SQL: ${JSON.stringify(schema)}.`);
  }
  // Prisma-only parameters: libpq rejects them, and none of them is a setting psql needs.
  for (const k of ["schema", "connection_limit", "pool_timeout", "pgbouncer", "statement_cache_size"]) db.searchParams.delete(k);
  return { url: db.toString(), schema };
}

/** Runs one statement against the local database, in the schema DATABASE_URL names. Returns false when this run is not local. */
export function localSql(sql: string, opts: LocalSqlOptions = {}): boolean {
  const target = psqlTarget(opts);
  if (!target) return false;
  // One session, in this order: pin the schema psql cannot carry, run the caller's statement, then ask the server which
  // schema it ran in. A helper that lost the pin - or a psql that ignored it - fails here, instead of quietly reporting
  // a write that landed in another schema.
  const out = execFileSync("psql", [
    target.url, "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1",
    "-c", `SET search_path TO "${target.schema}"`,
    "-c", sql,
    "-c", "SELECT current_schema()",
  ], { encoding: "utf8" });
  const lines = out.split("\n").map((line) => line.trim()).filter((line) => line && line !== "SET");
  const ran = lines.at(-1) ?? "";
  if (ran !== target.schema) {
    throw new Error(
      `SHO-3011: the statement ran in schema ${JSON.stringify(ran)}, not ${JSON.stringify(target.schema)}: ` +
        "refusing to report a write that landed elsewhere.",
    );
  }
  return true;
}

/** Ids that go into SQL are the ones the API just returned. Nothing else is interpolated. */
export function sqlId(id: string) {
  if (!/^[a-z0-9]+$/i.test(id)) throw new Error("Refusing to put an unexpected id into SQL.");
  return id;
}

/** Text of one function (or to the end of the file), so a clock rule can be read from the source. */
export function sourceOf(file: string, start: string, end?: string) {
  const src = readFileSync(file, "utf8");
  const i = src.indexOf(start);
  expect(i, `${file} contains ${start}`).toBeGreaterThanOrEqual(0);
  const j = end ? src.indexOf(end, i + start.length) : -1;
  return src.slice(i, j === -1 ? undefined : j);
}

/** POST /api/jobs/<name> on the local server. Null when this run is not local. */
export async function runLocalJob(request: APIRequestContext, name: string) {
  if (!localDatabaseUrl()) return null;
  const secret = process.env.JOB_SECRET ?? "";
  if (secret.length < 16) throw new Error("Set JOB_SECRET (at least 16 characters) to run the local scheduled job.");
  return request.post(`/api/jobs/${name}`, { headers: { authorization: `Bearer ${secret}` } });
}
