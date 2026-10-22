// The probe's own contract, against a fake server: no network, no staging, no secret. It checks the
// decision logic the workflow relies on, so a broken probe cannot burn the one approved staging call.
import { describe, expect, it } from "vitest";
import { main, runProbe, type Http, type Reply } from "../e2e/tools/staging-identity-probe";

/** A server that refuses everything the way the product does, with a limiter and a lockout counter. */
function fakeProduct(opts: { lockout?: boolean; gate?: boolean; plans?: boolean } = {}): { http: Http; seen: string[] } {
  const seen: string[] = [];
  let resets = 0;
  let fails = 0;
  const http: Http = async (method, path, body) => {
    seen.push(`${method} ${path}`);
    if (opts.gate) return { status: 401, json: {} } as Reply;
    if (method === "GET" && path === "/api/health") return { status: 200, json: { ok: true } };
    if (method === "POST" && path === "/api/health") return { status: 405, json: {} };
    if (method === "POST" && path !== "/api/auth/signin" && path !== "/api/auth/forgot-password") return { status: 401, json: { error: "Sign in to continue." } };
    if (path === "/api/auth/forgot-password") {
      resets++;
      return resets <= 3 ? { status: 200, json: { ok: true } } : { status: 429, json: { error: "Too many" } };
    }
    const password = (body as { password: string }).password;
    if (password === "") return { status: 401, json: { error: "Email or password is incorrect.", ...(opts.plans === false ? {} : { plans: { User: 3, Project: 4 } }) } };
    fails++;
    return fails >= 5 && opts.lockout !== false
      ? { status: 429, json: { error: "Too many attempts. Try again in 15 minutes." } }
      : { status: 401, json: { error: "Email or password is incorrect." } };
  };
  return { http, seen };
}

const acct = "probe-test@aplyd.com";
const base = { base: "https://staging.sheethappensofficer.com", account: acct, password: "s3cret-not-real" };

describe("qa:TC missing staging identity probe is read-only and reports redacted metadata", () => {
  it("qa:TC missing AC1: a refusing product passes every stage and never prints the password", async () => {
    const { http } = fakeProduct();
    const stages = await runProbe({ http, ...base });
    expect(stages.filter((s) => !s.ok)).toEqual([]);
    const text = stages.map((s) => s.detail).join("\n");
    expect(text).not.toContain(base.password);
    expect(text).not.toContain(acct);
    // The table list is the identity evidence: printed as keys when the product answers with one.
    expect(stages.find((s) => s.name === "identity-models")!.detail).toMatch(/^plans keys: /);
  });

  it("qa:TC missing AC1: every write it sends is one the product must refuse", async () => {
    const { http, seen } = fakeProduct();
    await runProbe({ http, ...base });
    // Only the two auth endpoints carry a body, and both are refusal paths (wrong passwords and a cold
    // reset address that owns no account). Everything else with a body is a POST answered 401/405.
    const writes = seen.filter((s) => s.startsWith("POST") && s !== "POST /api/health");
    expect(writes.filter((w) => w === "POST /api/deals")).toHaveLength(1);
    expect(writes.filter((w) => w === "POST /api/auth/signin")).toHaveLength(7);
    expect(writes.filter((w) => w === "POST /api/auth/forgot-password")).toHaveLength(4);
  });

  it("qa:TC missing AC1: a basic-auth gate is the one non-product answer, and it stops the run", async () => {
    const { http } = fakeProduct({ gate: true });
    const stages = await runProbe({ http, ...base });
    expect(stages).toHaveLength(1);
    expect(stages[0]).toMatchObject({ name: "reachable", ok: false });
    expect(stages[0].detail).toContain("basic-auth gate");
  });

  it("qa:TC missing AC1: a product that never locks out fails the write-grant stage", async () => {
    const { http } = fakeProduct({ lockout: false });
    const stages = await runProbe({ http, ...base });
    expect(stages.filter((s) => !s.ok).map((s) => s.name)).toEqual(["grant-loginattempt-insert", "grant-lockout-events"]);
  });

  it("qa:TC missing AC1: main refuses a production or non-https base without making a request", async () => {
    for (const bad of ["https://sheethappensofficer.com", "https://www.sheethappensofficer.com", "http://staging.sheethappensofficer.com", "https://example.com", ""]) {
      const { http, seen } = fakeProduct();
      const ok = await main({ PROBE_BASE_URL: bad, STAGING_USER: "u", STAGING_PASS: "p" });
      expect(ok, bad).toBe(false);
      expect(seen, bad).toEqual([]);
      void http;
    }
  });
});
