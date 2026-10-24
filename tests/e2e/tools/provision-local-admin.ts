// SHO-2920..2923. The missing ingredient the four unproven tickets were waiting for: a Super Admin and a plain Member
// to sign in as. tests/e2e/support.ts reads SHO_ADMIN_EMAIL / SHO_ADMIN_PASS and SHO_MEMBER_EMAIL / SHO_MEMBER_PASS,
// and tests/e2e/stories/APL-2538, -2539 and -2540 fail on the fixture without them (a skip would prove nothing).
//
// This provisions both accounts against the LOCAL server through the app's public API only, on the same path
// tests/helpers.ts uses: sign up, read the "Verify" mail the server writes into EMAIL_OUTBOX_DIR, follow the token,
// sign in, and check /api/auth/me carries the role the fixture asserts. No database connection, no app import, no
// staging, no production: a non-loopback BASE_URL is refused.
//
//   TASKBOARD_URL=http://localhost:3265 EMAIL_OUTBOX_DIR=/path/to/outbox SHO_LOCAL_PASS=... \
//     npx tsx tests/e2e/tools/provision-local-admin.ts [--check]
//
// The address that must be the Super Admin is the one the server lists in SUPER_ADMIN_EMAILS (root.test@aplyd.com in
// tests/helpers.ts and the worker harness). It prints addresses and roles, never the password or the token.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export type Reply = { status: number; json: Record<string, unknown>; cookie: string | null };
export type Http = (method: "GET" | "POST", path: string, body?: unknown, cookie?: string | null) => Promise<Reply>;
export type Mail = { to: string; subject: string; text: string };
export type Slot = "admin" | "member";
export type Person = { slot: Slot; email: string; name: string; want: "SUPER_ADMIN" | "MEMBER" };
export type Row = { email: string; slot: Slot; state: "READY" | "WRONG_ROLE" | "WRONG_PASSWORD" | "NOT_VERIFIED" | "ERROR"; note: string };
export type Result = { rows: Row[]; ready: boolean };

/** The two accounts the story fixtures promise, at the addresses the local harness runs the server with. */
export const PEOPLE: Person[] = [
  { slot: "admin", email: "root.test@aplyd.com", name: "Root Test", want: "SUPER_ADMIN" },
  { slot: "member", email: "member.test@aplyd.com", name: "Member Test", want: "MEMBER" },
];

/** The newest "Verify" token mailed to `email`, or null: the server writes the mail, so this is a condition to poll. */
export function tokenFrom(mails: Mail[], email: string): string | null {
  const mine = mails.filter((m) => m.to === email && /Verify/.test(m.subject));
  return mine.at(-1)?.text.match(/token=([\w-]+)/)?.[1] ?? null;
}

