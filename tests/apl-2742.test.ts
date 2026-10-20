// APL-2742 (prod hotfix). Two parts:
// 1. Sign-in refuses an unverified account and says how to get a new link (live server, like auth.test.ts).
// 2. When Resend rejects or cannot be reached, the failure is logged with the status and Resend's error name and
//    message only (no key, no body, no link), and sign-up / resend tell the person instead of failing with a 500.
//    The provider is faked here: sendMail is called in this process, and the routes are called through their own
//    POST handlers with sendMail made to fail.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BASE, Client, OUTBOX, PW } from "./helpers";
import { db } from "../src/lib/db";

vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), connection: async () => {} }));
const failSend = vi.hoisted(() => ({ on: false }));
vi.mock("@/lib/email", async (orig) => {
  const real = await orig<typeof import("../src/lib/email")>();
  return {
    ...real,
    sendMail: async (mail: Parameters<typeof real.sendMail>[0]) => {
      if (failSend.on) throw new real.MailError("Resend rejected the email (HTTP 403)", 403, "validation_error");
      return real.sendMail(mail);
    },
  };
});

const { sendMail, MailError } = await import("../src/lib/email");
const { POST: signUp } = await import("../src/app/api/auth/signup/route");
const { POST: resendVerification } = await import("../src/app/api/auth/resend-verification/route");
const { POST: verifyEmail } = await import("../src/app/api/auth/verify/route");

// APL-2742 D1 (QA): the exact texts on the failure paths. Literal on purpose: a wording change must change this test.
const UNVERIFIED_TEXT = "Verify your email before you sign in. No working verification link? Use Resend link.";
const RESEND_TEXT = "Request received. If this address has an account waiting for verification, and it has not reached the limit of 3 requests an hour, we will try to email it a new link. If nothing arrives within a few minutes, check spam, then try again later.";
const UNUSABLE_TEXT = "This link is invalid, has expired, was already used or was replaced by a newer one.";

const run = Date.now();
let n = 0;
const fresh = () => `nakul17+zztest-apl2742-${run}-${n++}@aplyd.com`;
const FAKE_KEY = "re_test_not_a_real_key_0000";
const MAIL = { to: "nakul17+zztest-apl2742@aplyd.com", subject: "Verify your email for Sheet Happens Officer", text: "Open https://app.example/verify?token=SECRET-TOKEN-123" };

