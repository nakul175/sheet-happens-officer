// Shared pieces for the epic story specs. No password is written here.
// SHO_QA_PASS is the password for nakul17+ accounts these specs create.
// Mail is read from EMAIL_OUTBOX_DIR (or .outbox), the same folder the dev server writes when Resend is off.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { APIRequestContext, Browser, BrowserContext, Page } from "@playwright/test";
import { api, expect, zz, RUN, BASE_URL, type Api, type Json } from "../support";

export { zz, RUN, BASE_URL, expect };
export type { Api, Json };

export const PASS = process.env.SHO_QA_PASS ?? "";
const OUTBOX = process.env.EMAIL_OUTBOX_DIR ?? path.join(process.cwd(), ".outbox");

export function passwordOk(pass: string) {
  return pass.length >= 8 && pass.length <= 128 && /[A-Za-z]/.test(pass) && /[0-9]/.test(pass);
}

/** A second password derived at runtime, so the file never contains a password literal. */
export function nextPass(current: string) {
  let n = current.slice(1) + current.slice(0, 1);
  if (!/[A-Za-z]/.test(n)) n = `a${n}`;
  if (!/[0-9]/.test(n)) n = `${n}9`;
  if (n === current) n = `${n}9`;
  return n.slice(0, 128);
}

export function alias(issue: string, tag: string, domain = "gmail.com") {
  return `nakul17+zz-${issue}-${tag}-${RUN}@${domain}`;
}

type Mail = { to?: string; subject?: string; text?: string };

function mailsTo(email: string): Mail[] {
  let files: string[] = [];
  try { files = readdirSync(OUTBOX); } catch { return []; }
  const want = email.toLowerCase();
  const out: Mail[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const mail = JSON.parse(readFileSync(path.join(OUTBOX, file), "utf8")) as Mail;
      if (mail.to?.toLowerCase() === want) out.push(mail);
    } catch { /* a half-written file */ }
  }
  return out;
}

export function mailToken(email: string, subjectIncludes: string) {
  const mail = mailsTo(email).filter((m) => (m.subject ?? "").includes(subjectIncludes)).at(-1);
  return mail?.text?.match(/token=([\w-]+)/)?.[1] ?? null;
}

/**
 * Token from the local outbox, or from MAIL_SINK_URL when that is set.
 * Returns null at once when neither has the message, so a staging run with no sink does not wait.
 */
export async function sinkToken(email: string, subjectIncludes: string, waitMs = 3000): Promise<string | null> {
  const immediate = mailToken(email, subjectIncludes);
  if (immediate || !process.env.MAIL_SINK_URL) return immediate;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const hits = (await sinkMails(email))
      .filter((mail) => (mail.subject ?? "").includes(subjectIncludes))
      .map((mail) => mail.text?.match(/token=([\w-]+)/)?.[1] ?? "")
      .filter(Boolean);
    if (hits.at(-1)) return hits.at(-1)!;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return null;
}

/** Plain text of the newest matching message, or null when the sink has none. */
export async function sinkText(email: string, subjectIncludes: string, waitMs = 3000): Promise<string | null> {
  const local = latestMail(email, subjectIncludes);
  if (local || !process.env.MAIL_SINK_URL) return local;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const hits = (await sinkMails(email)).filter((mail) => (mail.subject ?? "").includes(subjectIncludes));
    const text = hits.at(-1)?.text;
    if (text) return text;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return null;
}

type SinkMail = Mail & { token: string };

function sinkRow(row: unknown): Mail | null {
  if (!row || typeof row !== "object") return null;
  const rec = row as { to?: unknown; To?: unknown; subject?: unknown; Subject?: unknown; text?: unknown; Text?: unknown };
  const to = typeof rec.to === "string" ? rec.to
    : typeof rec.To === "string" ? rec.To
    : Array.isArray(rec.To) ? rec.To.map((item) => (item && typeof item === "object" && "Address" in item ? String((item as { Address?: unknown }).Address ?? "") : "")).filter(Boolean).join(",")
    : "";
  const subject = typeof rec.subject === "string" ? rec.subject : typeof rec.Subject === "string" ? rec.Subject : "";
  const text = typeof rec.text === "string" ? rec.text : typeof rec.Text === "string" ? rec.Text : "";
  if (!to && !subject) return null;
  return { to, subject, text };
}

