/** Explicit new-user RP path. Existing SHO identities keep their source-session flow. */
export function invitedNativeId(id: unknown): id is string {
  return typeof id === "string" && /^portal_sho_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id);
}
export function invitedSessionsEnabled() {
  return process.env.APLYD_SHO_INVITED_SESSIONS_ENABLED === "1";
}
/** Disposable loopback acceptance only; cannot select a live database or public origin. */
export function invitedTestRealm(env: Record<string, string | undefined> = process.env) {
  if (env.APLYD_SHO_INVITATION_TEST !== "1") return null;
  if (env.NODE_ENV !== "test" || env.APLYD_SHO_INVITED_SESSIONS_ENABLED !== "1" ||
      env.APP_URL !== "https://localhost:49755" || env.APLYD_ACCOUNTS_ISSUER !== "https://localhost:49750")
    throw Error("Isolated invitation realm required");
  const database = new URL(env.DATABASE_URL ?? "");
  if (!['127.0.0.1', 'localhost'].includes(database.hostname) || !/^\/sho_provision_test_[a-f0-9]{12}$/.test(database.pathname))
    throw Error("Disposable invitation database required");
  return {origin: "https://localhost:49755", issuer: "https://localhost:49750", clientId: "sho-invitation-test"};
}