const post = (route: (req: Request) => Promise<Response>, path: string, body: unknown) =>
  route(new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

/** The newest verification token mailed to this address (outbox), or null. */
function lastVerifyToken(email: string): string | null {
  let files: string[] = [];
  try { files = readdirSync(OUTBOX).sort(); } catch { return null; }
  const mails = files.map((f) => JSON.parse(readFileSync(path.join(OUTBOX, f), "utf8"))).filter((m) => m.to === email && /Verify/.test(m.subject));
  return mails.at(-1)?.text.match(/token=([\w-]+)/)?.[1] ?? null;
}

/** A request as it reaches the app behind Caddy: X-Forwarded-For names the client, plus a browser user agent. */
const viaProxy = (method: string, p: string, ip: string, ua: string, body?: unknown) =>
  fetch(BASE + p, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": `${ip}, 10.0.0.1`, "user-agent": ua },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

afterEach(() => {
  failSend.on = false;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("qa:TC missing AC1: unverified accounts cannot sign in", () => {
  it("qa:TC missing AC1: unverified user cannot sign in after sign-up, sign-out and sign-in", async () => {
    const email = fresh();
    const c = new Client();
    const up = await c.post("/api/auth/signup", { name: "ZZ-TEST Unverified", email, password: PW });
    expect(up.status).toBe(201);
    expect(up.setCookie, "sign-up never sets a session cookie").toBeNull();
    expect((await c.get("/api/auth/me")).status).toBe(401);
    expect((await c.post("/api/auth/signout")).status).toBe(204);
    const r = await c.post("/api/auth/signin", { email, password: PW });
    expect(r.status).toBe(403);
    expect(r.setCookie, "a refused sign-in sets no session cookie").toBeNull();
    expect(r.json.code).toBe("EMAIL_NOT_VERIFIED");
    expect(r.json.error).toBe(UNVERIFIED_TEXT);
    expect((await c.get("/api/auth/me")).status).toBe(401);
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    expect(await db.session.count({ where: { userId: user.id } })).toBe(0);
  });

  it("qa:TC missing AC1: a wrong password still gets the generic answer, not the verify prompt", async () => {
    const email = fresh();
    const c = new Client();
    await c.post("/api/auth/signup", { name: "ZZ-TEST Unverified", email, password: PW });
    const r = await c.post("/api/auth/signin", { email, password: "wrong-pass-1" });
    expect(r.status).toBe(401);
    expect(r.json.code).toBeUndefined();
  });
});

describe("qa:TC missing AC2: sendMail logs a Resend rejection without secrets", () => {
  it("qa:TC missing AC2: a 403 from Resend throws MailError and logs status, error name and message only", async () => {
    vi.stubEnv("RESEND_API_KEY", FAKE_KEY);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(
      { statusCode: 403, name: "validation_error", message: "The sheethappensofficer.aplyd.org domain is not verified." },
      { status: 403 },
    )));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = await sendMail(MAIL).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailError);
    expect((err as InstanceType<typeof MailError>).status).toBe(403);
    expect((err as InstanceType<typeof MailError>).providerName).toBe("validation_error");
    expect(log).toHaveBeenCalledTimes(1);
    const line = log.mock.calls[0].join(" ");
    expect(line).toContain("HTTP 403");
    expect(line).toContain("validation_error");
    expect(line).toContain("The sheethappensofficer.aplyd.org domain is not verified.");
    expect(line).not.toContain(FAKE_KEY);
    expect(line).not.toContain("SECRET-TOKEN-123");
    expect(line).not.toContain(MAIL.to);
  });

  it("qa:TC missing AC2: a Resend error body that is not JSON still logs the status", async () => {
    vi.stubEnv("RESEND_API_KEY", FAKE_KEY);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>bad gateway</html>", { status: 502 })));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(sendMail(MAIL)).rejects.toBeInstanceOf(MailError);
    const line = log.mock.calls[0].join(" ");
    expect(line).toContain("HTTP 502");
    expect(line).not.toContain("<html>");
  });

  it("qa:TC missing AC2: a network failure reaching Resend throws MailError and is logged", async () => {
    vi.stubEnv("RESEND_API_KEY", FAKE_KEY);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(sendMail(MAIL)).rejects.toBeInstanceOf(MailError);
    const line = log.mock.calls[0].join(" ");
    expect(line).toContain("fetch failed");
    expect(line).not.toContain(FAKE_KEY);
  });

  it("qa:TC missing AC2: production without a key throws MailError and is logged", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("EMAIL_OUTBOX_DIR", "");
    vi.stubEnv("NODE_ENV", "production");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(sendMail(MAIL)).rejects.toBeInstanceOf(MailError);
    expect(log.mock.calls[0].join(" ")).toContain("RESEND_API_KEY is not set");
  });
});

