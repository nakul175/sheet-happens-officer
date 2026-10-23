// SHO-2920..2923. The missing ingredient: the story specs need a Super Admin and a Member, and a run that has neither
// proves nothing. These cases hold the tool to that: it reports READY only when /api/auth/me carries the role the
// fixture asserts, and it says which address to fix (SUPER_ADMIN_EMAILS) when it does not.
import { describe, expect, it } from "vitest";
import { PEOPLE, provision, report, roleProblem, tokenFrom, type Mail, type Reply } from "./e2e/tools/provision-local-admin";

const mail = (to: string, subject: string, text: string): Mail => ({ to, subject, text });

describe("tokenFrom", () => {
  it("takes the newest Verify token for that address and no other mail", () => {
    const mails = [
      mail("root.test@aplyd.com", "Verify your email", "http://x/api/auth/verify?token=old-token"),
      mail("root.test@aplyd.com", "Verify your email", "http://x/api/auth/verify?token=new-token"),
      mail("someone@aplyd.com", "Verify your email", "http://x/api/auth/verify?token=theirs"),
      mail("root.test@aplyd.com", "Reset your password", "http://x/api/auth/reset-password?token=reset"),
    ];
    expect(tokenFrom(mails, "root.test@aplyd.com")).toBe("new-token");
  });

  it("is null when nothing was mailed, so the tool waits instead of verifying a null token", () => {
    expect(tokenFrom([], "root.test@aplyd.com")).toBeNull();
  });
});

describe("roleProblem", () => {
  it("accepts the role each fixture asserts and nothing else", () => {
    expect(roleProblem("admin", { orgRole: "SUPER_ADMIN" })).toBeNull();
    expect(roleProblem("member", { orgRole: "MEMBER" })).toBeNull();
    expect(roleProblem("admin", { orgRole: "MEMBER" })).toContain("SUPER_ADMIN_EMAILS");
    expect(roleProblem("member", { orgRole: "SUPER_ADMIN" })).toContain("not MEMBER");
    expect(roleProblem("admin", null)).toContain("unknown");
  });
});

/** A server that answers like the real one, with the roles it would put on /api/auth/me. */
function fake(me: Record<string, string>, opts: { signup?: number; signin?: number } = {}) {
  let session = "";
  return async (method: string, path: string, body?: unknown): Promise<Reply> => {
    const email = (body as { email?: string } | undefined)?.email ?? "";
    if (method === "POST" && path === "/api/auth/signup") return { status: opts.signup ?? 201, json: {}, cookie: null };
    if (method === "POST" && path === "/api/auth/verify") return { status: 200, json: {}, cookie: null };
    if (method === "POST" && path === "/api/auth/signin") { session = email; return { status: opts.signin ?? 200, json: {}, cookie: "sid=1" }; }
    if (method === "GET" && path === "/api/auth/me") return { status: 200, json: { user: { email: session, orgRole: me[session] } }, cookie: null };
    return { status: 404, json: {}, cookie: null };
  };
}

const mails = PEOPLE.map((p) => mail(p.email, "Verify your email", "http://x/api/auth/verify?token=t"));

describe("provision", () => {
  it("is READY when both accounts sign in with the roles the fixtures assert", async () => {
    const result = await provision({ people: PEOPLE, password: "test-only-pass", http: fake({ "root.test@aplyd.com": "SUPER_ADMIN", "member.test@aplyd.com": "MEMBER" }), readMails: () => mails, waitMs: 0 });
    expect(result.rows.map((r) => r.state)).toEqual(["READY", "READY"]);
    expect(result.ready).toBe(true);
    expect(report(result)).toContain("READY: the story fixtures can sign in.");
  });

  it("is NOT READY and names SUPER_ADMIN_EMAILS when the server signs the admin in as a plain Member", async () => {
    const result = await provision({ people: PEOPLE, password: "test-only-pass", http: fake({ "root.test@aplyd.com": "MEMBER", "member.test@aplyd.com": "MEMBER" }), readMails: () => mails, waitMs: 0 });
    expect(result.ready).toBe(false);
    expect(result.rows[0]).toMatchObject({ slot: "admin", state: "WRONG_ROLE" });
    expect(result.rows[0].note).toContain("SUPER_ADMIN_EMAILS");
  });

  it("is NOT READY when the account exists with another password, instead of reporting the 409 as success", async () => {
    const result = await provision({ people: PEOPLE.slice(0, 1), password: "test-only-pass", http: fake({}, { signup: 409, signin: 401 }), readMails: () => [], waitMs: 0 });
    expect(result.rows[0]).toMatchObject({ state: "WRONG_PASSWORD" });
    expect(result.ready).toBe(false);
  });

  it("is NOT READY when the Verify mail never lands, so a missing outbox cannot pass as a provisioned admin", async () => {
    const result = await provision({ people: PEOPLE.slice(0, 1), password: "test-only-pass", http: fake({}), readMails: () => [], waitMs: 0 });
    expect(result.rows[0].state).toBe("NOT_VERIFIED");
    expect(result.ready).toBe(false);
  });
});
