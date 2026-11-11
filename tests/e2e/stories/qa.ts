// Shared pieces for the epic story specs. No password is written here.
// SHO_QA_PASS is the password for nakul17+ accounts these specs create.
// Mail is read from EMAIL_OUTBOX_DIR (or .outbox), the same folder the dev server writes when Resend is off.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { APIRequestContext, Browser, BrowserContext, Locator, Page } from "@playwright/test";
import { test as baseTest, api, expect, zz, RUN, BASE_URL, type Api, type Json, type Later } from "../support";

export { zz, RUN, BASE_URL, expect };

// The legacy shared fixture swallowed cleanup failures. These migrated specs must preserve every failure.
export const test = baseTest.extend<{ later: Later }>({
  later: async ({}, runFixture) => {
    const callbacks: (() => Promise<unknown>)[] = [];
    await runFixture(fn => { callbacks.push(fn); });
    const failures: unknown[] = [];
    for (const fn of callbacks.reverse()) {
      try {
        const result = await fn();
        if (result && typeof result === "object" && "status" in result && typeof result.status === "number" && result.status >= 400)
          throw new Error(`Cleanup API returned HTTP ${result.status}`);
      } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "SHO-2906 fixture cleanup failed");
  },
});
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

/** The next matching message in the sink. `previousToken` skips a link that was already read. Gives up after 60 seconds. */
export async function waitForSinkMail(email: string, subjectIncludes: string, previousToken?: string | null): Promise<SinkMail> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const hits = (await sinkMails(email))
      .filter((mail) => (mail.subject ?? "").includes(subjectIncludes))
      .map((mail) => ({ ...mail, token: mail.text?.match(/token=([\w-]+)/)?.[1] ?? "" }))
      .filter((mail) => mail.token && mail.token !== previousToken);
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
  expect(cur.status, "read person before cleanup").toBe(200);
  const off = await adminApi.post(`/api/team/${id}/deactivate`, { reassign: "leaders" });
  expect(off.status, JSON.stringify(off.json)).toBe(200);
  expect((await adminApi.get(`/api/team/${id}`)).json.person.status).toBe("DEACTIVATED");
}

/** Archive a project. If a test user became Leader, hand it back first so they can be deactivated. */
export async function archiveProject(adminApi: Api, id: string, adminId: string) {
  const loaded = await adminApi.get(`/api/projects/${id}`);
  if (loaded.status === 404) return;
  expect(loaded.status, "read project before cleanup").toBe(200);
  if (loaded.json.project?.archived) return;
  const members = (loaded.json.project?.members ?? []) as { userId: string; role: string }[];
  const leader = members.find((m) => m.role === "LEADER");
  if (leader && leader.userId !== adminId) {
    if (!members.some(m => m.userId === adminId)) {
      const joined = await adminApi.post(`/api/projects/${id}/members`, { userId: adminId, role: "EDITOR" });
      expect([201, 409], JSON.stringify(joined.json)).toContain(joined.status);
    }
    const moved = await adminApi.post(`/api/projects/${id}/leader`, { newLeaderId: adminId, previousRole: "EDITOR" });
    expect(moved.status, JSON.stringify(moved.json)).toBe(200);
  }
  const archived = await adminApi.post(`/api/projects/${id}/archive`);
  expect(archived.status, JSON.stringify(archived.json)).toBe(200);
  expect((await adminApi.get(`/api/projects/${id}`)).json.project.archived).toBe(true);
}

const UI = { timeout: 90_000 };

/** The page's main landmark. */
export function mainOf(page: Page) {
  return page.getByRole("main");
}

/** One Team table row whose text contains `text`. Callers assert a count of 1, so a shared `.first()` is not used. */
export function teamRow(page: Page, text: string) {
  return mainOf(page).getByRole("row").filter({ hasText: text });
}

/** Chip colours from app.css (.chip.grey, .chip.green, .chip.gold), read as computed styles instead of class names. */
export const CHIP = {
  grey: "rgb(236, 238, 241)",
  green: "rgb(232, 244, 236)",
  gold: "rgb(251, 239, 210)",
} as const;

/** The chip in `scope` whose whole text is `text`. */
export function chip(scope: Locator, text: string) {
  return scope.getByText(text, { exact: true });
}

