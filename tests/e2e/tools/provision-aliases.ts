// APL-2748. One-time (and re-runnable) set-up of the verified alias pool the story specs sign in as.
// It talks to the app's public API only: no database connection, no app code, nothing on production.
//
// Run from a laptop with the staging secrets in the environment (never on the command line):
//   BASE_URL=https://staging.sheethappensofficer.com STAGING_USER=... STAGING_PASS=... SHO_QA_PASS=... \
//     npx tsx tests/e2e/tools/provision-aliases.ts [--check] [--slots 01,02,serial | --slots all]
//
//   1. The Super Admin alias (nakul17+zz-sa) must sign in with SHO_QA_PASS and be listed in SUPER_ADMIN_EMAILS.
//   2. Each missing pool alias is signed up with SHO_QA_PASS. Staging emails a verification link to nakul17@aplyd.com.
//      An unverified one gets a fresh link (at most 3 an hour). A deactivated one is reactivated. One left as Admin
//      is put back to Member.
//   3. Open each "Verify" email and follow its link, then run the script again. It exits 0 when every alias is ready.
// --check changes nothing and only reports. Output names addresses and states, never a password or token.
//
// --create (APL-2748, run by .github/workflows/provision-staging-aliases.yml) brings the pool up on staging itself and
// nothing else. Each Member is probed with a sign-in first and only an address with no account is signed up, so an alias
// that already exists is never sent a sign-up (the one request that creates an unverified row). It needs no Super Admin
// and prints counts only (created, skipped, failed, ready) plus one verdict line, no address and no password.
//
// APL-3017: it exits non-zero unless all 66 are ready (signed in with SHO_QA_PASS), nothing was created and nothing
// failed. A created account is unverified until its Verify link is followed, so the first run on an empty staging is red
// on purpose and says how many are not ready; the same run after the links are followed is green with created 0. A run
// that leaves the pool unverified can never look green, which is how 66 unverified aliases were mistaken for success.
import { pathToFileURL } from "node:url";
import { POOL_SIZE, QA_ADMIN_EMAIL, QA_ADMIN_NAME, SLOTS, freeOfSecrets, parseSlots, poolFor, provisionTarget, stagingOnlyTarget, type PoolPerson } from "../helpers/alias-pool";

export type Reply = { status: number; json: Record<string, unknown>; cookie: string | null };
export type Http = (method: "GET" | "POST" | "PATCH", path: string, body?: unknown, cookie?: string | null) => Promise<Reply>;

export type State =
  | "READY" // verified, active, Member, signs in with SHO_QA_PASS
  | "MISSING" | "SIGNED_UP" // no account yet / just created, verification mail sent
  | "UNVERIFIED" | "VERIFY_SENT" // waiting for the link to be followed
  | "DEACTIVATED"
  | "WRONG_ROLE"
  | "WRONG_PASSWORD" // the account exists but SHO_QA_PASS does not sign in: use Forgot password for that address
  | "LOCKED" // too many failed sign-ins; wait and run again
  | "ERROR";

export type Row = { email: string; slot: string; state: State; note: string };
export type Result = { rows: Row[]; ready: boolean };
export type Options = { password: string; slots: string[]; check: boolean; http: Http; secrets: string[]; pause?: number };

