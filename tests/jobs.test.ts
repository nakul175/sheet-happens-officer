// Scheduled-job notices (SHO-US-9.3 AC6, SHO-BUG-1). Runs the job runner in this one process, as the server does:
// each failing job must reach the Super Admin's bell, and the same job failing again within 20 hours adds nothing.
import { describe, expect, it } from "vitest";
import { superAdmin } from "./helpers";
import { db } from "./actor";
import { JOBS, runJob } from "../src/lib/jobs";

describe("job failure notices (9.3 AC6)", () => {
  it("tells the Super Admin about every failing job, once per job per day, within one process", async () => {
    const sa = await superAdmin();
    const stamp = Date.now();
    const names = [`test-fail-a-${stamp}`, `test-fail-b-${stamp}`];
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
      for (const name of names) JOBS.splice(JOBS.findIndex((j) => j.name === name), 1);
      await db.jobRun.deleteMany({ where: { job: { in: names } } });
      await db.notification.deleteMany({ where: { type: "JOB_FAILED", data: { path: ["job"], string_starts_with: "test-fail-" } } });
    }
  });
});
