// The eval refuses to start unless it is aimed at a throwaway local database.
// Error text never includes the connection string or the provider key.

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export function assertThrowawayDatabase(env: NodeJS.ProcessEnv = process.env): void {
  if (env.CONCIERGE_EVAL !== "1") throw new Error("Refusing to run without CONCIERGE_EVAL=1.");
  if (env.NODE_ENV === "production") throw new Error("Refusing to run with NODE_ENV=production.");
  const raw = env.DATABASE_URL ?? "";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("DATABASE_URL is missing or not a URL.");
  }
  if (!LOCAL_HOSTS.has(parsed.hostname)) {
    throw new Error(`Refusing to run against database host ${parsed.hostname}.`);
  }
  const name = parsed.pathname.replace(/^\//, "").split("?")[0];
  if (!/eval/i.test(name)) {
    throw new Error(`Refusing to run against database ${name || "(none)"}. Use a throwaway database whose name contains "eval".`);
  }
  if ((env.MODEL_PROVIDER || "anthropic").toLowerCase() === "fake") {
    throw new Error("The eval set does not run with MODEL_PROVIDER=fake.");
  }
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is missing. In CI it is the CONCIERGE_EVAL_API_KEY secret.");
  }
  if (env.EVAL_MODEL_SLOT === "secondary" && !(env.MODEL_NAME_SECOND ?? "").trim()) {
    throw new Error("MODEL_NAME_SECOND is not set. Add that Actions variable to run the second configured model.");
  }
}
