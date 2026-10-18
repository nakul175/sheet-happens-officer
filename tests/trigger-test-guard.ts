// APL-2700. Decides whether the trigger tests may open a database.
// Hard refusals win over every allow, including TRIGGER_TEST_ALLOW.

export type TriggerTestTarget = {
  host: string;
  database: string;
  /** Schema the caller would create or modify. */
  schema: string;
};

function norm(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Allow only localhost, 127.0.0.1, or a database whose name starts with sho_test_.
 * Always refuse defaultdb, sho_staging, schema public, and sho_pr*, even when
 * the second argument is "1" (TRIGGER_TEST_ALLOW). That argument is ignored.
 */
export function triggerTestAllowed(target: TriggerTestTarget, allowFlag?: string): boolean {
  void allowFlag;
  const host = norm(target.host).replace(/^\[|\]$/g, "");
  const database = norm(target.database);
  const schema = norm(target.schema);

  if (database === "defaultdb" || database === "sho_staging") return false;
  if (schema === "public" || schema.startsWith("sho_pr")) return false;

  if (host === "localhost" || host === "127.0.0.1") return true;
  return database.startsWith("sho_test_");
}
