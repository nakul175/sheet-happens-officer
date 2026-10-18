// Shared helpers for the story specs. No credential is written here: all come from the environment.
import { test as base, expect, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";

export { expect };

/** One id per run so names never clash between runs. */
export const RUN = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
/** Every record a spec creates is named with this prefix, so a person can find and delete leftovers. */
export const zz = (label: string) => `ZZ-TEST ${label} ${RUN}`;

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Set ${name} in the environment (see playwright.config.ts).`);
  return v;
}

export type Json = Record<string, any>;
export type Api = {
  get: (p: string) => Promise<{ status: number; json: Json }>;
  post: (p: string, b?: unknown) => Promise<{ status: number; json: Json }>;
  patch: (p: string, b?: unknown) => Promise<{ status: number; json: Json }>;
  put: (p: string, b?: unknown) => Promise<{ status: number; json: Json }>;
  del: (p: string) => Promise<{ status: number; json: Json }>;
};

export function api(req: APIRequestContext): Api {
  const call = async (method: string, p: string, data?: unknown) => {
    const r = await req.fetch(p, { method, data: data === undefined ? undefined : data, headers: { "content-type": "application/json" } });
    let json: Json = {};
    try { json = await r.json(); } catch { /* not JSON */ }
    return { status: r.status(), json };
  };
  return {
    get: (p) => call("GET", p),
    post: (p, b) => call("POST", p, b ?? {}),
    patch: (p, b) => call("PATCH", p, b),
    put: (p, b) => call("PUT", p, b),
    del: (p) => call("DELETE", p),
  };
}

async function signIn(ctx: BrowserContext, email: string, password: string) {
  const r = await ctx.request.post("/api/auth/signin", { data: { email, password } });
  expect(r.ok(), `sign in as ${email} (status ${r.status()})`).toBe(true);
  return (await r.json()).user as Json;
}

export const hasMember = () => !!(process.env.SHO_MEMBER_EMAIL && process.env.SHO_MEMBER_PASS);

type Fixtures = {
  /** A page signed in as the Super Admin from SHO_ADMIN_EMAIL / SHO_ADMIN_PASS. */
  admin: { page: Page; api: Api; user: Json };
  /** A page signed in as the plain Member from SHO_MEMBER_EMAIL / SHO_MEMBER_PASS. Skips the test when those are not set. */
  member: { page: Page; api: Api; user: Json };
  /** Register a clean-up. Runs after the test, newest first, and never fails the test. */
  later: (fn: () => Promise<unknown>) => void;
  /** A browser context with no sign-in. */
  anon: Page;
};

async function as(browser: Browser, email: string, pw: string) {
  const ctx = await browser.newContext({
    baseURL: process.env.STAGING_URL ?? "https://staging.sheethappensofficer.com",
    httpCredentials: process.env.STAGING_USER ? { username: process.env.STAGING_USER, password: process.env.STAGING_PASS ?? "" } : undefined,
  });
  const user = await signIn(ctx, email, pw);
  const page = await ctx.newPage();
  return { ctx, page, api: api(ctx.request), user };
}

export const test = base.extend<Fixtures>({
  admin: async ({ browser }, use) => {
    const s = await as(browser, need("SHO_ADMIN_EMAIL"), need("SHO_ADMIN_PASS"));
    await use({ page: s.page, api: s.api, user: s.user });
    await s.ctx.close();
  },
  member: async ({ browser }, use, info) => {
    if (!hasMember()) { info.skip(true, "Needs SHO_MEMBER_EMAIL and SHO_MEMBER_PASS (a plain Member account on staging)."); return; }
    const s = await as(browser, need("SHO_MEMBER_EMAIL"), need("SHO_MEMBER_PASS"));
    await use({ page: s.page, api: s.api, user: s.user });
    await s.ctx.close();
  },
  later: async ({}, use) => {
    const fns: (() => Promise<unknown>)[] = [];
    await use((fn) => { fns.push(fn); });
    for (const fn of fns.reverse()) { try { await fn(); } catch { /* clean-up is best effort */ } }
  },
  anon: async ({ browser }, use) => {
    const ctx = await browser.newContext({
      baseURL: process.env.STAGING_URL ?? "https://staging.sheethappensofficer.com",
      httpCredentials: process.env.STAGING_USER ? { username: process.env.STAGING_USER, password: process.env.STAGING_PASS ?? "" } : undefined,
    });
    await use(await ctx.newPage());
    await ctx.close();
  },
});
