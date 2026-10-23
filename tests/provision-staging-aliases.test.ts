// APL-2748. provision-aliases.ts --create and .github/workflows/provision-staging-aliases.yml, without a server: the
// script's HTTP is a fake /api/auth/signup, and the workflow's guard step is run with bash. Nothing here reaches staging.
// No qa:TC id was left for this ops workflow; each title says "qa:TC missing".
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { POOL_SIZE, SLOTS, poolFor, provisionTarget, stagingOnlyTarget } from "./e2e/helpers/alias-pool";
import { createMissing, createPassed, createSummary, createVerdict, type Http } from "./e2e/tools/provision-aliases";

const PASS = "zz-test-only-not-a-real-password";
const WORKFLOW = ".github/workflows/provision-staging-aliases.yml";

/** /api/auth/signin and /api/auth/signup: the same answers as the app. `fail` addresses get a 500 on sign-up, `drop` ones throw. */
function signupServer(existing: string[] = [], fail: string[] = [], drop: string[] = []) {
  // An address that exists is a working alias (verified, on PASS) until `verifyLink()` or a test says otherwise.
  const accts = new Map(existing.map((email) => [email, { verified: true, deactivated: false, password: PASS }]));
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const http: Http = async (method, path, body) => {
    calls.push({ method, path, body });
    const { email, password } = (body ?? {}) as { email: string; password: string };
    if (drop.includes(email)) throw new Error("socket hang up");
    if (path === "/api/auth/signin") {
      const a = accts.get(email);
      if (!a || a.password !== password) return { status: 401, json: { error: "Email or password is incorrect." }, cookie: null };
      if (a.deactivated) return { status: 403, json: { error: "This account is deactivated." }, cookie: null };
      if (!a.verified) return { status: 403, json: { error: "Verify your email first." }, cookie: null };
      return { status: 200, json: { user: { email } }, cookie: "sho_session=x" };
    }
    if (path !== "/api/auth/signup") return { status: 404, json: {}, cookie: null };
    if (fail.includes(email)) return { status: 500, json: { error: "Something went wrong." }, cookie: null };
    if (accts.has(email)) return { status: 409, json: { error: "An account with this email already exists." }, cookie: null };
    accts.set(email, { verified: false, deactivated: false, password });
    return { status: 201, json: { status: "check_email" }, cookie: null };
  };
  return {
    http,
    calls,
    accts,
    /** The operator following the Verify link(s) in the inbox. */
    verifyLink: () => { for (const a of accts.values()) a.verified = true; },
    signups: () => calls.filter((c) => c.path === "/api/auth/signup"),
    signIns: () => calls.filter((c) => c.path === "/api/auth/signin"),
  };
}

const ALL = SLOTS.flatMap(poolFor).map((p) => p.email);
const create = (s: ReturnType<typeof signupServer>) => createMissing({ password: PASS, http: s.http, pause: 0 });
const createdEmails = (s: ReturnType<typeof signupServer>) => s.signups().map((c) => (c.body as { email: string }).email);
const calledEmails = (calls: { body?: unknown }[]) => calls.map((c) => (c.body as { email: string }).email);

