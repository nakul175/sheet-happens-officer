import { afterAll, beforeAll, expect, it } from "vitest";
import { account, cleanupZz, Client, PW, type Account } from "./helpers";
import { assertLocalFixture } from "./e2e/local-fixture-guard";

let owner: Account, bystander: Account;

beforeAll(() => assertLocalFixture(process.env.DATABASE_URL));
afterAll(async () => {
  if (owner || bystander) await cleanupZz([], [owner, bystander].filter(Boolean));
});

it("keeps profile edits personal and revokes only the intended sessions through password and sign-out actions", async () => {
  owner = await account("profile-journey-owner");
  bystander = await account("profile-journey-other");
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
});
