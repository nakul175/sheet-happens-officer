// Scheduled-job notices (SHO-US-9.3 AC6, SHO-BUG-1). Runs the job runner in this one process, as the server does:
// each failing job must reach the Super Admin's bell, and the same job failing again within 20 hours adds nothing.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { account, BASE, superAdmin } from "./helpers";
import { db } from "./actor";
import { JOBS, runJob } from "../src/lib/jobs";
import { assertLocalFixture } from "./e2e/local-fixture-guard";

describe("job failure notices (9.3 AC6)", () => {
  it("requires the job token on every job route and keeps status private while health stays read-only", async () => {
    assertLocalFixture(process.env.DATABASE_URL, BASE);
    const member = await account("job-status-member");
    const sa = await superAdmin();
    for (const job of JOBS) {
      const url = `${BASE}/api/jobs/${job.name}`;
      for (const [kind, headers] of [
        ["anonymous", {}],
        ["signed-in member", { cookie: member.c.cookie }],
        ["invalid token", { authorization: "Bearer invalid-job-token" }],
        ["signed-in admin with invalid token", { cookie: sa.c.cookie, authorization: "Bearer invalid-job-token" }],
      ] as const) {
        const response = await fetch(url, { method: "POST", headers });
        expect(response.status, `${job.name} ${kind}`).toBe(401);
        expect(await response.json()).toEqual({ error: "Not allowed" });
      }
    }
    const anonymousStatus = await fetch(`${BASE}/api/jobs`);
    expect(anonymousStatus.status).toBe(401);
    expect((await member.c.get("/api/jobs")).status).toBe(404);
    expect((await sa.c.get("/api/jobs")).status).toBe(200);
    const health = await fetch(`${BASE}/api/health`);
    expect(health.status).toBe(200);
    expect(health.headers.get("cache-control")).toBe("no-store");
    expect((await health.json()).ok).toBe(true);
  });

  it("tells the Super Admin about every failing job, once per job per day, within one process", async () => {
    assertLocalFixture(process.env.DATABASE_URL, BASE);
    const sa = await superAdmin();
    const stamp = Date.now();
    const runId = randomUUID();
    const names = [`test-fail-a-${runId}`, `test-fail-b-${runId}`];
    for (const name of names) JOBS.push({ name, about: "Test job that always fails", run: async () => { throw new Error(`${name} broke`); } });
    const notices = async () => (await db.notification.findMany({ where: { recipientId: sa.id, type: "JOB_FAILED", createdAt: { gte: new Date(stamp - 1000) } }, select: { data: true } }))
      .map((n) => (n.data as { job: string }).job).filter((j) => names.includes(j)).sort();
    try {
      await expect(runJob(names[0])).rejects.toMatchObject({ status: 500 });
      await expect(runJob(names[1])).rejects.toMatchObject({ status: 500 });
      expect(await notices()).toEqual(names); // one notice per job, not one per process
      expect((await db.jobRun.findUniqueOrThrow({ where: { job: names[1] } })).lastStatus).toBe("FAILED");
      await expect(runJob(names[0])).rejects.toMatchObject({ status: 500 });
      expect(await notices()).toEqual(names); // the same job again within 20 hours: nothing new
      const bell = (await sa.c.get("/api/notifications")).json.items as { text: string; href: string }[];
      for (const name of names) expect(bell.find((n) => n.text.includes(`"${name}" failed: ${name} broke`))?.href).toBe("/audit");
    } finally {
      for (const name of names) {
        const index = JOBS.findIndex((j) => j.name === name);
        if (index >= 0) JOBS.splice(index, 1);
      }
      await db.jobRun.deleteMany({ where: { job: { in: names } } });
      const candidates = await db.notification.findMany({
        where: { recipientId: sa.id, type: "JOB_FAILED", createdAt: { gte: new Date(stamp - 1000) } },
        select: { id: true, data: true },
      });
      const ownedIds = candidates
        .filter((row) => names.includes((row.data as { job?: string } | null)?.job ?? ""))
        .map((row) => row.id);
      await db.notification.deleteMany({ where: { id: { in: ownedIds } } });
      expect(await db.notification.count({ where: { id: { in: ownedIds } } })).toBe(0);
    }
  });
});