type TeamRow = { id: string; email: string; orgRole: string; status: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The server's message, only when it carries no secret. */
function said(reply: Reply, secrets: string[]) {
  const msg = typeof reply.json.error === "string" ? reply.json.error : "";
  return msg && freeOfSecrets(msg, secrets) ? msg : `status ${reply.status}`;
}

export async function provision(opts: Options): Promise<Result> {
  const { http, password, check, secrets } = opts;
  const pause = opts.pause ?? 300;
  const rows: Row[] = [];
  const push = (email: string, slot: string, state: State, note = "") => { rows.push({ email, slot, state, note }); };

  const signIn = (email: string) => http("POST", "/api/auth/signin", { email, password });
  const signOut = async (cookie: string | null) => { if (cookie) await http("POST", "/api/auth/signout", {}, cookie); };
  const signUp = async (email: string, name: string, slot: string) => {
    const up = await http("POST", "/api/auth/signup", { name, email, password });
    if (up.status === 201) push(email, slot, "SIGNED_UP", "verification mail sent");
    else if (up.status === 409) push(email, slot, "WRONG_PASSWORD", "the account exists but SHO_QA_PASS does not sign in");
    else push(email, slot, "ERROR", `sign-up: ${said(up, secrets)}`);
  };

  // 1. The Super Admin. Nothing else can be checked without it.
  const adminIn = await signIn(QA_ADMIN_EMAIL);
  if (adminIn.status !== 200) {
    const msg = said(adminIn, secrets);
    if (adminIn.status === 401) {
      if (check) push(QA_ADMIN_EMAIL, "admin", "MISSING", "or SHO_QA_PASS is not its password");
      else await signUp(QA_ADMIN_EMAIL, QA_ADMIN_NAME, "admin");
    } else if (adminIn.status === 403 && /verify/i.test(msg)) {
      if (!check) await http("POST", "/api/auth/resend-verification", { email: QA_ADMIN_EMAIL });
      push(QA_ADMIN_EMAIL, "admin", check ? "UNVERIFIED" : "VERIFY_SENT");
    } else if (adminIn.status === 403) push(QA_ADMIN_EMAIL, "admin", "DEACTIVATED", "reactivate it from the staging Team list as another Super Admin");
    else if (adminIn.status === 429) push(QA_ADMIN_EMAIL, "admin", "LOCKED", msg);
    else push(QA_ADMIN_EMAIL, "admin", "ERROR", msg);
    return { rows, ready: false };
  }
  const admin = adminIn.cookie;
  try {
    const role = (adminIn.json.user as { orgRole?: string } | undefined)?.orgRole;
    if (role !== "SUPER_ADMIN") {
      push(QA_ADMIN_EMAIL, "admin", "WRONG_ROLE", "add it to SUPER_ADMIN_EMAILS on the staging server");
      return { rows, ready: false };
    }
    push(QA_ADMIN_EMAIL, "admin", "READY");

    const team = await http("GET", "/api/team", undefined, admin);
    if (team.status !== 200) {
      push(QA_ADMIN_EMAIL, "admin", "ERROR", `team list: ${said(team, secrets)}`);
      return { rows, ready: false };
    }
    const byEmail = new Map(((team.json.people ?? []) as TeamRow[]).map((p) => [String(p.email).toLowerCase(), p]));

    // 2. Every pool Member.
    const people: PoolPerson[] = opts.slots.flatMap(poolFor);
    for (const p of people) {
      await sleep(pause);
      const row = byEmail.get(p.email);
      if (!row) {
        if (check) push(p.email, p.slot, "MISSING");
        else await signUp(p.email, p.name, p.slot);
        continue;
      }
      if (row.status === "DEACTIVATED") {
        if (check) { push(p.email, p.slot, "DEACTIVATED"); continue; }
        const back = await http("POST", `/api/team/${row.id}/reactivate`, {}, admin);
        if (back.status !== 200) { push(p.email, p.slot, "ERROR", `reactivate: ${said(back, secrets)}`); continue; }
      }
      const probe = await signIn(p.email);
      await signOut(probe.cookie);
      const msg = said(probe, secrets);
      if (probe.status === 403 && /verify/i.test(msg)) {
        if (!check) await http("POST", "/api/auth/resend-verification", { email: p.email });
        push(p.email, p.slot, check ? "UNVERIFIED" : "VERIFY_SENT");
        continue;
      }
      if (probe.status === 401) { push(p.email, p.slot, "WRONG_PASSWORD", "use Forgot password for this address and set it to SHO_QA_PASS"); continue; }
      if (probe.status === 429) { push(p.email, p.slot, "LOCKED", msg); continue; }
      if (probe.status !== 200) { push(p.email, p.slot, "ERROR", `sign-in: ${msg}`); continue; }
      const now = (probe.json.user as { orgRole?: string } | undefined)?.orgRole ?? row.orgRole;
      if (now === "MEMBER") { push(p.email, p.slot, "READY"); continue; }
      if (now === "SUPER_ADMIN") { push(p.email, p.slot, "WRONG_ROLE", "remove it from SUPER_ADMIN_EMAILS"); continue; }
      if (check) { push(p.email, p.slot, "WRONG_ROLE", `is ${now}`); continue; }
      const fixed = await http("PATCH", `/api/team/${row.id}`, { orgRole: "MEMBER" }, admin);
      push(p.email, p.slot, fixed.status === 200 ? "READY" : "ERROR", fixed.status === 200 ? "put back to Member" : `role: ${said(fixed, secrets)}`);
    }
  } finally {
    await signOut(admin);
  }
  return { rows, ready: rows.every((r) => r.state === "READY") };
}

export type CreateCounts = { created: number; skipped: number; failed: number; ready: number };
export type CreateOptions = { password: string; http: Http; pause?: number };

/** The server's own message, for the one decision create mode makes on it (verified or not). Never printed. */
function messageOf(reply: Reply) {
  return typeof reply.json.error === "string" ? reply.json.error : "";
}

/**
 * Create mode: every pool Member in every slot, signed up only when it has no account. Each one is probed with a sign-in
 * first, so an existing alias is left exactly as it is:
 *   200             -> ready (verified, active, SHO_QA_PASS works); skipped, and the probe is signed straight back out.
 *   403 "verify"    -> the account exists and waits on its link; skipped, nothing written.
 *   403 (other), 429 -> deactivated or locked; failed, nothing written.
 *   401             -> no account, or another password; sign up. 201 created, 409 skipped (other password), else failed.
 *   a dropped request or any other status -> failed.
 * APL-3017: a sign-up is the one request in this repo that makes an unverified row, so no existing alias ever gets one.
 * A 200 probe is a real sign-in, and sign-in is what creates a Session row the app honours for 30 days; it is signed out
 * again so that re-running this mode, which reports created 0, really does add nothing.
 */
export async function createMissing(opts: CreateOptions): Promise<CreateCounts> {
  const pause = opts.pause ?? 300;
  const counts: CreateCounts = { created: 0, skipped: 0, failed: 0, ready: 0 };
  for (const p of SLOTS.flatMap(poolFor)) {
    await sleep(pause);
    let probe: Reply;
    try { probe = await opts.http("POST", "/api/auth/signin", { email: p.email, password: opts.password }); }
    catch { counts.failed++; continue; }
    if (probe.status === 200) {
      // Same as provision()'s probe: a session created to read the account is closed again. Best effort: a probe that
      // signed in has told us what we needed, and a failed sign-out must not turn a ready alias into a failed run.
      if (probe.cookie) try { await opts.http("POST", "/api/auth/signout", {}, probe.cookie); } catch { /* best effort */ }
      counts.ready++;
      counts.skipped++;
      continue;
    }
    if (probe.status === 403 && /verify/i.test(messageOf(probe))) { counts.skipped++; continue; }
    if (probe.status !== 401) { counts.failed++; continue; }
    let status = 0;
    try { status = (await opts.http("POST", "/api/auth/signup", { name: p.name, email: p.email, password: opts.password })).status; }
    catch { /* a network error counts as failed */ }
    if (status === 201) counts.created++;
    else if (status === 409) counts.skipped++;
    else counts.failed++;
  }
  return counts;
}

/** Counts only. Never an address, a password or server text. */
export function createSummary(c: CreateCounts): string {
  const total = c.created + c.skipped + c.failed;
  return `created ${c.created}, skipped ${c.skipped}, failed ${c.failed}, ready ${c.ready}, total ${total} of ${POOL_SIZE}`;
}

/**
 * Create mode passes only when every pool Member was accounted for, nothing failed, nothing was created and all 66 sign
 * in. APL-3017: creating is not provisioning. A created account is unverified until its Verify link is followed, and an
 * alias left unverified by an earlier run is not ready either — existing is not the same as ready.
 */
export function createPassed(c: CreateCounts): boolean {
  return c.failed === 0 && c.created === 0 && c.created + c.skipped + c.failed === POOL_SIZE && c.ready === POOL_SIZE;
}

/** The line after the counts: what the run means, and what to do when it is not a pass. Counts only. */
export function createVerdict(c: CreateCounts): string {
  if (createPassed(c)) return `All ${POOL_SIZE} aliases are ready: verified, active and signed in with SHO_QA_PASS.`;
  const notReady = POOL_SIZE - c.ready;
  return `${notReady} of ${POOL_SIZE} not ready. A created account is unverified until its Verify link is followed; ` +
    `run --check --slots all for the per-alias state, then follow the links and run --create again.`;
}

const AWAITING_LINK: State[] = ["SIGNED_UP", "VERIFY_SENT", "UNVERIFIED"];
/** What to do next for a state that is not READY. Only an alias waiting on its link is told to follow one. */
const NEXT: Record<Exclude<State, "READY">, string> = {
  MISSING: "run without --check to sign it up",
  SIGNED_UP: "follow its Verify link in nakul17@aplyd.com",
  VERIFY_SENT: "follow its Verify link in nakul17@aplyd.com",
  UNVERIFIED: "run without --check to send a new link, or follow the last one",
  DEACTIVATED: "run without --check to reactivate it",
  WRONG_ROLE: "see the note",
  WRONG_PASSWORD: "use Forgot password for this address and set it to SHO_QA_PASS",
  LOCKED: "wait for the lockout to end",
  ERROR: "see the note",
};

export function report(result: Result): string {
  const lines = result.rows.map((r) => {
    const next = r.state === "READY" ? "" : ` -> ${NEXT[r.state]}`;
    return `${r.slot.padEnd(7)} ${r.email.padEnd(34)} ${r.state}${r.note ? `  (${r.note})` : ""}${next}`;
  });
  if (result.ready) {
    lines.push(`All ${result.rows.length} aliases are ready.`);
  } else {
    const open = result.rows.filter((r) => r.state !== "READY");
    const links = open.filter((r) => AWAITING_LINK.includes(r.state)).length;
    const other = open.length - links;
    const parts = [
      links ? `${links} waiting on a Verify link in nakul17@aplyd.com` : "",
      other ? `${other} needing the step shown on its line` : "",
    ].filter(Boolean);
    lines.push(`${open.length} of ${result.rows.length} need action: ${parts.join(", ")}. Then run again.`);
  }
  return lines.join("\n");
}

/** fetch against `base`, with the staging basic-auth gate when set. Only the session cookie is kept. */
export function fetchHttp(base: URL, basic: { user: string; pass: string } | null): Http {
  return async (method, path, body, cookie) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (basic) headers.authorization = `Basic ${Buffer.from(`${basic.user}:${basic.pass}`).toString("base64")}`;
    if (cookie) headers.cookie = cookie;
    const res = await fetch(new URL(path, base), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    let json: Record<string, unknown> = {};
    try { json = (await res.json()) as Record<string, unknown>; } catch { /* not JSON */ }
    const session = res.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("sho_session="));
    return { status: res.status, json, cookie: session ?? null };
  };
}

