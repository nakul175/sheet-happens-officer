// APL-2742 (prod hotfix). Two parts:
// 1. Sign-in refuses an unverified account and says how to get a new link (live server, like auth.test.ts).
// 2. When Resend rejects or cannot be reached, the failure is logged with the status and Resend's error name and
//    message only (no key, no body, no link), and sign-up / resend tell the person instead of failing with a 500.
//    The provider is faked here: sendMail is called in this process, and the routes are called through their own
//    POST handlers with sendMail made to fail.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, PW } from "./helpers";
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

const run = Date.now();
let n = 0;
const fresh = () => `nakul17+zztest-apl2742-${run}-${n++}@aplyd.com`;
const FAKE_KEY = "re_test_not_a_real_key_0000";
const MAIL = { to: "nakul17+zztest-apl2742@aplyd.com", subject: "Verify your email for Sheet Happens Officer", text: "Open https://app.example/verify?token=SECRET-TOKEN-123" };

const post = (route: (req: Request) => Promise<Response>, path: string, body: unknown) =>
  route(new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

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
    expect(r.json.error).toMatch(/verify your email/i);
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
      { statusCode: 403, name: "validation_error", message: "The sheethappensofficer.com domain is not verified." },
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
    expect(line).toContain("The sheethappensofficer.com domain is not verified.");
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
  });

  it("qa:TC missing AC3: sign-up answers emailSent true when the send works", async () => {
    const res = await post(signUp, "/api/auth/signup", { name: "ZZ-TEST Mailok", email: fresh(), password: PW });
    expect(res.status).toBe(201);
    expect((await res.json()).emailSent).toBe(true);
  });

  it("qa:TC missing AC3: resend answers 503 with a clear message when the send fails", async () => {
    const email = fresh();
    expect((await post(signUp, "/api/auth/signup", { name: "ZZ-TEST Mailfail", email, password: PW })).status).toBe(201);
    failSend.on = true;
    const res = await post(resendVerification, "/api/auth/resend-verification", { email });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/could not send/i);
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