/** Why `who` is not the account the `admin` / `member` fixture needs, or null when it is. */
export function roleProblem(slot: Slot, who: { orgRole?: unknown } | null): string | null {
  const want = PEOPLE.find((p) => p.slot === slot)!.want;
  const got = typeof who?.orgRole === "string" ? who.orgRole : "unknown";
  if (got === want) return null;
  if (slot === "admin") return `is ${got}, not SUPER_ADMIN: add this address to SUPER_ADMIN_EMAILS on the server and sign up again`;
  return `is ${got}, not MEMBER: the member fixture would exercise the wrong role`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Sign up (skipping an account that exists), verify it from the outbox, sign in and check the role. `readMails` is
 * injected so the decision can be tested without a server; `waitMs` bounds the wait for the Verify mail.
 */
export async function provision(opts: { people: Person[]; password: string; http: Http; readMails: () => Mail[]; waitMs?: number; pause?: number }): Promise<Result> {
  const { people, password, http, readMails } = opts;
  const waitMs = opts.waitMs ?? 15_000;
  const pause = opts.pause ?? 150;
  const rows: Row[] = [];
  const push = (p: Person, state: Row["state"], note = "") => rows.push({ email: p.email, slot: p.slot, state, note });

  for (const p of people) {
    const up = await http("POST", "/api/auth/signup", { name: p.name, email: p.email, password });
    if (up.status === 201) {
      const deadline = Date.now() + waitMs;
      // Read once before waiting: the mail may already be there, and a zero wait must still see it.
      let token = tokenFrom(readMails(), p.email);
      while (!token && Date.now() < deadline) {
        await sleep(pause);
        token = tokenFrom(readMails(), p.email);
      }
      if (!token) { push(p, "NOT_VERIFIED", "no Verify mail in EMAIL_OUTBOX_DIR: the tool and the server must read the same folder"); continue; }
      if ((await http("POST", "/api/auth/verify", { token })).status !== 200) { push(p, "NOT_VERIFIED", "the Verify token was refused"); continue; }
    } else if (up.status !== 409) {
      push(p, "ERROR", `sign-up: status ${up.status}`);
      continue;
    }

    // 409: an account from an earlier run, whose Verify link was followed then. Sign-in says whether it is usable.
    const signedIn = await http("POST", "/api/auth/signin", { email: p.email, password });
    if (signedIn.status !== 200) { push(p, "WRONG_PASSWORD", `sign in: status ${signedIn.status}${up.status === 409 ? " (the account exists with another password)" : ""}`); continue; }
    const me = await http("GET", "/api/auth/me", undefined, signedIn.cookie);
    const problem = roleProblem(p.slot, (me.json.user as { orgRole?: unknown } | undefined) ?? null);
    if (problem) { push(p, "WRONG_ROLE", problem); continue; }
    push(p, "READY", up.status === 201 ? "signed up and verified just now" : "already existed");
  }
  return { rows, ready: rows.length === people.length && rows.every((r) => r.state === "READY") };
}

/** One line per account plus a verdict; addresses and roles only, never a password or a token. */
export function report(result: Result): string {
  const lines = result.rows.map((r) => `  ${r.email} (${r.slot}): ${r.state}${r.note ? ` - ${r.note}` : ""}`);
  return [...lines, result.ready ? "READY: the story fixtures can sign in." : "NOT READY: see the states above."].join("\n");
}

/** Every mail the server has written into `dir`, oldest first; a folder that does not exist yet is simply empty. */
function readOutbox(dir: string): Mail[] {
  try { return readdirSync(dir).sort().map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")) as Mail); } catch { return []; }
}

function fetchHttp(base: string): Http {
  let cookie: string | null = null;
  return async (method, p, body, as) => {
    const res = await fetch(base + p, {
      method,
      headers: { "content-type": "application/json", ...(as ?? cookie ? { cookie: (as ?? cookie)! } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try { json = text ? (JSON.parse(text) as Record<string, unknown>) : {}; } catch { /* not JSON */ }
    return { status: res.status, json, cookie };
  };
}

async function main() {
  const check = process.argv.includes("--check");
  const base = process.env.TASKBOARD_URL ?? process.env.BASE_URL ?? "http://localhost:3100";
  const { hostname } = new URL(base);
  if (hostname !== "localhost" && hostname !== "127.0.0.1") throw new Error(`Refusing ${hostname}: this tool provisions a local server only (staging has its own alias pool).`);
  const outbox = process.env.EMAIL_OUTBOX_DIR ?? "";
  if (!outbox) throw new Error("Set EMAIL_OUTBOX_DIR to the folder the server writes its mail into.");
  const password = process.env.SHO_LOCAL_PASS ?? "";
  if (password.length < 8) throw new Error("Set SHO_LOCAL_PASS (8 characters or more) in the environment, not on the command line.");

  if (check) {
    // Changes nothing: sign in with what is there and say whether the fixtures would be handed the right roles.
    const http = fetchHttp(base);
    const rows: Row[] = [];
    for (const p of PEOPLE) {
      const signedIn = await http("POST", "/api/auth/signin", { email: p.email, password });
      if (signedIn.status !== 200) { rows.push({ email: p.email, slot: p.slot, state: "WRONG_PASSWORD", note: `sign in: status ${signedIn.status}` }); continue; }
      const me = await http("GET", "/api/auth/me", undefined, signedIn.cookie);
      const problem = roleProblem(p.slot, (me.json.user as { orgRole?: unknown } | undefined) ?? null);
      rows.push({ email: p.email, slot: p.slot, state: problem ? "WRONG_ROLE" : "READY", note: problem ?? "" });
    }
    const result = { rows, ready: rows.every((r) => r.state === "READY") };
    console.log(report(result));
    process.exitCode = result.ready ? 0 : 2;
    return;
  }

  const result = await provision({ people: PEOPLE, password, http: fetchHttp(base), readMails: () => readOutbox(outbox) });
  console.log(report(result));
  process.exitCode = result.ready ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : "Provisioning failed.");
    process.exitCode = 1;
  });
}