describe("qa:TC missing AC3: a failed verification send is reported to the person", () => {
  it("qa:TC missing AC3: sign-up still creates the unverified account and answers 201 with emailSent false and a message", async () => {
    failSend.on = true;
    const email = fresh();
    const res = await post(signUp, "/api/auth/signup", { name: "ZZ-TEST Mailfail", email, password: PW });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.status).toBe("check_email");
    expect(json.emailSent).toBe(false);
    expect(json.message).toMatch(/could not send/i);
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    expect(user.emailVerifiedAt).toBeNull();
    expect(await db.session.count({ where: { userId: user.id } })).toBe(0);
    expect(await db.authToken.count({ where: { userId: user.id } }), "the unsent token is gone, so it does not count toward the limit").toBe(0);
  });

  it("qa:TC missing AC3: sign-up answers emailSent true when the send works", async () => {
    const res = await post(signUp, "/api/auth/signup", { name: "ZZ-TEST Mailok", email: fresh(), password: PW });
    expect(res.status).toBe(201);
    expect((await res.json()).emailSent).toBe(true);
  });

  it("qa:TC missing AC3: a failed resend keeps the delivered link working, does not use up the limit and is audited FAILED", async () => {
    const email = fresh();
    expect((await post(signUp, "/api/auth/signup", { name: "ZZ-TEST Mailfail", email, password: PW })).status).toBe(201);
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    const delivered = await db.authToken.findFirstOrThrow({ where: { userId: user.id, type: "VERIFY" } });
    failSend.on = true;
    for (let i = 0; i < 2; i++) expect((await post(resendVerification, "/api/auth/resend-verification", { email })).status).toBe(200);
    expect((await db.authToken.findUniqueOrThrow({ where: { id: delivered.id } })).usedAt, "the delivered link still works").toBeNull();
    expect(await db.authToken.count({ where: { userId: user.id, type: "VERIFY" } }), "failed sends leave no token").toBe(1);
    // The provider recovers: the next request is not limited, sends, and only then voids the old link.
    failSend.on = false;
    expect((await post(resendVerification, "/api/auth/resend-verification", { email })).status).toBe(200);
    expect(await db.authToken.count({ where: { userId: user.id, type: "VERIFY" } })).toBe(2);
    expect((await db.authToken.findUniqueOrThrow({ where: { id: delivered.id } })).usedAt).not.toBeNull();
    const results = (await db.auditLog.findMany({ where: { actorId: user.id, event: "VERIFY_EMAIL_REQUESTED" }, orderBy: { createdAt: "asc" } }))
      .map((r) => (r.data as { result: string }).result);
    expect(results).toEqual(["FAILED", "FAILED", "SENT"]);
  });

  it("qa:TC missing AC3: failed, failed, then a successful resend: the original link still verifies after the two failures", async () => {
    const email = fresh();
    expect((await post(signUp, "/api/auth/signup", { name: "ZZ-TEST Mailfail", email, password: PW })).status).toBe(201);
    failSend.on = true;
    for (let i = 0; i < 2; i++) {
      const res = await post(resendVerification, "/api/auth/resend-verification", { email });
      expect(res.status, "a failed send answers like any other request").toBe(200);
      expect((await res.json()).message).not.toMatch(/has been sent/i);
    }
    failSend.on = false;
    // The two failures neither voided the delivered link nor used up the limit: the next request still sends.
    expect((await post(resendVerification, "/api/auth/resend-verification", { email })).status).toBe(200);
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    expect(await db.authToken.count({ where: { userId: user.id, type: "VERIFY" } }), "sign-up's link plus the one successful resend").toBe(2);
    // A second address: the original link is used right after two failed resends, and it verifies.
    const other = fresh();
    expect((await post(signUp, "/api/auth/signup", { name: "ZZ-TEST Mailfail", email: other, password: PW })).status).toBe(201);
    const first = lastVerifyToken(other)!;
    failSend.on = true;
    for (let i = 0; i < 2; i++) expect((await post(resendVerification, "/api/auth/resend-verification", { email: other })).status).toBe(200);
    failSend.on = false;
    expect((await post(verifyEmail, "/api/auth/verify", { token: first })).status).toBe(200);
    expect((await db.user.findUniqueOrThrow({ where: { email: other } })).emailVerifiedAt).not.toBeNull();
  });

  it("qa:TC missing AC3: failed resends are capped at 3 an hour, so a client cannot hammer the provider", async () => {
    const email = fresh();
    expect((await post(signUp, "/api/auth/signup", { name: "ZZ-TEST Mailfail", email, password: PW })).status).toBe(201);
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    failSend.on = true;
    for (let i = 0; i < 5; i++) expect((await post(resendVerification, "/api/auth/resend-verification", { email })).status).toBe(200);
    const results = (await db.auditLog.findMany({ where: { actorId: user.id, event: "VERIFY_EMAIL_REQUESTED" }, orderBy: { createdAt: "asc" } }))
      .map((r) => (r.data as { result: string }).result);
    expect(results).toEqual(["FAILED", "FAILED", "FAILED", "LIMITED"]);
  });

  it("qa:TC missing AC3: resend gives one neutral answer for a failed send, a sent one and an unknown address", async () => {
    const failing = fresh();
    const working = fresh();
    expect((await post(signUp, "/api/auth/signup", { name: "ZZ-TEST Neutral", email: failing, password: PW })).status).toBe(201);
    expect((await post(signUp, "/api/auth/signup", { name: "ZZ-TEST Neutral", email: working, password: PW })).status).toBe(201);
    const answer = async (email: string) => {
      const res = await post(resendVerification, "/api/auth/resend-verification", { email });
      return { status: res.status, body: await res.json() };
    };
    const sent = await answer(working);
    failSend.on = true;
    const failed = await answer(failing);
    const unknown = await answer(fresh());
    expect(failed).toEqual(sent);
    expect(unknown).toEqual(sent);
    expect(sent.status).toBe(200);
    expect(sent.body).toEqual({ status: "ok", message: RESEND_TEXT });
  });

  it("qa:TC missing AC3: a resend over the limit and a capped failed resend get the exact neutral text, never a claim that it went", async () => {
    const email = fresh();
    expect((await post(signUp, "/api/auth/signup", { name: "ZZ-TEST Neutral", email, password: PW })).status).toBe(201);
    failSend.on = true;
    const answers: unknown[] = [];
    // Three failed sends reach the failed-send cap; the 4th is limited without trying.
    for (let i = 0; i < 4; i++) answers.push(await (await post(resendVerification, "/api/auth/resend-verification", { email })).json());
    for (const a of answers) expect(a).toEqual({ status: "ok", message: RESEND_TEXT });
  });

  it("qa:TC missing AC3: an unknown, used or replaced verify token gets the exact unusable-link text", async () => {
    const email = fresh();
    expect((await post(signUp, "/api/auth/signup", { name: "ZZ-TEST Unusable", email, password: PW })).status).toBe(201);
    const first = lastVerifyToken(email)!;
    expect((await post(resendVerification, "/api/auth/resend-verification", { email })).status).toBe(200);
    const second = lastVerifyToken(email)!;
    const answer = async (token: string) => {
      const res = await post(verifyEmail, "/api/auth/verify", { token });
      return { status: res.status, body: await res.json() };
    };
    expect(await answer(first), "replaced by the resent link").toEqual({ status: 400, body: { error: UNUSABLE_TEXT } });
    expect(await answer("x".repeat(43)), "unknown").toEqual({ status: 400, body: { error: UNUSABLE_TEXT } });
    expect((await answer(second)).status).toBe(200);
    expect(await answer(second), "already used").toEqual({ status: 400, body: { error: UNUSABLE_TEXT } });
  });

  it("qa:TC missing AC3: resend stays rate-limited at 3 an hour", async () => {
    const email = fresh();
    expect((await post(signUp, "/api/auth/signup", { name: "ZZ-TEST Limit", email, password: PW })).status).toBe(201);
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    for (let i = 0; i < 4; i++) {
      expect((await post(resendVerification, "/api/auth/resend-verification", { email })).status).toBe(200);
    }
    // One token at sign-up plus two resends reach the limit of 3; the 3rd and 4th resends send nothing.
    expect(await db.authToken.count({ where: { userId: user.id, type: "VERIFY" } })).toBe(3);
  });
});

