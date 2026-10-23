// SECURITY (W226). runJob() turns a job's thrown error into data four ways: the JobRun row, the
// same row through GET /api/jobs (the Audit page's tooltip), the JOB_FAILED notice text in every
// Super Admin's bell, and the 500 the cron caller sees. A message that carries a DSN, a token or a
// host path must not reach any of them. Every value below is a fake and authenticates nothing.
import { describe, expect, it } from "vitest";
import { db } from "./concierge-helpers";
import { JOBS, runJob } from "../src/lib/jobs";
import { superAdmin } from "./helpers";

const FAKE_PASSWORD = "FAKE-w226-pony-SECRET";
const FAKE_TOKEN = "FAKE-w226-bearer-token-9f3a";
const FAKE_HOST_PATH = "/etc/sho/zz-w226-local.env";
const MESSAGE =
  `connect failed for postgresql://sho:${FAKE_PASSWORD}@db.w226.invalid:5432/sho?sslmode=require` +
  ` (env ${FAKE_HOST_PATH}, authorization: Bearer ${FAKE_TOKEN})`;
const LEAKS = [FAKE_PASSWORD, FAKE_TOKEN, FAKE_HOST_PATH];

describe("job error text (SECURITY)", () => {
  it("a message carrying a DSN, a token and a host path leaks none of them, and still says what failed", async () => {
    const sa = await superAdmin();
    // A job the server knows, so GET /api/jobs lists it: jobStatus() maps the server's own JOBS
    // list over the JobRun rows (src/lib/jobs.ts:136-142), so a made-up name never reaches the API.
    const wire = "concierge-budget";
    const at = JOBS.findIndex((j) => j.name === wire);
    const original = JOBS[at];
    const before = await db.jobRun.findUnique({ where: { job: wire } });
    // A name nobody has registered: the notice is deduped per job name, so the bell needs its own.
    const probe = `zz-w226-leak-${Date.now()}`;
    JOBS[at] = { ...original, run: async () => { throw new Error(MESSAGE); } };
    JOBS.push({ name: probe, about: "SECURITY probe: fails with a fake DSN", run: async () => { throw new Error(MESSAGE); } });
    try {
      const thrown = await runJob(wire).then(() => null, (e: { status?: number; message?: string }) => e);
      expect(thrown?.status, "a failing job is a 500 for the cron caller").toBe(500);

      const row = await db.jobRun.findUniqueOrThrow({ where: { job: wire } });
      expect(row.lastStatus).toBe("FAILED");
      for (const secret of LEAKS) expect(row.lastError, "JobRun.lastError").not.toContain(secret);

      const jobs = (await sa.c.get("/api/jobs")).json.jobs as { job: string; lastStatus: string | null; lastError: string | null }[];
      const view = jobs.find((j) => j.job === wire);
      expect(view?.lastStatus, "the row is on GET /api/jobs").toBe("FAILED");
      for (const secret of LEAKS) expect(view?.lastError, "GET /api/jobs jobs[].lastError").not.toContain(secret);
      expect(view?.lastError, "the API returns the stored row, redacted").toBe(row.lastError);

      await runJob(probe).catch(() => {});
      const bell = (await sa.c.get("/api/notifications")).json.items as { text: string }[];
      const notice = bell.find((n) => n.text.includes(probe));
      expect(notice, "a JOB_FAILED notice was sent for this job").toBeTruthy();
      for (const secret of LEAKS) expect(notice?.text, "GET /api/notifications items[].text").not.toContain(secret);

      for (const secret of LEAKS) expect(thrown?.message, "the 500 body").not.toContain(secret);
      // The redaction must not swallow the diagnosis: what failed, and where, is still there.
      expect(row.lastError).toMatch(/^connect failed for postgresql:\/\/\[redacted\]@db\.w226\.invalid:5432\/sho/);
      expect(thrown?.message).toContain(`Job ${wire} failed`);
      expect(notice?.text).toContain(`Scheduled job "${probe}" failed`);
    } finally {
      JOBS[at] = original;
      JOBS.splice(JOBS.findIndex((j) => j.name === probe), 1);
      if (before) await db.jobRun.update({ where: { job: wire }, data: before });
      else await db.jobRun.deleteMany({ where: { job: wire } });
      await db.jobRun.deleteMany({ where: { job: probe } });
      await db.notification.deleteMany({ where: { type: "JOB_FAILED", data: { path: ["job"], equals: probe } } });
      await db.notification.deleteMany({ where: { type: "JOB_FAILED", data: { path: ["job"], equals: wire }, createdAt: { gte: new Date(Date.now() - 120_000) } } });
    }
  });
});
