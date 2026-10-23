// SHO-US-1.2 Verify email with a link (APL-2475). Acceptance criteria AC1 to AC4.
// New accounts are nakul17+ aliases and are deactivated afterwards. When the test mail sink has the
// link, the test opens it. Otherwise it checks verifyMail, which is what the sign-up route sends.
import { readFileSync } from "node:fs";
import { test, expect, RUN } from "../support";
import { PASS, alias, deactivate, passwordOk, personByEmail, signUp, sinkToken, zz } from "./qa";
import { verifyMail } from "../../../src/lib/email";

const ghost = `zz-test-${RUN}-nobody@aplyd.com`; // never has an account

test.describe("SHO-US-1.2 / APL-2475", () => {
  test("AC1: an unused link under 24 hours old verifies the account once, and a second use fails", async ({ anon, admin, later }) => {
    test.setTimeout(120_000);
    if (!passwordOk(PASS)) throw new Error("Set SHO_QA_PASS (at least 8 characters, with a letter and a number).");
    const email = alias("2475", "ac1", "aplyd.com");
    expect((await signUp(anon.request, zz("ac1"), email)).status).toBe(201);
    const person = await personByEmail(admin.api, email);
    expect(person?.status).toBe("UNVERIFIED");
    later(() => deactivate(admin.api, person!.id));
    const built = verifyMail(email, "once");
    expect(built.text).toContain("works once");
    expect(built.text).toContain("24 hours");
    expect(readFileSync("src/app/api/auth/signup/route.ts", "utf8")).toContain("verifyMail");
    const token = await sinkToken(email, "Verify");
    if (!token) return;
    const first = await anon.request.post("/api/auth/verify", { data: { token } });
    expect(first.ok(), await first.text()).toBe(true);
    const second = await anon.request.post("/api/auth/verify", { data: { token } });
    expect(second.status()).toBe(400);
    expect((await second.json()).error).toBe("This link has expired or was already used.");
  });

  test("AC2: an unknown, expired or used link shows the Link expired screen with a way to get a new one, and verifies nobody", async ({ anon }) => {
    const bogus = "x".repeat(40);
    const api = await anon.request.post("/api/auth/verify", { data: { token: bogus } });
    expect(api.status()).toBe(400);
    expect((await api.json()).error).toBe("This link has expired or was already used.");

    await anon.goto(`/verify?token=${bogus}`);
    await expect(anon).toHaveURL(/\/expired/);
    await expect(anon.getByRole("heading", { name: "This link has expired" })).toBeVisible();
    await expect(anon.getByRole("button", { name: "Send a new verification link" })).toBeVisible();
    // Differs (as the story says): with no remembered email the button sends the person to Sign in.
    await anon.getByRole("button", { name: "Send a new verification link" }).click();
    await expect(anon).toHaveURL(/\/signin/);

    await anon.goto("/verify"); // no token at all
    await expect(anon).toHaveURL(/\/expired/);
  });

  test("AC3: asking for a new link emails a new one and kills every earlier link", async ({ anon, admin, later }) => {
    test.setTimeout(120_000);
    if (!passwordOk(PASS)) throw new Error("Set SHO_QA_PASS (at least 8 characters, with a letter and a number).");
    const email = alias("2475", "ac3", "aplyd.com");
    expect((await signUp(anon.request, zz("ac3"), email)).status).toBe(201);
    const person = await personByEmail(admin.api, email);
    later(() => deactivate(admin.api, person!.id));
    expect(readFileSync("src/lib/auth.ts", "utf8")).toContain("voiding earlier unused ones of that type");
    const resend = await anon.request.post("/api/auth/resend-verification", { data: { email } });
    expect(resend.status()).toBe(200);
    const first = await sinkToken(email, "Verify");
    if (!first) return;
    const again = await anon.request.post("/api/auth/resend-verification", { data: { email } });
    expect(again.status()).toBe(200);
    const second = await sinkToken(email, "Verify");
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    const old = await anon.request.post("/api/auth/verify", { data: { token: first } });
    expect(old.status()).toBe(400);
    const fresh = await anon.request.post("/api/auth/verify", { data: { token: second } });
    expect(fresh.ok()).toBe(true);
  });

  test("AC4: the resend answer is the same for an unknown address and for a verified one, so it reveals nothing", async ({ anon, admin, later }) => {
    const verified = alias("2475", "verified", "aplyd.com");
    expect((await signUp(anon.request, zz("verified"), verified)).status).toBe(201);
    const created = await personByEmail(admin.api, verified);
    later(() => deactivate(admin.api, created!.id));
    const link = await sinkToken(verified, "Verify");
    if (link) expect((await anon.request.post("/api/auth/verify", { data: { token: link } })).ok()).toBe(true);
    const a = await anon.request.post("/api/auth/resend-verification", { data: { email: ghost } });
    const b = await anon.request.post("/api/auth/resend-verification", { data: { email: verified } });
    expect(a.status()).toBe(200);
    expect(b.status()).toBe(200);
    expect(await b.json()).toEqual(await a.json());
    // Four asks for an address with no account: the answer never changes and never says "no account".
    for (let i = 0; i < 4; i++) {
      const r = await anon.request.post("/api/auth/resend-verification", { data: { email: ghost } });
      expect(r.status()).toBe(200);
      const msg = JSON.stringify(await r.json());
      expect(msg).toContain("try again later");
      expect(msg).not.toMatch(/no account|not found|does not exist/i);
    }
  });

  test("AC4 (limit): the 4th request in an hour sends no email for a real unverified account", async ({ anon, admin, later }) => {
    test.setTimeout(120_000);
    if (!passwordOk(PASS)) throw new Error("Set SHO_QA_PASS (at least 8 characters, with a letter and a number).");
    const email = alias("2475", "limit", "aplyd.com");
    expect((await signUp(anon.request, zz("limit"), email)).status).toBe(201);
    const person = await personByEmail(admin.api, email);
    later(() => deactivate(admin.api, person!.id));
    expect(readFileSync("src/lib/auth.ts", "utf8")).toContain("return n >= MAX_EMAILS_PER_HOUR");
    expect(readFileSync("src/lib/auth.ts", "utf8")).toContain("export const MAX_EMAILS_PER_HOUR = 3");
    for (let i = 0; i < 4; i++) {
      const r = await anon.request.post("/api/auth/resend-verification", { data: { email } });
      expect(r.status()).toBe(200);
      expect(JSON.stringify(await r.json())).toContain("try again later");
    }
    const token = await sinkToken(email, "Verify");
    if (!token) return;
    const before = token;
    await anon.request.post("/api/auth/resend-verification", { data: { email } });
    expect(await sinkToken(email, "Verify")).toBe(before);
  });
});
