// Smoke-suite helpers. Credentials are read from the environment and never written into errors,
// logs, or assertion messages.
//
// Sign-in is not read-only. POST /api/auth/signin deletes login attempts, may update orgRole,
// creates a session row (src/lib/auth.ts startSession), and writes a SIGN_IN audit row.
// A later request also updates session.lastSeenAt once it is older than five minutes.
// @readonly tests therefore stay signed out and may only issue GET. @write tests sign in,
// and they run only when the target host is staging.
import { test as base, expect, type APIRequestContext, type Browser, type BrowserContext, type Page, type TestInfo } from "@playwright/test";

export { expect };

const PRODUCTION = new Set(["sheethappensofficer.com", "www.sheethappensofficer.com", "app.sheethappensofficer.com"]);

export function appBaseURL(): string {
  return (process.env.BASE_URL || process.env.STAGING_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
}

export function appHost(raw = appBaseURL()): string {
  let host = "";
  try {
    host = new URL(raw).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    host = "";
  }
  if (!host) throw new Error("BASE_URL is not a URL.");
  return host;
}

/** The staging apex and any host under it. Production and localhost are not staging. */
export function isStagingHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return h === "staging.sheethappensofficer.com" || h.endsWith(".staging.sheethappensofficer.com");
}

/** Hard stop for @write. No request is made when this throws. */
export function refuseUnlessStaging(): void {
  const host = appHost();
  if (PRODUCTION.has(host) || !isStagingHost(host)) {
    throw new Error(
      `Refusing @write smoke tests on ${host}. They run only on staging.sheethappensofficer.com or a *.staging.sheethappensofficer.com host.`,
    );
  }
}

export const RUN = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
export const zz = (label: string) => `${process.env.ZZ_PREFIX || "ZZ-TEST"} ${label} ${RUN}`;

type Role = "ADMIN" | "MEMBER";

function account(role: Role): { email: string; password: string } {
  const env = process.env;
  for (const k of ["SHARD", "PEER"]) {
    if (env[`${k}_ROLE`] === role && env[`${k}_EMAIL`] && env[`${k}_PASS`]) {
      return { email: env[`${k}_EMAIL`]!, password: env[`${k}_PASS`]! };
    }
  }
  const zzName = role === "ADMIN" ? "ZZ_TEST_01" : "ZZ_TEST_06";
  if (env[`${zzName}_EMAIL`] && env[`${zzName}_PASS`]) {
    return { email: env[`${zzName}_EMAIL`]!, password: env[`${zzName}_PASS`]! };
  }
  const sho = role === "ADMIN" ? "SHO_ADMIN" : "SHO_MEMBER";
  if (env[`${sho}_EMAIL`] && env[`${sho}_PASS`]) {
    return { email: env[`${sho}_EMAIL`]!, password: env[`${sho}_PASS`]! };
  }
  throw new Error(
    `Set ${zzName}_EMAIL and ${zzName}_PASS (or ${sho}_EMAIL and ${sho}_PASS, or SHARD_*/PEER_* for this role). Values are not printed.`,
  );
}

/** The ZZ-TEST accounts are nakul17+ aliases. The address is not included when this fails. */
export function assertNakulAlias(email: string): void {
  const local = email.split("@")[0] ?? "";
  if (!local.startsWith("nakul17+")) {
    throw new Error("The ZZ-TEST sign-in account is not a nakul17+ alias. The address was not printed.");
  }
}

export type Json = Record<string, any>;
export type Api = {
  get: (p: string) => Promise<{ status: number; json: Json }>;
  post: (p: string, b?: unknown) => Promise<{ status: number; json: Json }>;
  patch: (p: string, b?: unknown) => Promise<{ status: number; json: Json }>;
  del: (p: string) => Promise<{ status: number; json: Json }>;
};

export function api(req: APIRequestContext): Api {
  const call = async (method: string, p: string, data?: unknown) => {
    const r = await req.fetch(p, {
      method,
      data: data === undefined ? undefined : data,
      headers: { "content-type": "application/json" },
    });
    let json: Json = {};
    try {
      json = await r.json();
    } catch {
      /* empty or not JSON */
    }
    return { status: r.status(), json };
  };
  return {
    get: (p) => call("GET", p),
    post: (p, b) => call("POST", p, b ?? {}),
    patch: (p, b) => call("PATCH", p, b),
    del: (p) => call("DELETE", p),
  };
}

function httpCredentials() {
  return process.env.STAGING_USER
    ? { username: process.env.STAGING_USER, password: process.env.STAGING_PASS ?? "" }
    : undefined;
}

