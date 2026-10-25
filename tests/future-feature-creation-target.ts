/** Test-only scope gate. Cleanup below always deletes this case's recorded IDs only. */
export function assertCreationCompatTarget(env: Record<string, string | undefined>, base: string) {
  const refused = () => { throw new Error("Refusing nonowned creation compatibility target"); };
  let app: URL, database: URL;
  try { app = new URL(base); database = new URL(env.DATABASE_URL ?? ""); } catch { return refused(); }
  const loopback = (hostname: string) => ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
  if (app.protocol !== "http:" || !loopback(app.hostname) || app.username || app.password) return refused();
  if (!["postgresql:", "postgres:"].includes(database.protocol) || !loopback(database.hostname) || database.pathname !== "/sho_test") return refused();
  if ([...database.searchParams.keys()].some(key => /^(host|hostaddr|dbname|options)$/i.test(key)) || database.searchParams.getAll("schema").length !== 1) return refused();
  const schema = database.searchParams.get("schema");
  const ownedLocal = schema === "sho_future_features_20261024" || schema === "sho_future_ci_browser_20261024";
  const explicitCI = env.GITHUB_ACTIONS === "true" && env.CI === "true" && schema === "sho_ci";
  if (!ownedLocal && !explicitCI) return refused();
}
