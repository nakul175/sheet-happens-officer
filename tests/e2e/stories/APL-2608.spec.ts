// SHO-BUG-1 Job-failure notices stop after the first one per process  (Linear APL-2608)
// No numbered ACs in the issue; follows its "Expected" and "Test" paragraphs.
import { test } from "../support";

test.skip("A second, different failing job still notifies the Super Admin (and a repeat of the first within 20 hours does not)", () => {
  // Reason: needs two jobs to fail on the server. Jobs run by cron or by POST /api/jobs/<name> with the JOB_SECRET, which is a server secret
  // this suite must not hold, and staging cannot be made to fail a job on demand. Covered by tests/jobs.test.ts "job failure notices (9.3 AC6)" (vitest).
});

test.skip("Super Admin bell shows one notice per failing job per day", () => {
  // Reason: same as above. A person can check the bell the morning after a real job failure.
});
