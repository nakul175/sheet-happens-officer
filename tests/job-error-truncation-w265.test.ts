// QA (W265). redactError() caps a job's error text at 500 characters, because three sinks read it:
// the JobRun row (the Audit page's tooltip), the JOB_FAILED notice in every Super Admin's bell, and
// the 500 body that deploy/job.sh:12-13 appends to /var/log/sho/jobs.log. The cap is not the defect;
// what it kept is. Prisma's message for a failed query is a code frame FIRST and the cause LAST, so a
// head-only cut keeps the frame and drops the reason: the line an operator reads names the operation
// and never says what went wrong. Measured at this head through the running server (schema w265),
// a failing `reminders` job answered 500 with a 511-character body that ended mid-frame
// ("5685     const today = (0, __TURBOPACK_") and contained no "does not exist" anywhere.
// The fixture below is that shape: a frame longer than the cap, then the cause.
import { describe, expect, it } from "vitest";
import { redactError } from "../src/lib/jobs";

const FRAME = Array.from(
  { length: 12 },
  (_, i) => `  ${5680 + i}     const today = (0, __TURBOPACK__imported__module__${i}[/*] /* eslint-disable */);`,
).join("\n");
const CAUSE = "The table `public.Task` does not exist in the current database.";
const PRISMA = `\nInvalid \`db.task.findMany()\` invocation in\n[path]/chunks/[root-of-the-server]__1l8neudss7o1o._.js:5686:151\n\n${FRAME}\n\n${CAUSE}`;

describe("job error text: a long message keeps its cause (W265)", () => {
  it("a multi-line Prisma failure longer than the cap still says what went wrong", () => {
    expect(PRISMA.length, "the fixture has to be longer than the cap, or this proves nothing").toBeGreaterThan(500);
    const text = redactError(new Error(PRISMA));
    expect(text.length, "the size bound every one of the three sinks relies on").toBeLessThanOrEqual(500);
    expect(text, "the operation survives").toContain("db.task.findMany()");
    expect(text, "the cause survives, which is the whole point of the line").toContain("does not exist");
  });

  it("a message inside the cap is returned whole, with nothing elided", () => {
    // W244's topology redaction still applies; only the elision is absent.
    expect(redactError(new Error("connect ECONNREFUSED 10.244.9.7:5432"))).toBe("connect ECONNREFUSED [host]:5432");
  });
});
