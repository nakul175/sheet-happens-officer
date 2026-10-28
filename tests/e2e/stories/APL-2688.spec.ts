// [SHO-TECH] Graceful shutdown on SIGTERM (Linear APL-2688, PR #30).
// AC1 to AC4 are process-level: on SIGTERM the server stops accepting connections, lets an in-flight request finish
// (within SHUTDOWN_DRAIN_MS, 10s to 25s), disconnects Prisma, then exits 0 after a clean drain or non-zero after the
// timeout, with one log line for each case. The proof of that is tests/shutdown.test.ts in PR #30, which sends SIGTERM
// to the fixture process. This spec does not signal the staging process, and it does not restart the service.
// What a request to staging can show is that the app is up. /api/health returns 200, a normal authenticated
// request completes, and a burst of 40 read-only GETs (health plus authenticated reads) all succeed together.
// Nothing is created or changed. Those answers are the same on main, so this spec is not gated on PR #30.
import { test, expect, login } from "../support";

/** Read-only routes a signed-in Super Admin can open. No ids, so no ZZ-TEST row is required and none is written. */
const READS = [
  "/api/health",
  "/api/auth/me",
  "/api/projects",
  "/api/my-tasks",
  "/api/notifications",
  "/api/team",
  "/api/profile/sessions",
  "/api/profile/density",
  "/api/leaders",
  "/api/quick-add",
];

test.describe("SHO-TECH / APL-2688", () => {
  test("GET /api/health returns 200", async ({ admin }) => {
    const r = await admin.api.get("/api/health");
    const body = JSON.stringify(r.json);
    const pass = login("ADMIN").password;
    expect(r.status, body).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(body.includes(pass)).toBe(false);
  });

  test("a normal authenticated request completes successfully", async ({ admin }) => {
    // A request held open across SIGTERM is the "finishes an in-flight request" case in tests/shutdown.test.ts.
    const me = await admin.api.get("/api/auth/me");
    const body = JSON.stringify(me.json);
    const pass = login("ADMIN").password;
    expect(me.status, body).toBe(200);
    expect(me.json.user.id).toBe(admin.user.id);
    expect(body.includes(pass)).toBe(false);
    const projects = await admin.api.get("/api/projects");
    const list = JSON.stringify(projects.json);
    expect(projects.status, list).toBe(200);
    expect(Array.isArray(projects.json.projects)).toBe(true);
    expect(list.includes(pass)).toBe(false);
  });

  test("40 concurrent read-only requests all succeed", async ({ admin }) => {
    // Health plus authenticated GETs, in flight together. Read-only: no ZZ-TEST row is created and nothing is restored.
    const pass = login("ADMIN").password;
    const paths = Array.from({ length: 40 }, (_, i) => READS[i % READS.length]);
    const results = await Promise.all(paths.map((p) => admin.api.get(p)));
    expect(results).toHaveLength(40);
    for (let i = 0; i < results.length; i++) {
      const body = JSON.stringify(results[i].json);
      expect(results[i].status, paths[i]).toBe(200);
      expect(body.includes(pass)).toBe(false);
    }
    expect(paths.filter((p) => p === "/api/health").length).toBeGreaterThan(0);
    expect(results.filter((_, i) => paths[i] === "/api/health").every((r) => r.json.ok === true)).toBe(true);
  });
});
