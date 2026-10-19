// APL-2700. Decides whether the trigger tests may open a database.
// Hard refusals win over every allow, including TRIGGER_TEST_ALLOW.
// The connection string is parsed with pg-connection-string before this allow rule.

import { parse } from "pg-connection-string";

export type TriggerTestTarget = {
  host: string;
  database: string;
  /** Schema the caller would create or modify. */
  schema: string;
};

const QUERY_OVERRIDES = new Set(["host", "hostaddr", "dbname"]);

function norm(value: string): string {
  return value.trim().toLowerCase();
}

/** True when the URL carries a host, hostaddr, or dbname query override. */
function hasQueryOverride(raw: string): boolean {
  try {
    const url = new URL(raw);
    for (const key of url.searchParams.keys()) {
      if (QUERY_OVERRIDES.has(key.toLowerCase())) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function isSocket(raw: string, host: string): boolean {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.startsWith("/") || trimmed.startsWith("socket:")) return true;
  return !host || host.includes("/") || host.includes("\\");
}

/**
 * Parse with the same parser pg uses. Returns undefined for a query override
 * (?host=, ?hostaddr=, ?dbname=), a socket path, or a string parse() rejects.
 * The returned host and database are the ones pg would connect to.
 */
export function connectionTarget(raw: string, schema: string): TriggerTestTarget | undefined {
  if (hasQueryOverride(raw)) return undefined;
  try {
    const parsed = parse(raw);
    const host = parsed.host ?? "";
    const database = parsed.database ?? "";
    if (isSocket(raw, host) || !database) return undefined;
    return { host, database, schema };
  } catch {
    return undefined;
  }
}

/**
 * Allow only when the host is localhost or 127.0.0.1 AND the database name
 * starts with sho_test_. A remote host is never allowed. Always refuse
 * defaultdb, sho_staging, schema public, and sho_pr*, even when the second
 * argument is "1" (TRIGGER_TEST_ALLOW). That argument is ignored.
 */
export function triggerTestAllowed(target: TriggerTestTarget, allowFlag?: string): boolean {
  void allowFlag;
  const host = norm(target.host).replace(/^\[|\]$/g, "");
  const database = norm(target.database);
  const schema = norm(target.schema);

  if (database === "defaultdb" || database === "sho_staging") return false;
  if (schema === "public" || schema.startsWith("sho_pr")) return false;

  return (host === "localhost" || host === "127.0.0.1") && database.startsWith("sho_test_");
}

/** Parse first, then apply the allow rule. Overrides and sockets are refused. */
export function triggerUrlAllowed(raw: string, schema: string, allowFlag?: string): boolean {
  const target = connectionTarget(raw, schema);
  if (!target) return false;
  return triggerTestAllowed(target, allowFlag);
}