/** JSON messages from the staging test mail sink: the outbox folder, and MAIL_SINK_URL when that folder is exposed over HTTP. */
async function sinkMails(email: string): Promise<Mail[]> {
  const want = email.toLowerCase();
  const found = mailsTo(email);
  const url = process.env.MAIL_SINK_URL;
  if (!url) return found;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return found;
    const json = await res.json() as unknown;
    const rows = Array.isArray(json) ? json : (json && typeof json === "object" ? ((json as { messages?: unknown; items?: unknown }).messages ?? (json as { items?: unknown }).items) : []);
    if (!Array.isArray(rows)) return found;
    for (const row of rows) {
      const mail = sinkRow(row);
      if (mail?.to?.toLowerCase() === want) found.push(mail);
    }
  } catch { /* the sink is not up yet; the caller keeps polling */ }
  return found;
}

/** Every matching message currently in the outbox or the staging mail sink. */
export async function matchingMails(email: string, subjectIncludes: string): Promise<SinkMail[]> {
  return (await sinkMails(email))
    .filter((mail) => (mail.subject ?? "").includes(subjectIncludes))
    .map((mail) => ({ ...mail, token: mail.text?.match(/token=([\w-]+)/)?.[1] ?? "" }));
}

/** The next matching message in the sink. `previousToken` skips a link that was already read. Gives up after 60 seconds. */
export async function waitForSinkMail(email: string, subjectIncludes: string, previousToken?: string | null): Promise<SinkMail> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    // Verify and reset mails carry a token. The add-person mail does not, and still counts.
    // When a previous token is named, wait for a different link and ignore token-less mail.
    const hits = (await matchingMails(email, subjectIncludes)).filter((mail) => !previousToken || (mail.token && mail.token !== previousToken));
    const hit = hits.at(-1);
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`No ${subjectIncludes} message for ${email} in the test mail sink within 60 seconds.`);
}

export function latestMail(email: string, subjectIncludes: string) {
  const mail = mailsTo(email).filter((m) => (m.subject ?? "").includes(subjectIncludes)).at(-1);
  return mail?.text ?? null;
}

export function mailedPassword(email: string) {
  return latestMail(email, "Your Sheet Happens Officer account")?.match(/^Password: (.+)$/m)?.[1] ?? null;
}

/** First check of every spec: /api/health names the release SHA, and the body does not contain the password. */
export async function gate(request: APIRequestContext) {
  const res = await request.get("/api/health");
  const body = await res.text();
  const pass = PASS;
  expect(res.status(), body).toBe(200);
  const json = JSON.parse(body) as { ok?: boolean; release?: unknown };
  expect(json.ok).toBe(true);
  expect(typeof json.release === "string" && json.release.length >= 7, "release SHA from /api/health").toBe(true);
  expect(body.includes(pass)).toBe(false);
}

export type Who = { ctx: BrowserContext; page: Page; api: Api; user: Json };

export async function signInAs(browser: Browser, email: string, password: string): Promise<Who> {
  const ctx = await browser.newContext({
    baseURL: BASE_URL,
    httpCredentials: process.env.STAGING_USER ? { username: process.env.STAGING_USER, password: process.env.STAGING_PASS ?? "" } : undefined,
  });
  const res = await ctx.request.post("/api/auth/signin", { data: { email, password } });
  const body = await res.text();
  const pass = password;
  expect(body.includes(pass)).toBe(false);
  expect(res.ok(), `sign in ${email} (${res.status()})`).toBe(true);
  const user = JSON.parse(body).user as Json;
  const page = await ctx.newPage();
  return { ctx, page, api: api(ctx.request), user };
}

export async function signUp(request: APIRequestContext, name: string, email: string, password = PASS) {
  const res = await request.post("/api/auth/signup", { data: { name, email, password } });
  const body = await res.text();
  const pass = password;
  expect(body.includes(pass)).toBe(false);
  let json: Json = {};
  try { json = body ? JSON.parse(body) : {}; } catch { /* not JSON */ }
  return { status: res.status(), body, json };
}

export async function verifiedUser(browser: Browser, request: APIRequestContext, issue: string, tag: string) {
  const email = alias(issue, tag, "aplyd.com");
  const name = zz(`${issue} ${tag}`);
  const signed = await signUp(request, name, email);
  expect(signed.status, signed.body).toBe(201);
  expect(signed.json.status).toBe("check_email");
  const token = mailToken(email, "Verify");
  expect(token, `verification mail for ${email} in the outbox`).toBeTruthy();
  const verified = await request.post("/api/auth/verify", { data: { token } });
  expect(verified.ok(), await verified.text()).toBe(true);
  const who = await signInAs(browser, email, PASS);
  return { email, name, ...who };
}

