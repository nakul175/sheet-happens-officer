// SHO-US-1.2 Verify email with a link (APL-2475). Acceptance criteria AC1 to AC4.
// Verification links are read from the test mail sink. Accounts use nakul17+ aliases and are deactivated afterwards.
import { test, expect, RUN } from "../support";
import { PASS, passwordOk, alias, zz, signUp, personByEmail, deactivate, waitForSinkMail, matchingMails, localTokenIsHashed } from "./qa";

const ghost = `zz-test-${RUN}-nobody@aplyd.com`; // never has an account

function needPass() {
  test.skip(!PASS, "Set SHO_QA_PASS (the shared password for the nakul17+ accounts).");
  test.skip(!passwordOk(PASS), "SHO_QA_PASS must be at least 8 characters with a letter and a number.");
}

test.describe("SHO-US-1.2 / APL-2475", () => {
  test("AC1: an unused link under 24 hours old verifies the account once, and a second use fails", async ({ anon, admin, later }) => {
    needPass();
    const email = alias("2475", "ac1", "aplyd.com");
    const signed = await signUp(anon.request, zz("ac1"), email);
    expect(signed.status, signed.body).toBe(201);
    const mail = await waitForSinkMail(email, "Verify");
    const hashed = await localTokenIsHashed(mail.token);
    if (hashed !== null) expect(hashed, "the link token is stored only as a hash").toBe(true);

    await anon.goto(`/verify?token=${mail.token}`);
    await expect(anon.getByRole("heading", { name: "Email verified" })).toBeVisible();
    const person = await personByEmail(admin.api, email);
    expect(person?.status).toBe("ACTIVE");
    later(() => deactivate(admin.api, person!.id));
    const signedIn = await anon.request.post("/api/auth/signin", { data: { email, password: PASS } });
    expect(signedIn.status()).toBe(200);

    const again = await anon.request.post("/api/auth/verify", { data: { token: mail.token } });
    expect(again.status()).toBe(400);
    expect((await again.json()).error).toBe("This link has expired or was already used.");
    await anon.goto(`/verify?token=${mail.token}`);
    await expect(anon).toHaveURL(/\/expired/);
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
    needPass();
    const email = alias("2475", "ac3", "aplyd.com");
    expect((await signUp(anon.request, zz("ac3"), email)).status).toBe(201);
    const first = await waitForSinkMail(email, "Verify");
    const person = await personByEmail(admin.api, email);
    later(() => deactivate(admin.api, person!.id));
    const firstHashed = await localTokenIsHashed(first.token);
    if (firstHashed !== null) expect(firstHashed, "the first link token is stored only as a hash").toBe(true);

    expect((await anon.request.post("/api/auth/resend-verification", { data: { email } })).ok()).toBe(true);
    const second = await waitForSinkMail(email, "Verify", first.token);
    expect(second.token).not.toBe(first.token);
    const secondHashed = await localTokenIsHashed(second.token);
    if (secondHashed !== null) expect(secondHashed, "the new link token is stored only as a hash").toBe(true);

    const old = await anon.request.post("/api/auth/verify", { data: { token: first.token } });
    expect(old.status()).toBe(400);
    expect((await old.json()).error).toBe("This link has expired or was already used.");
    const neu = await anon.request.post("/api/auth/verify", { data: { token: second.token } });
    expect(neu.ok()).toBe(true);
    expect((await personByEmail(admin.api, email))?.status).toBe("ACTIVE");
  });

  test("AC4: the resend answer is the same for an unknown address and for a verified one, so it reveals nothing", async ({ anon, admin, later }) => {
    needPass();
    const email = alias("2475", "ac4-known", "aplyd.com");
    expect((await signUp(anon.request, zz("ac4"), email)).status).toBe(201);
    const token = (await waitForSinkMail(email, "Verify")).token;
    expect((await anon.request.post("/api/auth/verify", { data: { token } })).ok()).toBe(true);
    const person = await personByEmail(admin.api, email);
    later(() => deactivate(admin.api, person!.id));

    const a = await anon.request.post("/api/auth/resend-verification", { data: { email: ghost } });
    const b = await anon.request.post("/api/auth/resend-verification", { data: { email } });
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
    needPass();
    const email = alias("2475", "ac4-limit", "aplyd.com");
    expect((await signUp(anon.request, zz("limit"), email)).status).toBe(201);
    await waitForSinkMail(email, "Verify");
    const person = await personByEmail(admin.api, email);
    later(() => deactivate(admin.api, person!.id));

    // Sign-up already sent one. Two more are allowed (3 per hour). The next one sends nothing.
    let previous = (await matchingMails(email, "Verify")).at(-1)?.token ?? "";
    for (let i = 0; i < 2; i++) {
      expect((await anon.request.post("/api/auth/resend-verification", { data: { email } })).ok()).toBe(true);
      const mail = await waitForSinkMail(email, "Verify", previous);
      previous = mail.token;
    }
    const before = (await matchingMails(email, "Verify")).length;
    const limited = await anon.request.post("/api/auth/resend-verification", { data: { email } });
    expect(limited.status()).toBe(200);
    const body = JSON.stringify(await limited.json());
    expect(body).toContain("try again later");
    expect(body).not.toMatch(/no account|not found|does not exist/i);
    expect((await matchingMails(email, "Verify")).length, "no fourth verification email").toBe(before);
    expect((await personByEmail(admin.api, email))?.status).toBe("UNVERIFIED");
  });
});