async function create(args: string[]) {
  if (args.includes("--check") || args.includes("--slots")) throw new Error("--create always covers every slot and cannot be combined with --check or --slots.");
  const base = stagingOnlyTarget(process.env.BASE_URL);
  const password = process.env.SHO_QA_PASS ?? "";
  if (password.length < 8) throw new Error("Set SHO_QA_PASS (8 characters or more) in the environment.");
  const user = process.env.STAGING_USER ?? "";
  const pass = process.env.STAGING_PASS ?? "";
  if (!user || !pass) throw new Error("Set STAGING_USER and STAGING_PASS for the staging basic-auth gate.");
  console.log(`Creating missing pool aliases on ${base.host}.`);
  const counts = await createMissing({ password, http: fetchHttp(base, { user, pass }) });
  const out = `${createSummary(counts)}\n${createVerdict(counts)}`;
  if (!freeOfSecrets(out, [password, pass])) throw new Error("Refusing to print output that contains a secret.");
  console.log(out);
  process.exitCode = createPassed(counts) ? 0 : 2;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--create")) return create(args);
  const check = args.includes("--check");
  const at = args.indexOf("--slots");
  const slots = parseSlots(at >= 0 ? args[at + 1] : undefined);
  const base = provisionTarget(process.env.BASE_URL);
  const password = process.env.SHO_QA_PASS ?? "";
  if (password.length < 8) throw new Error("Set SHO_QA_PASS (8 characters or more) in the environment.");
  const remote = base.hostname !== "localhost" && base.hostname !== "127.0.0.1";
  const user = process.env.STAGING_USER ?? "";
  const pass = process.env.STAGING_PASS ?? "";
  if (remote && (!user || !pass)) throw new Error("Set STAGING_USER and STAGING_PASS for the staging basic-auth gate.");
  const secrets = [password, pass].filter(Boolean);
  console.log(`${check ? "Checking" : "Provisioning"} ${slots.length} slot(s) on ${base.host}.`);
  const result = await provision({ password, slots, check, http: fetchHttp(base, remote ? { user, pass } : null), secrets });
  const out = report(result);
  if (!freeOfSecrets(out, secrets)) throw new Error("Refusing to print output that contains a secret.");
  console.log(out);
  process.exitCode = result.ready ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : "Provisioning failed.");
    process.exitCode = 1;
  });
}