/** The chip is visible and has that colour. */
export async function expectChip(scope: Locator, text: string, colour?: keyof typeof CHIP) {
  const c = chip(scope, text);
  await expect(c).toBeVisible();
  if (colour) {
    const dot = { grey: "rgb(108, 118, 134)", green: "rgb(32, 132, 68)", gold: "rgb(172, 118, 0)" };
    // Both approved Team renderings convey the same status: legacy filled chip or current colored dot.
    await expect.poll(() => c.evaluate((el, expected) =>
      getComputedStyle(el).backgroundColor === expected.chip ||
      getComputedStyle(el, "::before").backgroundColor === expected.dot,
      { chip: CHIP[colour], dot: dot[colour] })).toBe(true);
  }
}

/**
 * The columns of one Team row.
 * At 1024px and wider the header row is visible. Below that it is hidden and each cell shows its data-label.
 */
export async function expectTeamColumns(page: Page, row: Locator, labels: readonly string[]) {
  const head = mainOf(page).getByRole("row").filter({ has: page.getByRole("columnheader") });
  if (await head.isVisible()) {
    for (const label of labels) {
      const names = ["Role", "Workspace role"].includes(label) ? /^(Role|Workspace role)$/ : /^(Name|Email)$/.test(label) ? new RegExp(`^(${label}|Person)$`) : new RegExp(`^${label}$`);
      await expect(head.getByRole("columnheader", { name: names })).toHaveCount(1);
    }
    return;
  }
  const shown: string[] = [];
  for (const cell of await row.getByRole("cell").all()) {
    if (!(await cell.isVisible())) continue;
    const content = await cell.evaluate((el) => getComputedStyle(el, "::before").content);
    shown.push(content.replace(/^["']|["']$/g, ""));
  }
  for (const label of labels) {
    expect(shown.filter((l) => l === label || (["Role", "Workspace role"].includes(label) && ["Role", "Workspace role"].includes(l)) || (["Name", "Email"].includes(label) && l === "Person")), `visible ${label} label on the row`).toHaveLength(1);
  }
}

/** The Member-list link whose name is exactly `name`. */
export function memberItem(page: Page, name: string) {
  return mainOf(page).getByRole("link", { name, exact: true });
}

export async function openTeamActions(row: Locator, name: string) {
  if (!(await row.getByRole("button", { name: "Deactivate", exact: true }).isVisible()))
    await row.getByLabel(`More actions for ${name}`, { exact: true }).click();
}

/** The Super Admin adds a person from the Team page. Cleanup stays with the caller. */
export async function addPersonOnTeam(page: Page, first: string, last: string, email: string, role: "MEMBER" | "ADMIN" = "MEMBER") {
  await page.goto("/team");
  await mainOf(page).getByRole("button", { name: "+ Add person" }).click(UI);
  const dialog = page.getByRole("dialog", { name: "Add person" });
  await dialog.getByLabel("First name").fill(first);
  await dialog.getByLabel("Last name").fill(last);
  await dialog.getByLabel("Email").fill(email);
  if (role === "ADMIN") await dialog.getByLabel("Role").selectOption("ADMIN");
  await dialog.getByRole("button", { name: "Add and email" }).click();
  await expect(page.getByRole("status").filter({ hasText: `${first} ${last} was added` })).toBeVisible({ timeout: 120_000 });
}

/**
 * Deactivate that person from their own Team row.
 * The grey Deactivated chip is the result of this click, not of a status painted onto the page.
 */
export async function deactivateOnTeam(page: Page, name: string) {
  const row = teamRow(page, name);
  await expect(row).toHaveCount(1, UI);
  await openTeamActions(row, name);
  await row.getByRole("button", { name: "Deactivate", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: `Deactivate ${name}?` });
  await dialog.getByRole("button", { name: "Deactivate", exact: true }).click();
  const done = page.getByRole("dialog", { name: `${name} is deactivated` });
  await expect(done).toBeVisible({ timeout: 120_000 });
  await done.getByRole("button", { name: "Close" }).click();
  await expect(done).toBeHidden();
  await expect(chip(teamRow(page, name), "Deactivated")).toBeVisible(UI);
  await expectChip(teamRow(page, name), "Deactivated", "grey");
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
