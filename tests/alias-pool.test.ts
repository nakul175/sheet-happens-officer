// APL-2748. The verified alias pool and its provisioning script, without a server: the script's HTTP is a fake
// that behaves like /api/auth and /api/team. Pam left no qa:TC id on the issue; each title says "qa:TC missing".
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PER_SLOT, QA_ADMIN_EMAIL, SLOTS, parseSlots, poolFor, poolPerson, provisionTarget, slotFromEnv } from "./e2e/helpers/alias-pool";
import { provision, report, type Http, type Reply } from "./e2e/tools/provision-aliases";

const PASS = "zz-test-only-not-a-real-password";

type Acct = { id: string; email: string; password: string; verified: boolean; deactivated: boolean; orgRole: string };
type Call = { method: string; path: string; body?: unknown };

function fakeServer(seed: Partial<Acct>[] = []) {
  const accts = new Map<string, Acct>();
  let n = 0;
  const add = (a: Partial<Acct>) => {
    const acct: Acct = { id: `u${++n}`, email: "", password: PASS, verified: true, deactivated: false, orgRole: "MEMBER", ...a };
    accts.set(acct.email, acct);
    return acct;
  };
  seed.forEach(add);
  const calls: Call[] = [];
  const sessions = new Map<string, Acct>();
  const reply = (status: number, json: Record<string, unknown> = {}, cookie: string | null = null): Reply => ({ status, json, cookie });
  const http: Http = async (method, path, body, cookie) => {
    calls.push({ method, path, body });
    const b = (body ?? {}) as Record<string, string>;
    const me = cookie ? sessions.get(cookie) : undefined;
    if (path === "/api/auth/signin") {
      const a = accts.get(b.email);
      // Echo the password back in an error, to prove the script never prints server text that holds it.
      if (!a || a.password !== b.password) return reply(401, { error: `Email or password is incorrect. (${b.password})` });
      if (a.deactivated) return reply(403, { error: "This account is deactivated." });
      if (!a.verified) return reply(403, { error: "Verify your email first." });
      const c = `sho_session=s${calls.length}`;
      sessions.set(c, a);
      return reply(200, { user: { id: a.id, email: a.email, orgRole: a.orgRole } }, c);
    }
    if (path === "/api/auth/signout") { if (cookie) sessions.delete(cookie); return reply(204); }
    if (path === "/api/auth/signup") {
      if (accts.has(b.email)) return reply(409, { error: "An account with this email already exists." });
      add({ email: b.email, password: b.password, verified: false });
      return reply(201, { status: "check_email" });
    }
    if (path === "/api/auth/resend-verification") return reply(200, { status: "ok" });
    if (me?.orgRole !== "SUPER_ADMIN") return reply(403, { error: "Only the Super Admin." });
    if (path === "/api/team" && method === "GET") {
      return reply(200, { people: [...accts.values()].map((a) => ({ id: a.id, email: a.email, orgRole: a.orgRole, status: a.deactivated ? "DEACTIVATED" : a.verified ? "ACTIVE" : "UNVERIFIED" })) });
    }
    const target = [...accts.values()].find((a) => path.startsWith(`/api/team/${a.id}`));
    if (target && path.endsWith("/reactivate")) { target.deactivated = false; return reply(200, { status: "ok" }); }
    if (target && method === "PATCH") { target.orgRole = b.orgRole; return reply(200, { status: "ok" }); }
    return reply(404, { error: "Not found." });
  };
  return { http, calls, accts };
}

const admin = { email: QA_ADMIN_EMAIL, orgRole: "SUPER_ADMIN" };
const readySlot = (slot: string) => poolFor(slot).map((p) => ({ email: p.email }));
const run = (server: ReturnType<typeof fakeServer>, slots: string[], check = false) =>
  provision({ password: PASS, slots, check, http: server.http, secrets: [PASS], pause: 0 });
const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET" && !["/api/auth/signin", "/api/auth/signout"].includes(c.path));

