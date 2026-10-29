// Exercise the extracted pool restore helper through actual app APIs, on a disposable local database only.
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { restorePoolPerson } from "./e2e/helpers/qa-cleanup";
import { account, BASE, Client, PW, superAdmin, type Account } from "./helpers";

let root: Account | undefined;
let person: Account | undefined;

beforeAll(async () => {
  const local = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (!local.has(new URL(BASE).hostname) || !local.has(new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid").hostname)) {
    throw new Error("SHO-2915 pool restoration regression requires a local app and disposable database.");
  }
  root = await superAdmin();
  person = await account("cleanup2915", `nakul17+zz-cleanup-2915-${Date.now()}@aplyd.com`, "ZZ-TEST pool cleanup 2915");
});

afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  if (!root) return;
  try {
    if (person) {
      const seen = await root.c.get(`/api/team/${person.id}`);
      expect(seen.status).toBe(200);
      if (seen.json.person.status !== "DEACTIVATED") {
        expect((await root.c.post(`/api/team/${person.id}/deactivate`, { reassign: "leaders" })).status).toBe(200);
      }
    }
  } finally { expect((await root.c.post("/api/auth/signout")).status).toBe(204); }
});

it("SHO-2915 restores an actual deactivated Admin alias to an active Member", async () => {
  expect((await root!.c.patch(`/api/team/${person!.id}`, { orgRole: "ADMIN" })).status).toBe(200);
  expect((await root!.c.post(`/api/team/${person!.id}/deactivate`, { reassign: "leaders" })).status).toBe(200);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await restorePoolPerson(root!.c, person!.id);
  const restored = await root!.c.get(`/api/team/${person!.id}`);
  expect(restored.status).toBe(200);
  expect(restored.json.person).toMatchObject({ status: "ACTIVE", orgRole: "MEMBER" });
  const again = new Client();
  try {
    expect((await again.post("/api/auth/signin", { email: person!.email, password: PW })).status).toBe(200);
  } finally { expect((await again.post("/api/auth/signout")).status).toBe(204); }
  expect(warn).not.toHaveBeenCalled();
});

it("SHO-2915 logs a real missing-person 404 without attempting a restore write", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const post = vi.spyOn(root!.c, "post"), patch = vi.spyOn(root!.c, "patch");
  await restorePoolPerson(root!.c, `zz-missing-2915-${Date.now()}`);
  expect(warn).toHaveBeenCalledExactlyOnceWith("[qa-alias] Cannot restore pool person: Team read failed", 404);
  expect(post).not.toHaveBeenCalled();
  expect(patch).not.toHaveBeenCalled();
});