export async function personByEmail(adminApi: Api, email: string) {
  const people = ((await adminApi.get("/api/team")).json.people ?? []) as { id: string; email?: string; name: string; status?: string; orgRole?: string }[];
  return people.find((p) => p.email?.toLowerCase() === email.toLowerCase()) ?? null;
}

export async function deactivate(adminApi: Api, id: string) {
  const cur = await adminApi.get(`/api/team/${id}`);
  if (cur.status === 404 || cur.json.person?.status === "DEACTIVATED") return;
  await adminApi.post(`/api/team/${id}/deactivate`, { reassign: "leaders" });
}

/** Archive a project. If a test user became Leader, hand it back first so they can be deactivated. */
export async function archiveProject(adminApi: Api, id: string, adminId: string) {
  const loaded = await adminApi.get(`/api/projects/${id}`);
  if (loaded.status !== 200 || loaded.json.project?.archived) return;
  const members = (loaded.json.project?.members ?? []) as { userId: string; role: string }[];
  const leader = members.find((m) => m.role === "LEADER");
  if (leader && leader.userId !== adminId) {
    await adminApi.post(`/api/projects/${id}/leader`, { newLeaderId: adminId, previousRole: "EDITOR" });
  }
  await adminApi.post(`/api/projects/${id}/archive`);
}

const localHost = () => {
  try { return ["localhost", "127.0.0.1"].includes(new URL(BASE_URL).hostname); } catch { return false; }
};

/**
 * One read-only or single-statement query against the local database.
 * Staging's runner has no database (and is not localhost), so this returns null there.
 * Values go through psql variables (`:'name'`), never string concatenation.
 */
function localSql(sql: string, vars: Record<string, string>): string | null {
  if (!localHost()) return null;
  const url = process.env.DATABASE_URL ?? "";
  if (!url || url.includes("@127.0.0.1:1/")) return null;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  const args = [
    "-h", parsed.hostname,
    "-p", parsed.port || "5432",
    "-U", decodeURIComponent(parsed.username),
    "-d", decodeURIComponent(parsed.pathname.replace(/^\//, "")),
    "-v", "ON_ERROR_STOP=1",
    "-At",
  ];
  for (const [name, value] of Object.entries(vars)) args.push("-v", `${name}=${value}`);
  // psql does not interpolate :'variables' inside -c. The statement goes on stdin.
  try {
    return execFileSync("psql", args, {
      input: sql,
      env: { ...process.env, PGPASSWORD: decodeURIComponent(parsed.password) },
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

/** The stored password hash for a local run, or null when this runner cannot see the database. */
export function localPasswordHash(email: string): Promise<string | null> {
  const row = localSql(`SELECT "passwordHash" FROM "User" WHERE email = :'email'`, { email: email.toLowerCase() });
  return Promise.resolve(row ? row : null);
}

/** True when the raw token is stored only as a sha256 hash. Null when the database is not reachable. */
export async function localTokenIsHashed(raw: string): Promise<boolean | null> {
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(raw).digest("hex");
  const row = localSql(`SELECT "tokenHash" FROM "AuthToken" WHERE "tokenHash" = :'hash'`, { hash });
  if (row === null) return null;
  if (!row) return false;
  return row === hash && row !== raw;
}

/** Move this person's open sessions into the past so the server treats them as the 30-day end. */
export function expireLocalSessions(email: string): Promise<boolean | null> {
  const count = localSql(
    `WITH moved AS (
       UPDATE "Session" SET "expiresAt" = NOW() - interval '1 second'
       WHERE "revokedAt" IS NULL
         AND "userId" = (SELECT id FROM "User" WHERE email = :'email')
       RETURNING 1
     ) SELECT count(*)::text FROM moved`,
    { email: email.toLowerCase() },
  );
  if (count === null) return Promise.resolve(null);
  return Promise.resolve(Number(count) > 0);
}

export async function makeProject(adminApi: Api, label: string, leaderId: string) {
  const name = zz(label);
  const created = await adminApi.post("/api/projects", { name, leaderId });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const id = created.json.project.id as string;
  const loaded = await adminApi.get(`/api/projects/${id}`);
  expect(loaded.status).toBe(200);
  const sections = loaded.json.project.sections as { id: string; name: string; isDone: boolean }[];
  return {
    id,
    name,
    todo: sections[0].id,
    doing: sections[1].id,
    done: sections.find((s) => s.isDone)!.id,
  };
}