describe("qa:TC missing APL-2748 AC1: a fixed pool of nakul17+ aliases", () => {
  it("qa:TC missing AC1: every slot has the same 3 Member addresses, all nakul17+ on aplyd.com and distinct", () => {
    const all = SLOTS.flatMap(poolFor);
    expect(all).toHaveLength(SLOTS.length * PER_SLOT);
    expect(new Set(all.map((p) => p.email)).size).toBe(all.length);
    for (const p of all) expect(p.email).toMatch(/^nakul17\+zz-qa-(0[1-9]|1\d|20|serial|local)-[1-3]@aplyd\.com$/);
    expect(poolPerson("07", 2)).toEqual({ email: "nakul17+zz-qa-07-2@aplyd.com", name: "ZZ-TEST QA 07-2", slot: "07", index: 2 });
    expect(all.map((p) => p.email)).not.toContain(QA_ADMIN_EMAIL);
  });

  it("qa:TC missing AC1: QA_SLOT picks the slot, defaults to local and refuses an unknown one", () => {
    expect(slotFromEnv({})).toBe("local");
    expect(slotFromEnv({ QA_SLOT: "07" })).toBe("07");
    expect(slotFromEnv({ QA_SLOT: "7" })).toBe("07");
    expect(slotFromEnv({ QA_SLOT: "SERIAL" })).toBe("serial");
    expect(() => slotFromEnv({ QA_SLOT: "21" })).toThrow(/Unknown alias slot/);
    expect(() => poolPerson("01", PER_SLOT + 1)).toThrow(/outside/);
    expect(parseSlots(undefined)).toEqual([...SLOTS]);
    expect(parseSlots("1, 02,serial,02")).toEqual(["01", "02", "serial"]);
    expect(() => parseSlots("01,prod")).toThrow(/Unknown alias slot/);
  });

  it("qa:TC missing AC1: the story helper only signs in; it has no sign-up, verify or outbox step", () => {
    const src = readFileSync("tests/e2e/helpers/qa-alias.ts", "utf8");
    for (const banned of ["/api/auth/signup", "/api/auth/verify", "outbox", "OUTBOX", "readdirSync", "qaEmail"]) expect(src, banned).not.toContain(banned);
    // The pool's own story specs on main; APL-2716 lives on qa/story-e2e only.
    for (const spec of ["APL-2471", "APL-2748"]) {
      const text = readFileSync(`tests/e2e/stories/${spec}.spec.ts`, "utf8");
      expect(text, spec).not.toContain("/api/auth/signup");
      expect(text, spec).not.toContain("qaEmail(");
    }
    // APL-2609 is main's local-sandbox spec (#112): it signs up from the local outbox, so beforeAll fails without one.
    expect(readFileSync("tests/e2e/stories/APL-2609.spec.ts", "utf8")).toContain("expect(existsSync(OUTBOX)");
  });

  it("qa:TC missing AC1: each staging job gets its own slot, so two shards never share a person", () => {
    const wf = readFileSync(".github/workflows/staging-e2e.yml", "utf8");
    expect(wf).toContain("QA_SLOT: ${{ matrix.nn }}");
    expect(wf).toContain("QA_SLOT: serial");
  });
});

describe("qa:TC missing APL-2748 provisioning: sets the pool up once and reports", () => {
  it("qa:TC missing provisioning: a missing alias is signed up with SHO_QA_PASS and waits for its link; no token is read", async () => {
    const s = fakeServer([admin]);
    const r = await run(s, ["01"]);
    expect(r.ready).toBe(false);
    expect(r.rows.map((x) => x.state)).toEqual(["READY", "SIGNED_UP", "SIGNED_UP", "SIGNED_UP"]);
    const ups = s.calls.filter((c) => c.path === "/api/auth/signup");
    expect(ups.map((c) => (c.body as { email: string }).email)).toEqual(poolFor("01").map((p) => p.email));
    for (const c of ups) expect((c.body as { password: string }).password).toBe(PASS);
    expect(s.calls.some((c) => c.path === "/api/auth/verify")).toBe(false);
  });

  it("qa:TC missing provisioning: once every link is followed, a rerun reports all ready and exits clean", async () => {
    const s = fakeServer([admin, ...readySlot("01"), ...readySlot("serial")]);
    const r = await run(s, ["01", "serial"]);
    expect(r.ready).toBe(true);
    expect(r.rows).toHaveLength(1 + 2 * PER_SLOT);
    expect(writes(s.calls)).toEqual([]);
    expect(report(r)).toContain("All 7 aliases are ready.");
  });

  it("qa:TC missing provisioning: unverified gets a new link, deactivated is reactivated, a left-over Admin goes back to Member", async () => {
    const [a, b, c] = poolFor("02");
    const s = fakeServer([admin, { email: a.email, verified: false }, { email: b.email, deactivated: true }, { email: c.email, orgRole: "ADMIN" }]);
    const r = await run(s, ["02"]);
    expect(r.rows.map((x) => x.state)).toEqual(["READY", "VERIFY_SENT", "READY", "READY"]);
    expect(s.accts.get(b.email)!.deactivated).toBe(false);
    expect(s.accts.get(c.email)!.orgRole).toBe("MEMBER");
    expect(s.calls).toContainEqual({ method: "POST", path: "/api/auth/resend-verification", body: { email: a.email } });
  });

  it("qa:TC missing provisioning: --check makes no change at all", async () => {
    const [a, b, c] = poolFor("03");
    const s = fakeServer([admin, { email: a.email, verified: false }, { email: b.email, deactivated: true }, { email: c.email, orgRole: "ADMIN" }]);
    const r = await run(s, ["03", "04"], true);
    expect(writes(s.calls)).toEqual([]);
    expect(r.rows.map((x) => x.state)).toEqual(["READY", "UNVERIFIED", "DEACTIVATED", "WRONG_ROLE", "MISSING", "MISSING", "MISSING"]);
  });

  it("qa:TC missing provisioning: nothing else is touched when the Super Admin alias is not ready", async () => {
    const s = fakeServer([{ email: QA_ADMIN_EMAIL, orgRole: "MEMBER" }]);
    const r = await run(s, ["01"]);
    expect(r.rows).toEqual([{ email: QA_ADMIN_EMAIL, slot: "admin", state: "WRONG_ROLE", note: "add it to SUPER_ADMIN_EMAILS on the staging server" }]);
    expect(s.calls.filter((c) => c.path === "/api/auth/signup")).toEqual([]);
  });

  it("qa:TC missing provisioning: an alias with another password is reported, never reset", async () => {
    const [a] = poolFor("05");
    const s = fakeServer([admin, { email: a.email, password: "someone-else-set-this" }]);
    const r = await run(s, ["05"]);
    expect(r.rows[1]).toMatchObject({ email: a.email, state: "WRONG_PASSWORD" });
    expect(s.calls.some((c) => c.path.includes("resend") || c.method === "PATCH")).toBe(false);
  });
});