describe("qa:TC missing AC4: verification needs a click, and verification events are traceable", () => {
  it("qa:TC missing AC4: a link scanner's GET of /verify?token=... leaves the account unverified and the token unused", async () => {
    const email = fresh();
    expect((await new Client().post("/api/auth/signup", { name: "ZZ-TEST Scanner", email, password: PW })).status).toBe(201);
    const token = lastVerifyToken(email)!;
    const page = await fetch(`${BASE}/verify?token=${token}`, { headers: { "user-agent": "ZZ-TEST link scanner" } });
    expect(page.status).toBe(200);
    await page.text();
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    expect(user.emailVerifiedAt).toBeNull();
    const row = await db.authToken.findFirstOrThrow({ where: { userId: user.id, type: "VERIFY" }, orderBy: { createdAt: "desc" } });
    expect(row.usedAt).toBeNull();
  });

  it("qa:TC missing AC4: EMAIL_VERIFIED stores the client IP and user agent, and nothing else", async () => {
    const email = fresh();
    expect((await new Client().post("/api/auth/signup", { name: "ZZ-TEST Trace", email, password: PW })).status).toBe(201);
    const ua = "ZZ-TEST-UA verify " + "x".repeat(400);
    const res = await viaProxy("POST", "/api/auth/verify", "203.0.113.7", ua, { token: lastVerifyToken(email) });
    expect(res.status).toBe(200);
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    expect(user.emailVerifiedAt).not.toBeNull();
    const row = await db.auditLog.findFirstOrThrow({ where: { actorId: user.id, event: "EMAIL_VERIFIED" } });
    expect(row.ip).toBe("203.0.113.7");
    expect(row.data).toEqual({ userAgent: ua.slice(0, 300) });
  });

  it("qa:TC missing AC4: a resend request stores the client IP, user agent and result, and never the address", async () => {
    const email = fresh();
    expect((await new Client().post("/api/auth/signup", { name: "ZZ-TEST Trace", email, password: PW })).status).toBe(201);
    const ua = "ZZ-TEST-UA resend";
    expect((await viaProxy("POST", "/api/auth/resend-verification", "198.51.100.9", ua, { email })).status).toBe(200);
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    const rows = await db.auditLog.findMany({ where: { actorId: user.id, event: "VERIFY_EMAIL_REQUESTED" } });
    expect(rows).toHaveLength(1);
    expect(rows[0].ip).toBe("198.51.100.9");
    expect(rows[0].data).toEqual({ result: "SENT", userAgent: ua });
    expect(JSON.stringify(rows[0])).not.toContain(email);
  });

  it("qa:TC missing AC4: a resend over the limit is audited as LIMITED once an hour; an unknown address leaves no row", async () => {
    const email = fresh();
    expect((await new Client().post("/api/auth/signup", { name: "ZZ-TEST Limit", email, password: PW })).status).toBe(201);
    // Sign-up's link plus two resends reach the limit; the 3rd to 6th requests send nothing, and only one LIMITED row is written.
    for (let i = 0; i < 6; i++) await viaProxy("POST", "/api/auth/resend-verification", "198.51.100.10", "ZZ-TEST-UA", { email });
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    const results = (await db.auditLog.findMany({ where: { actorId: user.id, event: "VERIFY_EMAIL_REQUESTED" }, orderBy: { createdAt: "asc" } }))
      .map((r) => (r.data as { result: string }).result);
    expect(results).toEqual(["SENT", "SENT", "LIMITED"]);
    const before = await db.auditLog.count({ where: { event: "VERIFY_EMAIL_REQUESTED" } });
    expect((await viaProxy("POST", "/api/auth/resend-verification", "198.51.100.11", "ZZ-TEST-UA", { email: fresh() })).status).toBe(200);
    expect(await db.auditLog.count({ where: { event: "VERIFY_EMAIL_REQUESTED" } })).toBe(before);
  });
});
