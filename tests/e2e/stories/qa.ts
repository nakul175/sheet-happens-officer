// Shared pieces for the epic story specs. No password is written here.
// SHO_QA_PASS is the password for nakul17+ accounts these specs create.
// Mail is read from EMAIL_OUTBOX_DIR (or .outbox), the same folder the dev server writes when Resend is off.
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