describe("qa:TC missing APL-2925 provisioning verifies on the server, so no emailed link is needed", () => {
  // The fake of POST /api/qa/verify-alias: marks the account verified, 404 when there is none.
  const verifier = (server: ReturnType<typeof fakeServer>, status = 200) => {
    const asked: string[] = [];
    const verify = async (email: string): Promise<Reply> => {
      asked.push(email);
      const a = server.accts.get(email);
      if (status !== 200) return { status, json: { error: `Not allowed (${PASS})` }, cookie: null };
      if (!a) return { status: 404, json: { error: "No account for this alias. Sign it up first." }, cookie: null };
      a.verified = true;
      return { status: 200, json: { status: "verified" }, cookie: null };
    };
    return { verify, asked };
  };
  const runV = (server: ReturnType<typeof fakeServer>, slots: string[], verify: (email: string) => Promise<Reply>, check = false) =>
    provision({ password: PASS, slots, check, http: server.http, secrets: [PASS], pause: 0, verify });

  it("qa:TC missing APL-2925: a fresh pool (no Super Admin, no Members) ends all ready in one run", async () => {
    const s = fakeServer();
    const v = verifier(s);
    // The fake makes the first account a Member; the server would make nakul17+zz-sa a Super Admin from SUPER_ADMIN_EMAILS.
    const signup = s.http;
    const http: Http = async (method, path, body, cookie) => {
      const r = await signup(method, path, body, cookie);
      if (path === "/api/auth/signup" && (body as { email: string }).email === QA_ADMIN_EMAIL) s.accts.get(QA_ADMIN_EMAIL)!.orgRole = "SUPER_ADMIN";
      return r;
    };
    const r = await provision({ password: PASS, slots: ["01"], check: false, http, secrets: [PASS], pause: 0, verify: v.verify });
    expect(r.rows.map((x) => x.state)).toEqual(["READY", "READY", "READY", "READY"]);
    expect(r.ready).toBe(true);
    expect(v.asked).toEqual([QA_ADMIN_EMAIL, ...poolFor("01").map((p) => p.email)]);
    expect(s.calls.some((c) => c.path === "/api/auth/verify" || c.path.includes("resend"))).toBe(false);
  });

  it("qa:TC missing APL-2925: an unverified Member is verified instead of being sent a new link", async () => {
    const [a] = poolFor("02");
    const s = fakeServer([admin, { email: a.email, verified: false }, ...readySlot("02").slice(1)]);
    const v = verifier(s);
    const r = await runV(s, ["02"], v.verify);
    expect(r.rows.map((x) => x.state)).toEqual(["READY", "READY", "READY", "READY"]);
    expect(v.asked).toEqual([a.email]);
    expect(s.calls.some((c) => c.path.includes("resend"))).toBe(false);
  });

  it("qa:TC missing APL-2925: a refused verify step is an ERROR row and never prints the server's text when it holds the password", async () => {
    const [a] = poolFor("03");
    const s = fakeServer([admin, { email: a.email, verified: false }, ...readySlot("03").slice(1)]);
    const r = await runV(s, ["03"], verifier(s, 401).verify);
    expect(r.ready).toBe(false);
    expect(r.rows[1]).toEqual({ email: a.email, slot: "03", state: "ERROR", note: "verify step: status 401" });
    expect(report(r)).not.toContain(PASS);
  });

  it("qa:TC missing APL-2925: --check never calls the verify step", async () => {
    const [a] = poolFor("04");
    const s = fakeServer([admin, { email: a.email, verified: false }]);
    const v = verifier(s);
    await runV(s, ["04"], v.verify, true);
    expect(v.asked).toEqual([]);
    expect(writes(s.calls)).toEqual([]);
  });

  it("qa:TC missing APL-2925: the staging workflow passes the job secret only to provisioning, through env", () => {
    const wf = readFileSync(".github/workflows/staging-regression.yml", "utf8");
    expect(wf).toContain("QA_JOB_SECRET: ${{ secrets.STAGING_JOB_SECRET }}");
    expect(wf.match(/QA_JOB_SECRET:/g)).toHaveLength(2); // the names-only check and the provisioning step
    expect(wf).not.toMatch(/set -x|echo "\$\{?(QA_JOB_SECRET|STAGING_PASS|SHO_QA_PASS)/);
  });
});

describe("qa:TC missing APL-2748 provisioning report: says the right next step", () => {
  it("qa:TC missing provisioning: only aliases waiting on a link are told to follow one", async () => {
    const [a, b] = poolFor("07");
    const s = fakeServer([admin, { email: a.email, verified: false }, { email: b.email, password: "someone-else-set-this" }]);
    const out = report(await run(s, ["07"]));
    const line = (email: string) => out.split("\n").find((l) => l.includes(email))!;
    expect(line(a.email)).toContain("VERIFY_SENT");
    expect(line(a.email)).toContain("follow its Verify link");
    expect(line(b.email)).toContain("WRONG_PASSWORD");
    expect(line(b.email)).not.toContain("Verify link");
    expect(line(b.email)).toContain("Forgot password");
    expect(out).toContain("3 of 4 need action: 2 waiting on a Verify link in nakul17@aplyd.com, 1 needing the step shown on its line.");
  });

  it("qa:TC missing provisioning: a run with no link outstanding never mentions Verify links", async () => {
    const [a] = poolFor("08");
    const s = fakeServer([admin, { email: a.email, password: "someone-else-set-this" }, ...readySlot("08").slice(1)]);
    const out = report(await run(s, ["08"]));
    expect(out).not.toContain("Verify link");
    expect(out).toContain("1 of 4 need action: 1 needing the step shown on its line.");
  });
});

describe("qa:TC missing APL-2748 AC1: pool Members are handed back active", () => {
  it("qa:TC missing AC1: cast reactivates a deactivated pool Member and restores it after the test", () => {
    const src = readFileSync("tests/e2e/helpers/qa-alias.ts", "utf8");
    expect(src).toContain("/reactivate");
    expect(src).toMatch(/later\(\(\) => restore\(/);
    expect(src).not.toContain("/deactivate");
  });
});

describe("qa:TC missing APL-2748 AC2/AC3: no secret printed, never production", () => {
  it("qa:TC missing AC2: the report never carries SHO_QA_PASS, even when the server echoes it", async () => {
    const [a] = poolFor("06");
    const s = fakeServer([admin, { email: a.email, password: "other-password-1" }]);
    const r = await run(s, ["06"]);
    const out = report(r);
    expect(out).not.toContain(PASS);
    expect(JSON.stringify(r)).not.toContain(PASS);
  });

  it("qa:TC missing AC3: production and unknown hosts are refused; staging, pr1-pr4 and localhost are allowed", () => {
    for (const bad of [undefined, "", "not a url", "https://sheethappensofficer.com", "https://www.sheethappensofficer.com.", "https://app.sheethappensofficer.com",
      "http://168.144.144.69", "https://pr5.staging.sheethappensofficer.com", "https://staging.sheethappensofficer.com.evil.example", "http://staging.sheethappensofficer.com"]) {
      expect(() => provisionTarget(bad), String(bad)).toThrow();
    }
    expect(provisionTarget("https://staging.sheethappensofficer.com/x").href).toBe("https://staging.sheethappensofficer.com/");
    expect(provisionTarget("https://pr4.staging.sheethappensofficer.com").host).toBe("pr4.staging.sheethappensofficer.com");
    expect(provisionTarget("http://localhost:3100").host).toBe("localhost:3100");
  });
});