describe("qa:TC missing APL-2748 create mode: idempotent, counts only", () => {
  it("qa:TC missing create: the pool is 66 nakul17+zz-qa- addresses", () => {
    expect(POOL_SIZE).toBe(66);
    expect(ALL).toHaveLength(66);
    for (const e of ALL) expect(e).toMatch(/^nakul17\+zz-qa-/);
  });

  it("qa:TC missing create: on an empty staging it creates all 66 with SHO_QA_PASS, and none of them is ready", async () => {
    const s = signupServer();
    const c = await create(s);
    expect(c).toEqual({ created: 66, skipped: 0, failed: 0, ready: 0 });
    // APL-3017: a new account is unverified, so the run that made it is not a pass and says so.
    expect(createPassed(c)).toBe(false);
    expect(createVerdict(c)).toContain("66 of 66 not ready");
    expect(calledEmails(s.signIns())).toEqual(ALL);
    expect(createdEmails(s)).toEqual(ALL);
    for (const x of s.signups()) expect((x.body as { password: string }).password).toBe(PASS);
    for (const e of ALL) expect(s.accts.get(e)!.verified, e).toBe(false);
  });

  it("qa:TC missing create: a second run creates nothing, never signs an existing alias up, and passes once every link is followed", async () => {
    const s = signupServer();
    await create(s);
    s.calls.length = 0;
    const again = await create(s);
    expect(again).toEqual({ created: 0, skipped: 66, failed: 0, ready: 0 });
    expect(createPassed(again)).toBe(false);
    // The 66 exist (unverified): a sign-up could only answer 409, and a sign-up is the request that makes an unverified row.
    expect(s.signups()).toEqual([]);
    expect(s.accts.size).toBe(66);
    s.verifyLink(); // the operator follows the 66 Verify links in the inbox
    s.calls.length = 0;
    const ready = await create(s);
    expect(ready).toEqual({ created: 0, skipped: 66, failed: 0, ready: 66 });
    expect(createPassed(ready)).toBe(true);
    expect(createVerdict(ready)).toContain("All 66 aliases are ready");
    expect(s.signups()).toEqual([]); // read with a sign-in only
    for (const e of ALL) expect(s.accts.get(e)!.verified, e).toBe(true);
  });

  it("qa:TC missing create: existing aliases are read, never signed up, and only the missing ones are created", async () => {
    const s = signupServer(ALL.slice(0, 10));
    const c = await create(s);
    expect(c).toEqual({ created: 56, skipped: 10, failed: 0, ready: 10 });
    expect(createdEmails(s)).toEqual(ALL.slice(10));
  });

  it("qa:TC missing create: a server error or a dropped request is failed, and the run does not pass", async () => {
    const s = signupServer([ALL[0]], [ALL[1]], [ALL[2]]);
    const c = await create(s);
    expect(c).toEqual({ created: 63, skipped: 1, failed: 2, ready: 1 });
    expect(createPassed(c)).toBe(false);
  });

  it("qa:TC missing create: the run does not pass unless all 66 are accounted for AND sign in", () => {
    expect(createPassed({ created: 65, skipped: 0, failed: 0, ready: 65 })).toBe(false);
    expect(createPassed({ created: 0, skipped: 66, failed: 0, ready: 66 })).toBe(true);
    expect(createPassed({ created: 0, skipped: 66, failed: 0, ready: 65 })).toBe(false);
    expect(createPassed({ created: 0, skipped: 66, failed: 1, ready: 66 })).toBe(false);
    // APL-3017, the 20 Oct state: all 66 exist, all unverified, nothing failed. Existing is not ready.
    expect(createPassed({ created: 0, skipped: 66, failed: 0, ready: 0 })).toBe(false);
    // The run that created them, and any run that had to create one: creating is not provisioning.
    expect(createPassed({ created: 66, skipped: 0, failed: 0, ready: 0 })).toBe(false);
    expect(createPassed({ created: 30, skipped: 36, failed: 0, ready: 66 })).toBe(false);
  });

  it("qa:TC missing create: the summary is counts only, with no address and no password", async () => {
    const out = createSummary(await create(signupServer(ALL.slice(0, 4), [ALL[5]])));
    expect(out).toBe("created 61, skipped 4, failed 1, ready 4, total 66 of 66");
    expect(out).not.toContain("@");
    expect(out).not.toContain(PASS);
  });
});

describe("qa:TC missing APL-2748 create mode guard: staging only, never production", () => {
  it("qa:TC missing guard: only https://staging.sheethappensofficer.com is accepted", () => {
    expect(stagingOnlyTarget("https://staging.sheethappensofficer.com").href).toBe("https://staging.sheethappensofficer.com/");
    expect(stagingOnlyTarget("https://STAGING.sheethappensofficer.com/x").href).toBe("https://staging.sheethappensofficer.com/");
    for (const bad of [undefined, "", "not a url", "https://sheethappensofficer.com", "https://www.sheethappensofficer.com",
      "https://app.sheethappensofficer.com", "https://sheethappensofficer.aplyd.org", "https://168.144.144.69", "http://staging.sheethappensofficer.com",
      "https://pr1.staging.sheethappensofficer.com", "http://localhost:3100", "https://staging.sheethappensofficer.com.evil.example"]) {
      expect(() => stagingOnlyTarget(bad), String(bad)).toThrow();
    }
  });

  it("qa:TC missing guard: the new production host is refused as production", () => {
    expect(() => provisionTarget("https://sheethappensofficer.aplyd.org")).toThrow("Refusing to provision aliases on production (sheethappensofficer.aplyd.org).");
  });

  it("qa:TC missing guard: the script's --create refuses a non-staging BASE_URL before it reads a password or sends anything", () => {
    const cases: [string, string[], RegExp][] = [
      ["https://sheethappensofficer.aplyd.org", [], /production/],
      ["https://pr2.staging.sheethappensofficer.com", [], /create mode runs against staging\.sheethappensofficer\.com only/],
      ["https://staging.sheethappensofficer.com", ["--check"], /cannot be combined/],
    ];
    for (const [base, extra, msg] of cases) {
      const r = spawnSync("npx", ["tsx", "tests/e2e/tools/provision-aliases.ts", "--create", ...extra], {
        encoding: "utf8",
        env: { NODE_ENV: "test", PATH: process.env.PATH, HOME: process.env.HOME, BASE_URL: base },
      });
      expect(r.status, base).toBe(1);
      expect(r.stderr, base).toMatch(msg);
    }
  }, 60_000);
});

