// APL-2624 keeps its local outbox mode and uses the authenticated sink on staging.
// No database access, privilege grant, or production target is permitted here.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { BASE_URL } from "./base-url";
import { waitForMail, mailSinkHeaders } from "../mail-sink-client";
export const BASE = BASE_URL;
const local = /^(localhost|127\.0\.0\.1)$/.test(new URL(BASE).hostname);
export const SINK = process.env.SHO_MAILBOX_MODE === "sink" || !local;
export const PW = SINK ? process.env.SHO_QA_PASS ?? "" : "correct-horse-9";
export const ADMIN_PW = SINK ? process.env.SHO_ADMIN_PASS ?? "" : PW;
export const browserCredentials = process.env.STAGING_USER ? { username: process.env.STAGING_USER, password: process.env.STAGING_PASS ?? "" } : undefined;
export function requirePasswordFixture() {
  if (!local && !/^pr9\.staging\.sheethappensofficer\.com$/.test(new URL(BASE).hostname)) throw new Error("Password acceptance is restricted to local or isolated slot9.");
  if (SINK && (!process.env.SHO_QA_PASS || !process.env.SHO_ADMIN_EMAIL || !process.env.SHO_ADMIN_PASS || !process.env.MAIL_SINK_TOKEN)) throw new Error("Set SHO_QA_PASS, SHO_ADMIN_EMAIL, SHO_ADMIN_PASS and MAIL_SINK_TOKEN for mailbox acceptance.");
  if (!SINK && (process.env.TASKBOARD_URL ?? "http://localhost:3000").replace(/\/$/, "") !== BASE.replace(/\/$/, "")) throw new Error("Set TASKBOARD_URL to the same local target as BASE_URL.");
  if (!SINK && !process.env.EMAIL_OUTBOX_DIR) throw new Error("Set EMAIL_OUTBOX_DIR for local password acceptance.");
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches the existing local-api boundary
export type Reply = { status: number; json: any };
export class Client {
  cookie = "";
  async call(method: string, p: string, body?: unknown): Promise<Reply> {
    const authorization = browserCredentials ? `Basic ${Buffer.from(`${browserCredentials.username}:${browserCredentials.password}`).toString("base64")}` : undefined;
    const res = await fetch(BASE + p, { method, headers: { "content-type": "application/json", ...(this.cookie ? { cookie: this.cookie } : {}), ...(authorization ? { authorization } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    const set = res.headers.get("set-cookie"); if (set) this.cookie = set.split(";")[0];
    const text = await res.text(); return { status: res.status, json: text && res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : null };
  }
  get = (p: string) => this.call("GET", p);
  post = (p: string, b?: unknown) => this.call("POST", p, b ?? {});
  patch = (p: string, b?: unknown) => this.call("PATCH", p, b);
  put = (p: string, b?: unknown) => this.call("PUT", p, b);
  del = (p: string) => this.call("DELETE", p);
}
export type Account = { c: Client; id: string; email: string; name: string };
function must(r: Reply, status: number) { if (r.status !== status) throw new Error(`Password fixture request failed: expected ${status}, got ${r.status}.`); return r; }
export async function mailText(email: string, subject: RegExp, previousPassword?: string): Promise<string> {
  const deadline = Date.now() + 60_000;
  do {
    let text = "";
    if (SINK) text = (await waitForMail(email, subject, { baseUrl: BASE, timeoutMs: Math.max(1, deadline - Date.now()) })).text;
    else {
      const dir = process.env.EMAIL_OUTBOX_DIR!;
      const messages = readdirSync(dir).sort().map(f => JSON.parse(readFileSync(path.join(dir, f), "utf8"))).filter(m => m.to === email && subject.test(m.subject));
      text = messages.at(-1)?.text ?? "";
    }
    if (text && (!previousPassword || !text.includes(`Password: ${previousPassword}`))) return text;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error("Timed out waiting for a fresh fixture email.");
}
export async function account(name: string, email: string): Promise<Account> {
  if (!SINK) return (await import("./local-api")).account(name, email);
  const c = new Client(); must(await c.post("/api/auth/signup", { name, email, password: PW }), 201);
  const token = (await mailText(email, /Verify/)).match(/token=([\w-]+)/)?.[1];
  if (!token) throw new Error("Verification token missing from fixture email.");
  must(await c.post("/api/auth/verify", { token }), 200);
  const signed = must(await c.post("/api/auth/signin", { email, password: PW }), 200);
  return { c, id: signed.json.user.id, email, name };
}
export async function superAdmin(): Promise<Account> {
  requirePasswordFixture();
  if (!SINK) return (await import("./local-api")).superAdmin();
  // Prove mail capture is armed before any synthetic account creation can send mail.
  const probe = new URL("/api/qa/mail", BASE);
  probe.searchParams.set("to", "nakul17+zz-2624-preflight@aplyd.com");
  const mailbox = await fetch(probe, { headers: mailSinkHeaders(process.env.MAIL_SINK_TOKEN!), redirect: "manual" });
  if (mailbox.status !== 200 || !Array.isArray(await mailbox.json())) throw new Error("The authenticated staging mailbox is not ready.");
  const c = new Client(); const email = process.env.SHO_ADMIN_EMAIL!;
  const signed = must(await c.post("/api/auth/signin", { email, password: ADMIN_PW }), 200);
  if (signed.json.user?.orgRole !== "SUPER_ADMIN") throw new Error("Password fixture requires an existing slot9 Super Admin.");
  return { c, id: signed.json.user.id, email, name: signed.json.user.name };
}
