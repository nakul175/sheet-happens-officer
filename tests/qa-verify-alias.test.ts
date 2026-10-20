// APL-2925. POST /api/qa/verify-alias: staging only, JOB_SECRET in X-Job-Secret, QA pool aliases only.
// verifyPoolAlias is called directly with a staging-like env; the CI server runs without QA_VERIFY_ALIASES, so over HTTP
// the route must answer 404 even with the right secret.
import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { POOL_ALIAS, qaVerifyEnabled, verifyPoolAlias } from "@/lib/qa-verify";
import { BASE, Client, PW } from "./helpers";

const SECRET = "zz-test-only-job-secret-0123456789";
const STAGING = { QA_VERIFY_ALIASES: "1", APP_URL: "https://staging.sheethappensofficer.com", JOB_SECRET: SECRET };
const ALIAS = "nakul17+zz-qa-local-3@aplyd.com";

/** The alias exists and is unverified, whatever an earlier run left. */
async function unverifiedAlias() {
  const c = new Client();
  const up = await c.post("/api/auth/signup", { name: "ZZ-TEST QA local-3", email: ALIAS, password: PW });
  expect([201, 409]).toContain(up.status);
  const user = await db.user.update({ where: { email: ALIAS }, data: { emailVerifiedAt: null }, select: { id: true } });
  return user.id;
}

describe("qa:TC missing APL-2925 verify-alias is off everywhere but staging", () => {
  it("qa:TC missing APL-2925: off without QA_VERIFY_ALIASES=1, on a production APP_URL, or with no usable APP_URL", () => {
    expect(qaVerifyEnabled(STAGING)).toBe(true);
    expect(qaVerifyEnabled({ ...STAGING, APP_URL: "https://pr2.staging.sheethappensofficer.com" })).toBe(true);
    for (const env of [
      { ...STAGING, QA_VERIFY_ALIASES: undefined },
      { ...STAGING, QA_VERIFY_ALIASES: "true" },
      { ...STAGING, APP_URL: "https://app.sheethappensofficer.com" },
      { ...STAGING, APP_URL: "https://sheethappensofficer.com." },
      { ...STAGING, APP_URL: "http://168.144.144.69" },
      { ...STAGING, APP_URL: undefined },
      { ...STAGING, APP_URL: "not a url" },
    ]) expect(qaVerifyEnabled(env), JSON.stringify(env.APP_URL) + env.QA_VERIFY_ALIASES).toBe(false);
  });

  it("qa:TC missing APL-2925: switched off, it is 404 before the secret or the address is looked at", async () => {
    await expect(verifyPoolAlias(ALIAS, SECRET, { ...STAGING, QA_VERIFY_ALIASES: undefined })).rejects.toMatchObject({ status: 404 });
    await expect(verifyPoolAlias(ALIAS, SECRET, { ...STAGING, APP_URL: "https://app.sheethappensofficer.com" })).rejects.toMatchObject({ status: 404 });
  });

  it("qa:TC missing APL-2925: the CI server (no QA_VERIFY_ALIASES) answers 404 over HTTP, even with its own JOB_SECRET", async () => {
    const res = await fetch(`${BASE}/api/qa/verify-alias`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-job-secret": process.env.JOB_SECRET ?? "" },
      body: JSON.stringify({ email: ALIAS }),
    });
    expect(res.status).toBe(404);
  });
});

describe("qa:TC missing APL-2925 verify-alias on staging", () => {
  it("qa:TC missing APL-2925: a wrong, short or missing secret is 401", async () => {
    for (const given of ["", "wrong", SECRET.slice(0, -1) + "x", SECRET + "x"]) {
      await expect(verifyPoolAlias(ALIAS, given, STAGING)).rejects.toMatchObject({ status: 401 });
    }
    // A server whose JOB_SECRET is too short never matches, even when the caller sends the same value.
    await expect(verifyPoolAlias(ALIAS, "short", { ...STAGING, JOB_SECRET: "short" })).rejects.toMatchObject({ status: 401 });
  });

  it("qa:TC missing APL-2925: only the fixed pool addresses are accepted", async () => {
    for (const ok of ["nakul17+zz-sa@aplyd.com", "nakul17+zz-qa-01-1@aplyd.com", "nakul17+zz-qa-20-3@aplyd.com", "nakul17+zz-qa-serial-2@aplyd.com"]) {
      expect(POOL_ALIAS.test(ok), ok).toBe(true);
    }
    for (const bad of ["root.test@aplyd.com", "nakul17@aplyd.com", "nakul17+zz-qa-21-1@aplyd.com", "nakul17+zz-qa-01-4@aplyd.com",
      "nakul17+zz-2669-x@aplyd.com", "nakul17+zz-sa@aplyd.com.evil.example", "x" + ALIAS, 42, undefined]) {
      await expect(verifyPoolAlias(bad, SECRET, STAGING), String(bad)).rejects.toMatchObject({ status: 400 });
    }
  });

  it("qa:TC missing APL-2925: a pool alias with no account is 404, and nothing is created", async () => {
    const email = "nakul17+zz-qa-19-3@aplyd.com";
    expect(await db.user.findUnique({ where: { email } })).toBeNull();
    await expect(verifyPoolAlias(email, SECRET, STAGING)).rejects.toMatchObject({ status: 404 });
    expect(await db.user.findUnique({ where: { email } })).toBeNull();
  });

  it("qa:TC missing APL-2925: an unverified pool alias is verified, its emailed links are spent, it is audited, and it can sign in", async () => {
    const id = await unverifiedAlias();
    const blocked = await new Client().post("/api/auth/signin", { email: ALIAS, password: PW });
    expect(blocked.status).toBe(403);

    expect(await verifyPoolAlias(` ${ALIAS.toUpperCase()} `, SECRET, STAGING)).toEqual({ status: "verified" });
    const user = await db.user.findUniqueOrThrow({ where: { id }, select: { emailVerifiedAt: true } });
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(await db.authToken.count({ where: { userId: id, type: "VERIFY", usedAt: null } })).toBe(0);
    const row = await db.auditLog.findFirst({ where: { event: "EMAIL_VERIFIED", actorId: id }, orderBy: { createdAt: "desc" } });
    expect(row?.data).toEqual({ via: "qa-verify-alias" });

    const signed = await new Client().post("/api/auth/signin", { email: ALIAS, password: PW });
    expect(signed.status).toBe(200);
    expect(await verifyPoolAlias(ALIAS, SECRET, STAGING)).toEqual({ status: "already-verified" });
  });
});