describe("qa:TC missing APL-2748 workflow: dispatch only, pinned to staging, secret through env", () => {
  const wf = readFileSync(WORKFLOW, "utf8");

  /** The "Check the target is staging" step's script, run with bash. */
  function guard(env: Record<string, string>) {
    const lines = wf.split("\n");
    const start = lines.findIndex((l) => l.includes("- name: Check the target is staging"));
    const run = lines.findIndex((l, i) => i > start && l.trim() === "run: |");
    const body: string[] = [];
    for (const l of lines.slice(run + 1)) {
      if (l.trim() && !l.startsWith("          ")) break;
      body.push(l.slice(10));
    }
    return spawnSync("bash", ["-e", "-c", body.join("\n")], { encoding: "utf8", env: { NODE_ENV: "test", PATH: process.env.PATH, ...env } });
  }

  it("qa:TC missing workflow: started by hand only, with an environment input whose one choice is staging", () => {
    const on = wf.slice(wf.indexOf("\non:\n"), wf.indexOf("\npermissions:"));
    expect(on).toMatch(/^\non:\n  workflow_dispatch:\n/);
    expect(on.match(/^ {2}\S/gm)).toHaveLength(1);
    expect(wf).toContain("      environment:\n");
    expect(wf).toContain("        options: [\"staging\"]\n");
    expect(wf.match(/options:/g)).toHaveLength(1);
  });

  it("qa:TC missing workflow: the target is the fixed staging URL, not a variable", () => {
    expect(wf).toContain("  BASE_URL: https://staging.sheethappensofficer.com\n");
    expect(wf).not.toContain("vars.");
  });

  it("qa:TC missing workflow: the guard passes staging and refuses production, previews and a wrong environment", () => {
    const ok = guard({ TARGET_ENV: "staging", BASE_URL: "https://staging.sheethappensofficer.com" });
    expect(ok.status, ok.stdout + ok.stderr).toBe(0);
    for (const prod of ["https://sheethappensofficer.com", "https://app.sheethappensofficer.com", "https://sheethappensofficer.aplyd.org", "https://168.144.144.69"]) {
      const r = guard({ TARGET_ENV: "staging", BASE_URL: prod });
      expect(r.status, prod).toBe(1);
      expect(r.stdout, prod).toContain("Refusing to run against production");
    }
    for (const other of ["https://pr1.staging.sheethappensofficer.com", "http://staging.sheethappensofficer.com", "https://staging.sheethappensofficer.com/x"]) {
      expect(guard({ TARGET_ENV: "staging", BASE_URL: other }).status, other).toBe(1);
    }
    const env = guard({ TARGET_ENV: "production", BASE_URL: "https://staging.sheethappensofficer.com" });
    expect(env.status).toBe(1);
    expect(env.stdout).toContain("Refusing environment 'production'");
  });

  it("qa:TC missing workflow: SHO_QA_PASS reaches steps through env only and is never echoed or written to a file", () => {
    const uses = wf.split("\n").filter((l) => l.includes("secrets.SHO_QA_PASS"));
    expect(uses.length).toBeGreaterThan(0);
    for (const l of uses) expect(l.trim()).toBe("SHO_QA_PASS: ${{ secrets.SHO_QA_PASS }}");
    expect(wf).not.toMatch(/\$\{?SHO_QA_PASS/);
    expect(wf).not.toMatch(/\$\{?STAGING_PASS/);
    expect(wf).toContain("npx tsx tests/e2e/tools/provision-aliases.ts --create");
    expect(wf).toContain("permissions:\n  contents: read\n");
  });
});
