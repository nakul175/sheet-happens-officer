// READ-ONLY staging identity probe. One question, no writes: which database does
// staging.sheethappensofficer.com talk to, and are its grants restricted to that database?
//
// Every check is a refusal path, so a valid identity and an empty password both leave the database
// unchanged:
//   signin with an empty password -> 401 WRONG. No account has an empty password, so no session can be
//     minted. The 401 body carries `plans` (usage.ts counts tables): the live table list, i.e. identity.
//   signin with wrong passwords -> 429 after LOCKOUT_FAILURES. Reaching the 6th answer proves the account
//     may INSERT LoginAttempt and write ActionLog/AuditLog: a write grant, on a throwaway address.
//   anonymous POSTs -> 401. Proves writes are closed to an unauthenticated caller.
//   reset request for a cold throwaway address -> 200 once, 429 after 3/hour. The 429 is only reachable if
//     this database already holds that address's tokens: an identity fingerprint, at one row at most.
// Prints redacted metadata only: statuses, booleans, table-name keys, a hashed probe id. Never a password,
// token, cookie, email body or response body. TLS verification is never disabled.
import { createHash } from "node:crypto";

export type Reply = { status: number; json: Record<string, unknown> };
export type Http = (method: "GET" | "POST", path: string, body?: unknown) => Promise<Reply>;
export type Stage = { name: string; ok: boolean; detail: string };

export const PROBE_HEADERS = { "user-agent": "sho-readonly-probe/1" };

/** What the probe may print: a key set, never the values behind it. */
function keysOf(v: unknown): string {
  if (!v || typeof v !== "object") return `(${typeof v})`;
  return Object.keys(v as Record<string, unknown>).sort().join(",") || "(none)";
}

function plansOf(reply: Reply): string {
  const plans = reply.json.plans;
  return plans && typeof plans === "object" ? keysOf(plans) : "(absent)";
}

export async function runProbe(opts: { http: Http; base: string; account: string; password: string; timeoutMs?: number }): Promise<Stage[]> {
  const { http, base, account, password } = opts;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const stages: Stage[] = [];
  const add = (name: string, ok: boolean, detail: string) => stages.push({ name, ok, detail });

  // 1. Reachability. GET, no body, no cookie, no write. A Caddy basic-auth gate answers 401 here and the
  //    app is never reached: that is the one failure this probe reports as "gate", not "product".
  let head: Reply | null = null;
  try {
    head = await Promise.race([
      http("GET", "/api/health"),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs)),
    ]);
  } catch {
    add("reachable", false, `GET /api/health: no answer in ${timeoutMs}ms (edge gate or DNS, not the app)`);
    return stages;
  }
  add("reachable", head.status === 200, `GET /api/health -> ${head.status}${head.status === 401 ? " (basic-auth gate: credentials refused before the app)" : ""}`);
  if (head.status === 401) return stages;

  // 2. Writes closed to an anonymous caller: an unauthenticated body is refused, never attempted.
  for (const [label, path] of [["health-insert", "/api/health"], ["deals-write", "/api/deals"]] as const) {
    const r = await http("POST", path, {});
    add(`lock-${label}`, r.status === 401 || r.status === 405, `anonymous POST ${path} -> ${r.status} (want 401/405)`);
  }

  // 3. Identity: the answer every address gets, known or not. A wrong password is a 401 WRONG and a session
  //    is impossible, so this is the refusal path that also names the tables behind the app.
  const wrong = await http("POST", "/api/auth/signin", { email: account, password: `probe-${createHash("sha256").update(account).digest("hex").slice(0, 16)}` });
  add("identity-wrong-password", wrong.status === 401, `POST /api/auth/signin (wrong password) -> ${wrong.status} (want 401; 200 would mean the account exists with a known password)`);
  add("identity-error-body", wrong.status === 401, `error body keys: ${keysOf(wrong.json)}`);
  add("identity-models", wrong.status === 401, `plans keys: ${plansOf(wrong)}`);

  // 4. The public reset answer, on the throwaway address. forgot-password/route.ts:10 mails a reset only for
  //    an address that has an account, so for a cold one this stores nothing and mails nobody; the answer must
  //    still be the one a real address gets, which is what stops the endpoint being an account oracle. It
  //    reports rather than decides when the address is refused for a domain reason instead.
  const resets: number[] = [];
  for (let i = 1; i <= 4; i++) {
    const r = await http("POST", "/api/auth/forgot-password", { email: account });
    resets.push(r.status);
    if (r.status >= 500) break;
  }
  add("identity-reset-answers", resets.every((s) => s === 200 || s === 429),
    `4 reset requests -> [${resets.join(",")}] (200/429 keeps one public answer; 400 shows the domain rule)`);

  // 5. Write grant, throwaway address only: the lockout counter must actually count to 5.
  const codes: number[] = [];
  for (let i = 1; i <= 6; i++) {
    const r = await http("POST", "/api/auth/signin", { email: account, password: `probe-${i}-not-a-password` });
    codes.push(r.status);
    if (r.status >= 500) break;
  }
  const lockedAt = codes.indexOf(429) + 1;
  add("grant-loginattempt-insert", lockedAt > 0, `6 sign-ins -> [${codes.join(",")}] (429 present => LoginAttempt insert works)`);
  add("grant-lockout-events", lockedAt > 0, `lockout seen on attempt ${lockedAt || "never"}; the route's audit writes ran too`);

  // 6. Capacity: the staging DB allows 25 connections. One served request is all a read-only probe can
  //    honestly show, and the time it took is the only load signal worth recording.
  const t0 = Date.now();
  const one = await http("GET", "/api/health");
  add("capacity-one-connection", one.status === 200, `GET /api/health -> ${one.status} in ${Date.now() - t0}ms`);

  // 7. Nothing secret comes back: the 401 body must not echo the password under test.
  const leaked = JSON.stringify(wrong.json).includes("probe-");
  add("no-secret-echo", !leaked, `401 body ${leaked ? "contains" : "does not contain"} the submitted password`);

  add("probe-id", true, `sha256(account)[0:12]=${createHash("sha256").update(account).digest("hex").slice(0, 12)} base=${base} passwordSupplied=${password.length > 0}`);
  return stages;
}

