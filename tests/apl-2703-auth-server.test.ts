// APL-2703, server-side checks the story specs cannot make through the browser (Pam D15-D17 at 6ff8137):
// the session really ends 30 days after sign-in (APL-2478 AC1), an admin-added password is stored only as a hash
// (APL-2621 AC4) and a verification link older than 24 hours is refused (APL-2475 AC2).
// The time checks call the server code in-process with a fake clock. The test only reads the database; people are
// ZZ-TEST with nakul17+ aliases, created and deactivated through the API.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Client, OUTBOX, PW, account, superAdmin, type Account } from "./helpers";

let cookieToken = "";
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "sho_session" && cookieToken ? { name, value: cookieToken } : undefined),
    set: () => undefined,
    delete: () => undefined,
  }),
}));

// handle() waits on connection(), which needs a live request; the route itself runs unchanged.
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => undefined }));

const { db } = await import("../src/lib/db");
const { currentUser, verifyPassword, SESSION_DAYS, VERIFY_HOURS } = await import("../src/lib/auth");
const verifyRoute = await import("../src/app/api/auth/verify/route");

const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}`;
const DAY = 86_400_000;
const people: string[] = [];
let sa: Account;

function mails(to: string) {
  let files: string[] = [];
  try { files = readdirSync(OUTBOX).sort(); } catch { return []; }
  return files.filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(path.join(OUTBOX, f), "utf8")) as { to: string; subject: string; text: string })
    .filter((m) => m.to === to);
}

beforeAll(async () => { sa = await superAdmin(); }, 60_000);
afterEach(() => { vi.useRealTimers(); cookieToken = ""; });
afterAll(async () => {
  const problems: string[] = [];
  for (const id of people.splice(0)) {
    const r = await sa.c.post(`/api/team/${id}/deactivate`, { reassign: "leaders" });
    if (r.status !== 200) problems.push(`deactivate ${id}: ${r.status} ${JSON.stringify(r.json)}`);
  }
  expect(problems, "ZZ-TEST clean-up through the API").toEqual([]);
}, 60_000);

describe("qa:TC missing APL-2703 server-side auth checks behind the sign-in story specs", () => {
  it("qa:TC missing APL-2478 AC1: the session ends 30 days after sign-in", async () => {
    const who = await account(`ZZ-TEST 2478 session ${RUN}`, `nakul17+zz-2478-session-${RUN}@aplyd.com`);
    people.push(who.id);
    cookieToken = who.c.cookie.replace(/^sho_session=/, "");
    const { createHash } = await import("node:crypto");
    const session = await db.session.findUniqueOrThrow({ where: { tokenHash: createHash("sha256").update(cookieToken).digest("hex") } });
    // The end is fixed at sign-in: 30 days after the session was created.
    expect(SESSION_DAYS).toBe(30);
    expect(Math.abs(session.expiresAt.getTime() - session.createdAt.getTime() - 30 * DAY)).toBeLessThan(5_000);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(session.expiresAt.getTime() - 1);
    expect((await currentUser()).id).toBe(who.id);
    vi.setSystemTime(session.expiresAt.getTime());
    await expect(currentUser()).rejects.toMatchObject({ status: 401, message: "Not signed in" });
    // Activity before the end did not move it.
    const after = await db.session.findUniqueOrThrow({ where: { id: session.id } });
    expect(after.expiresAt.toISOString()).toBe(session.expiresAt.toISOString());
  });

  it("qa:TC missing APL-2621 AC4: an added person's password is stored only as a hash", async () => {
    const email = `nakul17+zz-2621-hash-${RUN}@aplyd.com`;
    const r = await sa.c.post("/api/team", { firstName: "ZZ-TEST", lastName: `hash ${RUN}`, email, role: "MEMBER" });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    people.push(r.json.person.id);
    const password = mails(email).at(-1)?.text.match(/^Password: (.+)$/m)?.[1];
    expect(password, "the emailed password").toBeTruthy();
    expect(JSON.stringify(r.json)).not.toContain(password!);
    const row = await db.user.findUniqueOrThrow({ where: { id: r.json.person.id }, select: { passwordHash: true } });
    expect(row.passwordHash.startsWith("scrypt$")).toBe(true);
    expect(row.passwordHash).not.toContain(password!);
    expect(await verifyPassword(password!, row.passwordHash)).toBe(true);
  });

  it("qa:TC missing APL-2475 AC2: a verification link older than 24 hours is refused and verifies nobody", async () => {
    const email = `nakul17+zz-2475-expired-${RUN}@aplyd.com`;
    const c = new Client();
    const s = await c.post("/api/auth/signup", { name: `ZZ-TEST 2475 expired ${RUN}`, email, password: PW });
    expect(s.status, JSON.stringify(s.json)).toBe(201);
    const token = mails(email).filter((m) => /Verify/.test(m.subject)).at(-1)?.text.match(/token=([\w-]+)/)?.[1];
    expect(token, "the verification link").toBeTruthy();
    const user = await db.user.findUniqueOrThrow({ where: { email }, select: { id: true, createdAt: true } });
    people.push(user.id);
    expect(VERIFY_HOURS).toBe(24);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 24 * 3_600_000 + 60_000);
    const res = await verifyRoute.POST(new Request("http://local/api/auth/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "This link has expired or was already used." });
    vi.useRealTimers();

    expect((await db.user.findUniqueOrThrow({ where: { id: user.id }, select: { emailVerifiedAt: true } })).emailVerifiedAt).toBeNull();
    const signin = await new Client().post("/api/auth/signin", { email, password: PW });
    expect(signin.status).not.toBe(200);
  });
});
