// SECURITY (W226). runJob() turns a job's thrown error into data four ways: the JobRun row, the
// same row through GET /api/jobs (the Audit page's tooltip), the JOB_FAILED notice text in every
// Super Admin's bell, and the 500 the cron caller sees. A message that carries a DSN, a token or a
// host path must not reach any of them. Every value below is a fake and authenticates nothing.
import { describe, expect, it } from "vitest";
import { db } from "./concierge-helpers";
import { JOBS, redactError, runJob } from "../src/lib/jobs";
import { superAdmin } from "./helpers";

const FAKE_PASSWORD = "FAKE-w226-pony-SECRET";
const FAKE_TOKEN = "FAKE-w226-bearer-token-9f3a";
const FAKE_HOST_PATH = "/etc/sho/zz-w226-local.env";
// W244: the host is part of the boundary too. deploy/job.sh appends the 500 body to
// /var/log/sho/jobs.log, and a host:port names the machine to anyone who reads it.
const FAKE_HOST = "db.w226.invalid";
const MESSAGE =
  `connect failed for postgresql://sho:${FAKE_PASSWORD}@${FAKE_HOST}:5432/sho?sslmode=require` +
  ` (env ${FAKE_HOST_PATH}, authorization: Bearer ${FAKE_TOKEN})`;
const LEAKS = [FAKE_PASSWORD, FAKE_TOKEN, FAKE_HOST_PATH, FAKE_HOST];

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
      // W244: the host is `[host]`, the port and the database name stay - enough to tell a topology
      // failure from a credential one without naming the machine.
      expect(row.lastError).toMatch(/^connect failed for postgresql:\/\/\[redacted\]@\[host\]:5432\/sho/);
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

// SECURITY (W244). W226 closed the credential shapes: userinfo, `Bearer <token>`, a keyed secret, a
// host path. A routine database failure has none of those. What it does carry is topology - which
// machine the app talks to and on what port - and that is the shape /var/log/sho/jobs.log keeps:
// deploy/job.sh:12-13 appends the whole 500 body to it, one line per cron run, a lifetime and an
// audience (anyone with the box) that no UI row has. The JobRun row keeps the same text for the
// Audit tooltip. Both read redactError(), so one predicate closes both. Values below are fake.
describe("job error text: topology (SECURITY)", () => {
  it("a Prisma connect failure keeps the operation and loses the host", () => {
    const text = redactError(new Error("P1001: Can't reach database server at db.w244.invalid:5432"));
    expect(text, "the machine is gone").not.toContain("db.w244.invalid");
    // Not swallowed: the error class, the operation and the port that names the service remain.
    expect(text).toContain("P1001: Can't reach database server at");
    expect(text).toContain(":5432");
  });

  it("a Node connect failure keeps the errno and loses the address", () => {
    const text = redactError(Object.assign(new Error("connect ECONNREFUSED 10.244.9.7:5432"), { code: "ECONNREFUSED" }));
    expect(text, "the address is gone").not.toContain("10.244.9.7");
    expect(text).toContain("connect ECONNREFUSED");
    expect(text).toContain(":5432");
  });

  it("a DSN with no userinfo loses its host and keeps its database", () => {
    const text = redactError(new Error("connect failed for postgresql://db.w244.invalid:5432/sho"));
    expect(text).not.toContain("db.w244.invalid");
    expect(text).toContain("/sho");
  });

  it("a clock time and a version are not host:port, so the log still reads", () => {
    expect(redactError(new Error("retry at 02:45:41 after v1.2.3"))).toBe("retry at 02:45:41 after v1.2.3");
  });
});