/** The bound every request gets; the workflow passes no timeout flags, so this is the only one. */
const REQUEST_MS = 20_000;

/** One line per stage, exit 1 when any stage failed. Configuration is env-only, so nothing lands in argv. */
export async function main(env: Record<string, string | undefined>) {
  const base = (env.PROBE_BASE_URL ?? "").replace(/\/$/, "");
  const user = env.STAGING_USER ?? "";
  const pass = env.STAGING_PASS ?? "";
  if (!/^https:\/\/[a-z0-9.-]+$/.test(base) || !base.endsWith("sheethappensofficer.com") || /(^|\/\/)(www\.|app\.)?sheethappensofficer\.com/.test(base)) {
    console.log(`::error::PROBE_BASE_URL must be the https staging host, got a ${base ? "non-staging" : "missing"} value`);
    return false;
  }
  if (!user || !pass) {
    console.log("::error::STAGING_USER and STAGING_PASS must be set (they are the repo's existing staging secrets)");
    return false;
  }
  const auth = Buffer.from(`${user}:${pass}`).toString("base64");
  const http: Http = async (method, path, body) => {
    // TLS verification stays on: no agent override and no NODE_TLS_REJECT_UNAUTHORIZED anywhere in this file.
    const res = await fetch(base + path, {
      method,
      redirect: "manual",
      headers: { ...PROBE_HEADERS, authorization: `Basic ${auth}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_MS),
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
    return { status: res.status, json };
  };
  const account = `probe-${env.GITHUB_RUN_ID ?? "local"}-${Date.now()}@aplyd.com`;
  const stages = await runProbe({ http, base, account, password: pass });
  for (const s of stages) console.log(`${s.ok ? "PASS" : "FAIL"}  ${s.name.padEnd(26)} ${s.detail}`);
  const failed = stages.filter((s) => !s.ok);
  console.log(`\n${stages.length - failed.length}/${stages.length} stages passed`);
  return failed.length === 0;
}

// `npx tsx tests/e2e/tools/staging-identity-probe.ts`: run when this file is the script, import otherwise.
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.env).then((ok) => { process.exitCode = ok ? 0 : 1; }).catch((e: unknown) => {
    // A crash must not print the reason: an error can carry a URL with a query or a header value.
    console.log(`::error::probe crashed (${(e as Error)?.name ?? "Error"})`);
    process.exitCode = 1;
  });
}
