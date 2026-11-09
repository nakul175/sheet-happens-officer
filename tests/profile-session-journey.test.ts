import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { account, cleanupZz, Client, PW, type Account } from "./helpers";
import { assertLocalFixture } from "./e2e/local-fixture-guard";
import { db } from "@/lib/db";

let owner: Account, bystander: Account;
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

beforeAll(() => assertLocalFixture(process.env.DATABASE_URL));
afterAll(async () => {
  const people = [owner, bystander].filter(Boolean);
  if (!people.length) return;
  let cleanup = false;
  try {
    if (people.length) await cleanupZz([], people);
    const ids = people.map((person) => person.id);
    const rows = await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, deactivatedAt: true } });
    expect(rows).toHaveLength(ids.length);
    expect(rows.every((person) => person.deactivatedAt !== null)).toBe(true);
    expect(await db.session.count({ where: { userId: { in: ids }, revokedAt: null } })).toBe(0);
    cleanup = true;
  } finally {
    mkdirSync("test-results/profile-session", { recursive: true });
    writeFileSync("test-results/profile-session/cleanup.json", JSON.stringify({ people: people.length, cleanup }, null, 2) + "\n");
  }
});

it("keeps profile edits personal and revokes only the intended sessions through password and sign-out actions", async () => {
  owner = await account("profile-journey-owner");
  bystander = await account("profile-journey-other");
  const bystanderBefore = fingerprint(await db.user.findUniqueOrThrow({ where: { id: bystander.id }, select: {
    id: true, workspaceId: true, name: true, passwordHash: true, compactRows: true,
    orgRole: true, emailVerifiedAt: true, deactivatedAt: true,
  } }));
  const second = new Client();
  expect((await second.post("/api/auth/signin", { email: owner.email, password: PW })).status).toBe(200);
  expect((await owner.c.patch("/api/profile", { name: "  Updated Owner  " })).json.name).toBe("Updated Owner");
  expect((await owner.c.put("/api/profile/density", { compact: true })).json).toEqual({ compact: true });
  expect((await bystander.c.get("/api/auth/me")).json.user.name).toBe(bystander.name);
  expect((await bystander.c.get("/api/profile/density")).json).toEqual({ compact: false });

  expect((await owner.c.post("/api/profile/sessions/sign-out-others")).json.signedOut).toBe(1);
  expect((await second.get("/api/auth/me")).status).toBe(401);
  expect((await owner.c.get("/api/auth/me")).status).toBe(200);
  expect((await bystander.c.get("/api/auth/me")).status).toBe(200);

  const third = new Client();
  expect((await third.post("/api/auth/signin", { email: owner.email, password: PW })).status).toBe(200);
  const changed = await owner.c.post("/api/profile/password", { current: PW, password: "updated-owner-pass-9", confirm: "updated-owner-pass-9" });
  expect(changed.status).toBe(200);
  expect((await third.get("/api/auth/me")).status).toBe(401);
  expect((await owner.c.get("/api/auth/me")).status).toBe(200);
  expect((await bystander.c.get("/api/auth/me")).status).toBe(200);

  const fourth = new Client();
  expect((await fourth.post("/api/auth/signin", { email: owner.email, password: "updated-owner-pass-9" })).status).toBe(200);
  expect((await fourth.get("/api/profile/density")).json).toEqual({ compact: true });
  expect((await fourth.get("/api/auth/me")).json.user.name).toBe("Updated Owner");
  expect((await owner.c.post("/api/profile/sessions/sign-out-all")).status).toBe(200);
  expect((await owner.c.get("/api/auth/me")).status).toBe(401);
  expect((await fourth.get("/api/auth/me")).status).toBe(401);
  expect((await bystander.c.get("/api/auth/me")).status).toBe(200);
  expect((await bystander.c.get("/api/profile/density")).json).toEqual({ compact: false });
  expect(fingerprint(await db.user.findUniqueOrThrow({ where: { id: bystander.id }, select: {
    id: true, workspaceId: true, name: true, passwordHash: true, compactRows: true,
    orgRole: true, emailVerifiedAt: true, deactivatedAt: true,
  } }))).toBe(bystanderBefore);
  expect(await db.session.count({ where: { userId: bystander.id, revokedAt: null } })).toBe(1);
});
