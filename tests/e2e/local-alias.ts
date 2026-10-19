// Accounts for story specs that start their own local server. The password is SHO_QA_PASS and is never written here.
// A local server has no mail provider, so the verification link is read from that server's outbox folder,
// the same way tests/e2e/helpers/qa-alias.ts on qa/story-e2e does. Every auth answer is checked so the password is not echoed.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const QA_PASS = process.env.SHO_QA_PASS ?? "";

export type Answer = { status: number; text: string; json: Record<string, unknown> | null; cookie: string };

/** One JSON call. Keeps the sho_session cookie the server sets, or the one passed in. */
export async function call(base: string, cookie: string, method: string, p: string, body?: unknown): Promise<Answer> {
  const res = await fetch(base + p, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sets = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  const session = sets.map((line) => line.split(";")[0]).find((line) => line.startsWith("sho_session="));
  const text = await res.text();
  if (QA_PASS && text.includes(QA_PASS)) throw new Error(`${method} ${p} echoed the password`);
  const json = text && res.headers.get("content-type")?.includes("json") ? (JSON.parse(text) as Record<string, unknown>) : null;
  return { status: res.status, text, json, cookie: session ?? cookie };
}

function verifyToken(outbox: string, email: string) {
  let files: string[] = [];
  try { files = readdirSync(outbox).filter((f) => f.endsWith(".json")).sort(); } catch { return null; }
  const mails = files.map((f) => JSON.parse(readFileSync(path.join(outbox, f), "utf8")) as { to?: string; subject?: string; text?: string });
  return mails.filter((m) => m.to === email && /Verify/.test(m.subject ?? "")).at(-1)?.text?.match(/token=([\w-]+)/)?.[1] ?? null;
}

/** Signs up, verifies and signs in a new nakul17+ alias on a local server whose mail goes to `outbox`.
 *  `password` defaults to SHO_QA_PASS; local-alias.test.ts passes a ZZ-TEST value so it runs without SHO_QA_PASS. */
export async function signUpAlias(base: string, outbox: string, email: string, name: string, password = QA_PASS) {
  if (!password) throw new Error("Set SHO_QA_PASS (the password for nakul17+ aliases).");
  const created = await call(base, "", "POST", "/api/auth/signup", { name, email, password });
  if (created.status !== 201) throw new Error(`signup ${email}: ${created.status} ${created.text}`);
  const token = verifyToken(outbox, email);
  if (!token) throw new Error(`no verification mail for ${email}`);
  const verified = await call(base, "", "POST", "/api/auth/verify", { token });
  if (verified.status !== 200) throw new Error(`verify ${email}: ${verified.status}`);
  const signed = await call(base, "", "POST", "/api/auth/signin", { email, password });
  if (signed.status !== 200) throw new Error(`signin ${email}: ${signed.status}`);
  const user = signed.json?.user as { id: string; orgRole: string };
  return { id: user.id, orgRole: user.orgRole, name, email, cookie: signed.cookie };
}
