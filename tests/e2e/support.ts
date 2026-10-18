// Shared helpers for the story specs. No credential is written here: all come from the environment.
import { test as base, expect, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";

import { BASE_URL } from "./base-url";

export { expect, BASE_URL };
export type { Page };

/** One id per run so names never clash between runs. */
export const RUN = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
/** Every record a spec creates is named with this prefix, so a person can find and delete leftovers. CI shards set ZZ_PREFIX=ZZ-TEST-NN. */
export const zz = (label: string) => `${process.env.ZZ_PREFIX || "ZZ-TEST"} ${label} ${RUN}`;

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Set ${name} in the environment (see playwright.config.ts).`);
  return v;
}

// Staging JSON has no schema here. `any` keeps `user.id` / `json.project` reads type-checking; a narrower type would force casts through the specs.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- open index signature for untyped API JSON
export type Json = Record<string, any>;
export type Api = {
  get: (p: string) => Promise<{ status: number; json: Json }>;
  post: (p: string, b?: unknown) => Promise<{ status: number; json: Json }>;
  patch: (p: string, b?: unknown) => Promise<{ status: number; json: Json }>;
  put: (p: string, b?: unknown) => Promise<{ status: number; json: Json }>;
  del: (p: string) => Promise<{ status: number; json: Json }>;
};

/** The signed-in `admin` / `member` fixture these specs receive. */
export type Who = { page: Page; api: Api; user: Json };
/** Clean-up registrar passed as the `later` fixture. */
export type Later = (fn: () => Promise<unknown>) => void;

/** A task change must name the version the screen is showing (APL-2648 / APL-2668). */
export async function withTaskVersion(api: Api, id: string, body: Record<string, unknown> = {}) {
  const seen = (await api.get(`/api/tasks/${id}`)).json?.task?.updatedAt as string | undefined;
  if (!seen) throw new Error(`Task ${id} has no updatedAt, so the change cannot name its version.`);
  return { ...body, expectedUpdatedAt: seen };
}

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

type Role = "ADMIN" | "MEMBER";
type Account = { email: string; password: string; from: string };

/**
 * The account a fixture signs in as. A CI shard sets SHARD_EMAIL / SHARD_PASS / SHARD_ROLE (its own ZZ_TEST_NN account) and
 * PEER_EMAIL / PEER_PASS / PEER_ROLE (a ZZ account of the other role); the role each one names uses it. Otherwise, and in the
 * serial job and local runs, it is SHO_ADMIN_* / SHO_MEMBER_* as before.
 */
function account(role: Role): Account | null {
  const env = process.env;
  for (const k of ["SHARD", "PEER"]) {
    if (env[`${k}_ROLE`] === role && env[`${k}_EMAIL`] && env[`${k}_PASS`]) return { email: env[`${k}_EMAIL`]!, password: env[`${k}_PASS`]!, from: `${k}_*` };
  }
  const k = role === "ADMIN" ? "SHO_ADMIN" : "SHO_MEMBER";
  return env[`${k}_EMAIL`] && env[`${k}_PASS`] ? { email: env[`${k}_EMAIL`]!, password: env[`${k}_PASS`]!, from: `${k}_*` } : null;
}

/** The email and password the `admin` / `member` fixture signs in with, for specs that sign in by hand. */
export function login(role: Role): Account {
  const k = role === "ADMIN" ? "SHO_ADMIN" : "SHO_MEMBER";
  return account(role) ?? { email: need(`${k}_EMAIL`), password: need(`${k}_PASS`), from: `${k}_*` };
}

export const hasMember = () => !!account("MEMBER");

type Fixtures = {
  /** A page signed in as the Super Admin: login("ADMIN"), which is SHO_ADMIN_EMAIL / SHO_ADMIN_PASS outside CI shards. */
  admin: { page: Page; api: Api; user: Json };
  /** A page signed in as the plain Member: login("MEMBER"), SHO_MEMBER_* outside CI shards. Skips the test when none is set. */
  member: { page: Page; api: Api; user: Json };
  /** Register a clean-up. Runs after the test, newest first, and never fails the test. */
  later: (fn: () => Promise<unknown>) => void;
  /** A browser context with no sign-in. */
  anon: Page;
};

/** The fixtures promise a Super Admin and a plain Member; a ZZ account with another role would test the wrong thing. */
const WANT: Record<Role, string> = { ADMIN: "SUPER_ADMIN", MEMBER: "MEMBER" };

async function as(browser: Browser, role: Role) {
  const { email, password: pw, from } = login(role);
  const ctx = await browser.newContext({
    baseURL: BASE_URL,
    httpCredentials: process.env.STAGING_USER ? { username: process.env.STAGING_USER, password: process.env.STAGING_PASS ?? "" } : undefined,
  });
  const user = await signIn(ctx, email, pw);
  if (from !== "SHO_ADMIN_*" && from !== "SHO_MEMBER_*" && user.orgRole !== WANT[role]) {
    await ctx.close();
    throw new Error(`The ${role} account from ${from} is ${user.orgRole} on staging, not ${WANT[role]}. Fix its role (Super Admins come from SUPER_ADMIN_EMAILS).`);
  }
  const page = await ctx.newPage();
  return { ctx, page, api: api(ctx.request), user };
}

// Playwright fixture callbacks are named `use`. That is the fixture runner, not React's `use`.
/* eslint-disable react-hooks/rules-of-hooks -- Playwright fixture `use`, not a React hook */
export const test = base.extend<Fixtures>({
  admin: async ({ browser }, use) => {
    const s = await as(browser, "ADMIN");
    await use({ page: s.page, api: s.api, user: s.user });
    await s.ctx.close();
  },
  member: async ({ browser }, use, info) => {
    if (!hasMember()) { info.skip(true, "Needs SHO_MEMBER_EMAIL and SHO_MEMBER_PASS (a plain Member account on staging)."); return; }
    const s = await as(browser, "MEMBER");
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
      baseURL: BASE_URL,
      httpCredentials: process.env.STAGING_USER ? { username: process.env.STAGING_USER, password: process.env.STAGING_PASS ?? "" } : undefined,
    });
    await use(await ctx.newPage());
    await ctx.close();
  },
});
/* eslint-enable react-hooks/rules-of-hooks */
