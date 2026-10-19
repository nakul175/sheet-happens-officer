// Integration tests for sign-up, verification, sign-in, reset and sessions (SHO-US-1.1 to 1.5).
// Run against a live server that shares the outbox folder:
//   EMAIL_OUTBOX_DIR=/tmp/sho-outbox TASKBOARD_URL=http://localhost:3100 npm test
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const BASE = process.env.TASKBOARD_URL ?? "http://localhost:3000";
const OUTBOX = process.env.EMAIL_OUTBOX_DIR ?? ".outbox";
const run = Date.now();
const PW = "correct-horse-9";

class Client {
  cookie = "";
  async call(method: string, p: string, body?: unknown) {
    const res = await fetch(BASE + p, {
      method,
      headers: { "content-type": "application/json", ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    if (set) this.cookie = set.split(";")[0];
    const text = await res.text();
    return { status: res.status, json: text && res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : null, setCookie: set };
  }
}

/** Mails sent to an address, oldest first, with the token from the link. */
function mailsTo(email: string) {
  let files: string[] = [];
  try {
    files = readdirSync(OUTBOX).sort();
  } catch {
    return [];
  }
  return files
    .map((f) => JSON.parse(readFileSync(path.join(OUTBOX, f), "utf8")))
    .filter((m) => m.to === email)
    .map((m) => ({ subject: m.subject as string, token: (m.text as string).match(/token=([\w-]+)/)?.[1] ?? "" }));
}
const lastToken = (email: string) => mailsTo(email).at(-1)!.token;
const resets = (email: string) => mailsTo(email).filter((m) => /Reset/.test(m.subject));

let n = 0;
const fresh = () => `u${run}${n++}@aplyd.com`;
async function verifiedUser() {
  const email = fresh();
  const c = new Client();
  expect((await c.call("POST", "/api/auth/signup", { name: "Test", email, password: PW })).status).toBe(201);
  expect((await c.call("POST", "/api/auth/verify", { token: lastToken(email) })).status).toBe(200);
  return { email, c };
}

describe("sign-up (1.1)", () => {
  it("creates an unverified account, emails a link and does not sign in", async () => {
    const email = fresh();
    const c = new Client();
    const r = await c.call("POST", "/api/auth/signup", { name: "Asha", email, password: PW });
    expect(r.status).toBe(201);
    expect(r.setCookie).toBeNull();
    expect(mailsTo(email)).toHaveLength(1);
    expect((await c.call("GET", "/api/auth/me")).status).toBe(401);
  });

  it("rejects non-aplyd.com domains and look-alikes on the server", async () => {
    for (const email of ["a@gmail.com", "a@aplyd.co", "a@aplyd.com.example.net", "a@sub.aplyd.com", "a@aplyd.com@evil.io"]) {
      const r = await new Client().call("POST", "/api/auth/signup", { name: "X", email, password: PW });
      expect(r.status, email).toBe(400);
    }
  });

  it("rejects duplicates and weak passwords", async () => {
    const { email } = await verifiedUser();
    const dup = await new Client().call("POST", "/api/auth/signup", { name: "X", email, password: PW });
    expect(dup.status).toBe(409);
    expect(dup.json.error).toBe("An account with this email already exists.");
    for (const password of ["short1", "allletters", "12345678"]) {
      expect((await new Client().call("POST", "/api/auth/signup", { name: "X", email: fresh(), password })).status).toBe(400);
    }
  });
});

describe("verification (1.2)", () => {
  it("works once, and a used link is refused", async () => {
    const email = fresh();
    const c = new Client();
    await c.call("POST", "/api/auth/signup", { name: "V", email, password: PW });
    const token = lastToken(email);
    expect((await c.call("POST", "/api/auth/verify", { token })).status).toBe(200);
    expect((await c.call("POST", "/api/auth/verify", { token })).status).toBe(400);
  });

  it("resend voids the earlier link, is capped at 3 an hour, and answers the same for everyone", async () => {
    const email = fresh();
    const c = new Client();
    await c.call("POST", "/api/auth/signup", { name: "V", email, password: PW });
    const first = lastToken(email);
    const answers = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const r = await c.call("POST", "/api/auth/resend-verification", { email });
      expect(r.status).toBe(200);
      answers.add(JSON.stringify(r.json));
    }
    expect(mailsTo(email)).toHaveLength(3); // sign-up mail + 2 resends reach the cap of 3
    expect((await c.call("POST", "/api/auth/verify", { token: first })).status).toBe(400);
    answers.add(JSON.stringify((await c.call("POST", "/api/auth/resend-verification", { email: fresh() })).json));
    expect(answers.size).toBe(1);
  });
});

describe("sign-in and sessions (1.3, 1.5)", () => {
  it("signs in with an httpOnly cookie, then out; a replayed cookie is dead", async () => {
    const { email, c } = await verifiedUser();
    const r = await c.call("POST", "/api/auth/signin", { email, password: PW });
    expect(r.status).toBe(200);
    expect(r.setCookie).toMatch(/HttpOnly/i);
    expect(r.setCookie).toMatch(/Expires=/i);
    expect((await c.call("GET", "/api/auth/me")).json.user.email).toBe(email);
    expect((await c.call("POST", "/api/auth/signout")).status).toBe(204);
    c.cookie = r.setCookie!.split(";")[0];
    expect((await c.call("GET", "/api/auth/me")).status).toBe(401);
  });

  it("gives the same answer for a wrong password and for no account", async () => {
    const { email } = await verifiedUser();
    const a = await new Client().call("POST", "/api/auth/signin", { email, password: "wrong-pass-1" });
    const b = await new Client().call("POST", "/api/auth/signin", { email: fresh(), password: "wrong-pass-1" });
    expect(a.status).toBe(401);
    expect(a.status).toBe(b.status);
    expect(a.json).toEqual(b.json);
    expect(a.json.error).toBe("Email or password is incorrect.");
  });

  it("qa:TC missing asks an unverified person to verify only when the password is right", async () => {
    const email = fresh();
    const c = new Client();
    await c.call("POST", "/api/auth/signup", { name: "U", email, password: PW });
    expect((await c.call("POST", "/api/auth/signin", { email, password: "wrong-pass-1" })).json.error).toBe("Email or password is incorrect.");
    const r = await c.call("POST", "/api/auth/signin", { email, password: PW });
    expect(r.status).toBe(403);
    expect(r.json.error).toBe("Verify your email before you sign in. Open the link we emailed you, or resend it.");
    expect(r.json.code).toBe("EMAIL_NOT_VERIFIED");
  });

  it("locks after 5 failures, for real and unknown emails alike, without checking the password", async () => {
    for (const email of [(await verifiedUser()).email, fresh()]) {
      const c = new Client();
      for (let i = 0; i < 5; i++) {
        expect((await c.call("POST", "/api/auth/signin", { email, password: "wrong-pass-1" })).status).toBe(401);
      }
      const locked = await c.call("POST", "/api/auth/signin", { email, password: PW });
      expect(locked.status).toBe(429);
      expect(locked.json.error).toBe("Too many attempts. Try again in 15 minutes.");
    }
  });

  it("has no email-only sign-in left", async () => {
    const r = await new Client().call("POST", "/api/session", { email: fresh(), name: "X" });
    expect(r.status).toBe(404);
  });
});

describe("password reset (1.4)", () => {
  it("answers identically for known and unknown addresses, and mails only the known one", async () => {
    const { email } = await verifiedUser();
    const other = fresh();
    const a = await new Client().call("POST", "/api/auth/forgot-password", { email });
    const b = await new Client().call("POST", "/api/auth/forgot-password", { email: other });
    expect(a.status).toBe(200);
    expect(a.json).toEqual(b.json);
    expect(resets(email)).toHaveLength(1);
    expect(mailsTo(other)).toHaveLength(0);
  });

  it("resets once, signs out other sessions and clears a lockout", async () => {
    const { email, c: other } = await verifiedUser();
    await other.call("POST", "/api/auth/signin", { email, password: PW });
    const c = new Client();
    for (let i = 0; i < 5; i++) await c.call("POST", "/api/auth/signin", { email, password: "wrong-pass-1" });
    expect((await c.call("POST", "/api/auth/signin", { email, password: PW })).status).toBe(429);

    await c.call("POST", "/api/auth/forgot-password", { email });
    const token = lastToken(email);
    expect((await c.call("POST", "/api/auth/reset-password", { token, password: "new-pass-77", confirm: "nope-1234" })).status).toBe(400);
    expect((await c.call("POST", "/api/auth/reset-password", { token, password: "new-pass-77", confirm: "new-pass-77" })).status).toBe(200);
    expect((await c.call("POST", "/api/auth/reset-password", { token, password: "new-pass-88", confirm: "new-pass-88" })).status).toBe(400);

    expect((await other.call("GET", "/api/auth/me")).status).toBe(401);
    expect((await c.call("POST", "/api/auth/signin", { email, password: "new-pass-77" })).status).toBe(200);
    expect((await new Client().call("POST", "/api/auth/signin", { email, password: PW })).status).toBe(401);
  });

  it("limits reset emails to 3 an hour", async () => {
    const { email } = await verifiedUser();
    for (let i = 0; i < 5; i++) await new Client().call("POST", "/api/auth/forgot-password", { email });
    expect(resets(email)).toHaveLength(3);
  });
});