export type Session = {
  page: Page;
  api: Api;
  context: BrowserContext;
  user: { id: string; orgRole: string };
  /** ZZ-TEST projects to archive after the test, including when the test fails. */
  projects: string[];
  /** ZZ-TEST tasks to delete after the test. A second delete (already gone) is ignored. */
  tasks: string[];
};

async function openSession(browser: Browser, role: Role): Promise<Session> {
  refuseUnlessStaging();
  const { email, password } = account(role);
  assertNakulAlias(email);
  const context = await browser.newContext({ baseURL: appBaseURL(), httpCredentials: httpCredentials() });
  const res = await context.request.post("/api/auth/signin", { data: { email, password } });
  if (!res.ok()) {
    await context.close();
    throw new Error(`Sign-in failed (status ${res.status()}). Credentials were not printed.`);
  }
  const body = (await res.json()) as { user?: { id?: string; orgRole?: string; email?: string } };
  const user = body.user;
  const want = role === "ADMIN" ? "SUPER_ADMIN" : "MEMBER";
  if (!user?.id || user.orgRole !== want) {
    await context.request.post("/api/auth/signout").catch(() => {});
    await context.close();
    throw new Error(`The ${role} ZZ-TEST account is ${user?.orgRole ?? "unknown"}, not ${want}. The address was not printed.`);
  }
  assertNakulAlias(String(user.email ?? ""));
  const page = await context.newPage();
  return { page, api: api(context.request), context, user: { id: user.id, orgRole: user.orgRole }, projects: [], tasks: [] };
}

async function closeSession(s: Session) {
  const failed: string[] = [];
  for (const id of s.tasks) {
    try {
      const removed = await s.api.del(`/api/tasks/${id}`);
      if (removed.status !== 204 && removed.status !== 404) failed.push(`task ${removed.status}`);
    } catch {
      failed.push("task error");
    }
  }
  for (const id of s.projects) {
    try {
      const archived = await s.api.post(`/api/projects/${id}/archive`);
      if (archived.status !== 200) failed.push(String(archived.status));
    } catch {
      failed.push("error");
    }
  }
  try {
    await s.context.request.post("/api/auth/signout");
  } catch {
    /* already signed out */
  }
  await s.context.close();
  if (failed.length) throw new Error(`Cleanup failed archiving ${failed.length} ZZ-TEST project(s) (statuses ${failed.join(", ")}).`);
}

/** Fail the test, and do not send the request, when an @readonly test issues anything other than GET. */
export async function installGetOnly(context: BrowserContext): Promise<{ assertClean: () => void }> {
  const bad: string[] = [];
  await context.route("**/*", async (route) => {
    const req = route.request();
    if (req.method() !== "GET") {
      let path = req.url();
      try {
        path = new URL(req.url()).pathname;
      } catch {
        /* keep the raw url; these tests are signed out, so it is not a credential */
      }
      bad.push(`${req.method()} ${path}`);
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  return {
    assertClean() {
      if (bad.length) throw new Error(`@readonly issued a non-GET request: ${bad.join(", ")}`);
    },
  };
}

type Fixtures = {
  /** Signed in as the Super Admin ZZ-TEST account. Staging hosts only. */
  admin: Session;
  /** Signed in as the plain Member ZZ-TEST account. Staging hosts only. */
  member: Session;
};

export const test = base.extend<Fixtures>({
  admin: async ({ browser }, use, info) => {
    if (!info.tags.includes("@write")) throw new Error("The admin fixture is only for @write tests.");
    const s = await openSession(browser, "ADMIN");
    await use(s);
    await closeSession(s);
  },
  member: async ({ browser }, use, info) => {
    if (!info.tags.includes("@write")) throw new Error("The member fixture is only for @write tests.");
    const s = await openSession(browser, "MEMBER");
    await use(s);
    await closeSession(s);
  },
});

test.beforeEach(async ({ context }, info: TestInfo) => {
  if (info.tags.includes("@write")) {
    refuseUnlessStaging();
    return;
  }
  if (!info.tags.includes("@readonly")) throw new Error("Every smoke test must be tagged @readonly or @write.");
  const guard = await installGetOnly(context);
  info.annotations.push({ type: "get-only", description: "non-GET requests are aborted" });
  (info as TestInfo & { __getOnly?: { assertClean: () => void } }).__getOnly = guard;
});

test.afterEach(async ({}, info) => {
  const guard = (info as TestInfo & { __getOnly?: { assertClean: () => void } }).__getOnly;
  guard?.assertClean();
});
