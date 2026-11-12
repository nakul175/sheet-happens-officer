/** Browser regression fixtures may only mutate the disposable local CI database. */
export function assertLocalFixture(databaseUrl: string | undefined, appUrl?: string) {
  const refused = () => { throw new Error("DISPOSABLE_LOCAL_SHO_TEST_REQUIRED"); };
  const loopback = (host: string) => ["localhost", "127.0.0.1", "[::1]"].includes(host);
  let database: URL;
  try { database = new URL(databaseUrl ?? ""); } catch { return refused(); }
  if (!["postgres:", "postgresql:"].includes(database.protocol) || !loopback(database.hostname) ||
      database.pathname !== "/sho_test" || ![null, "public"].includes(database.searchParams.get("schema"))) refused();
  // No libpq target override or ambiguous schema query may bypass the URL host check.
  if ([...database.searchParams.keys()].some(key => key !== "schema") || database.searchParams.getAll("schema").length > 1) refused();
  if (appUrl !== undefined) {
    let app: URL;
    try { app = new URL(appUrl); } catch { return refused(); }
    if (!["http:", "https:"].includes(app.protocol) || !loopback(app.hostname) || app.username || app.password) refused();
  }
}
