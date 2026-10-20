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

/** Runs one statement against the local database. Returns false when this run is not local. */
export function localSql(sql: string): boolean {
  const url = localDatabaseUrl();
  if (!url) return false;
  // Prisma's URL carries ?schema=public, which psql rejects.
  execFileSync("psql", [url.replace(/\?.*$/, ""), "-v", "ON_ERROR_STOP=1", "-c", sql], { stdio: "pipe" });
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
