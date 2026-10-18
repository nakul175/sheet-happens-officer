// SHO-BUG-1 Job-failure notices stop after the first one per process (APL-2608).
// Jobs start from cron or from POST /api/jobs/<name> with JOB_SECRET. This suite does not hold that
// secret, does not sign in, and does not create or delete a row. There is no ZZ-TEST record to clean up.
// notify() below is the function body from src/lib/notify.ts, types removed so it can run here.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test, expect } from "../support";

type Notice = { recipientId: string; type: string; data?: { job?: string; error?: string | null } };
type Notifier = (tx: unknown, recipients: string[], type: string, o: { data?: { job?: string; error?: string | null } }) => Promise<void>;

function productNotify(): { notify: Notifier; db: { notification?: { createMany: (args: { data: Notice[] }) => Promise<{ count: number }> } } } {
  const src = readFileSync("src/lib/notify.ts", "utf8");
  const start = src.indexOf("export async function notify(");
  const end = src.indexOf("/** Project action log");
  if (start < 0 || end < 0) throw new Error("notify() is not in src/lib/notify.ts");
  let fn = src.slice(start, end);
  fn = fn.replace(/export async function notify\([\s\S]*?\) \{/, "async function notify(tx, recipients, type, o) {");
  fn = fn.replaceAll("Set<string>", "Set");
  fn = fn.replace("(x): x is string =>", "(x) =>");
  fn = fn.replace(" as Json | undefined", "");
  const sent = new WeakMap<object, Set<string>>();
  const db: { notification?: { createMany: (args: { data: Notice[] }) => Promise<{ count: number }> } } = {};
  const reqCtx = { getStore: () => undefined };
  const context = vm.createContext({ sent, db, reqCtx });
  vm.runInContext(`${fn}\nthis.notify = notify;`, context);
  return { notify: (context as { notify: Notifier }).notify, db };
}

function standIn() {
  const rows: Notice[] = [];
  const tx = {
    notification: {
      createMany: async ({ data }: { data: Notice[] }) => {
        rows.push(...data);
        return { count: data.length };
      },
    },
  };
  return { tx, rows };
}

const jobs = readFileSync("src/lib/jobs.ts", "utf8");
const tell = jobs.slice(jobs.indexOf("async function tellSuperAdmins"), jobs.indexOf("export async function jobStatus"));
const check = jobs.slice(jobs.indexOf("export async function checkJobs"));
const notifySrc = readFileSync("src/lib/notify.ts", "utf8");
const proof = readFileSync("tests/jobs.test.ts", "utf8");

test("AC1: two different failing jobs each produce a JOB_FAILED notice for the Super Admin", async () => {
  const { notify } = productNotify();
  const first = standIn();
  const second = standIn();
  await notify(first.tx, ["super-admin"], "JOB_FAILED", { data: { job: "reminders", error: "reminders broke" } });
  await notify(second.tx, ["super-admin"], "JOB_FAILED", { data: { job: "stalled-deals", error: "stalled-deals broke" } });
  expect(first.rows.map((r) => r.data?.job)).toEqual(["reminders"]);
  expect(second.rows.map((r) => r.data?.job)).toEqual(["stalled-deals"]);
  expect(first.rows[0].type).toBe("JOB_FAILED");
  expect(second.rows[0].type).toBe("JOB_FAILED");
  // Each notice goes out on its own transaction client. That is what lets the second job through.
  expect(tell).toContain("await db.$transaction((tx) => notify(tx,");
  expect(tell).toContain('data: { path: ["job"], equals: job }');
  expect(proof).toContain("expect(await notices()).toEqual(names)");
});

test("AC2: after a JOB_FAILED notice, a later missed run in the same process also sends JOB_MISSED", async () => {
  const { notify } = productNotify();
  const failed = standIn();
  const missed = standIn();
  await notify(failed.tx, ["super-admin"], "JOB_FAILED", { data: { job: "reminders", error: "broke" } });
  await notify(missed.tx, ["super-admin"], "JOB_MISSED", { data: { job: "reminders", error: null } });
  expect(failed.rows.map((r) => r.type)).toEqual(["JOB_FAILED"]);
  expect(missed.rows.map((r) => r.type)).toEqual(["JOB_MISSED"]);
  expect(check).toContain('tellSuperAdmins("JOB_FAILED"');
  expect(check).toContain('tellSuperAdmins("JOB_MISSED"');
  // The dedupe key has no notice type, so one reused client would drop JOB_MISSED. A new transaction client does not.
  const reused = standIn();
  await notify(reused.tx, ["super-admin"], "JOB_FAILED", { data: { job: "reminders" } });
  await notify(reused.tx, ["super-admin"], "JOB_MISSED", { data: { job: "reminders" } });
  expect(reused.rows).toHaveLength(1);
});

test("AC3: the same job failing again within 20 hours adds no JOB_FAILED, and a JOB_MISSED for it is still sent", () => {
  expect(tell).toContain("Date.now() - 20 * 3600_000");
  expect(tell).toMatch(/findFirst\(\{\s*where:\s*\{\s*type,\s*createdAt:\s*\{\s*gte:\s*since\s*\},\s*data:\s*\{\s*path:\s*\["job"\],\s*equals:\s*job\s*\}/);
  expect(tell).toContain("if (already) return;");
  // type is part of the lookup, so a stored JOB_FAILED does not block JOB_MISSED for that job.
  expect(tell).toContain("type: \"JOB_FAILED\" | \"JOB_MISSED\"");
  expect(proof).toContain("the same job again within 20 hours: nothing new");
  expect(check).toContain('tellSuperAdmins("JOB_MISSED", s.job)');
});

test("AC4: two active Super Admins each get one notice when a job fails", async () => {
  const { notify } = productNotify();
  const { tx, rows } = standIn();
  await notify(tx, ["super-admin-a", "super-admin-b"], "JOB_FAILED", { data: { job: "purge-trash", error: "broke" } });
  expect(rows.map((r) => r.recipientId).sort()).toEqual(["super-admin-a", "super-admin-b"]);
  expect(rows.every((r) => r.type === "JOB_FAILED" && r.data?.job === "purge-trash")).toBe(true);
  expect(tell).toContain('orgRole: "SUPER_ADMIN", deactivatedAt: null');
  expect(tell).toContain("admins.map((a) => a.id)");
});

test("AC5: a second, different job notice in the same process is stored", async () => {
  const { notify, db } = productNotify();
  const again = standIn();
  await notify(again.tx, ["super-admin"], "JOB_FAILED", { data: { job: "reminders", error: "one" } });
  await notify(again.tx, ["super-admin"], "JOB_FAILED", { data: { job: "stalled-deals", error: "two" } });
  expect(again.rows).toHaveLength(1);
  const fresh = standIn();
  await notify(fresh.tx, ["super-admin"], "JOB_FAILED", { data: { job: "stalled-deals", error: "two" } });
  expect(fresh.rows.map((r) => r.data?.job)).toEqual(["stalled-deals"]);
  // The process-wide client is the one case notify() refuses to remember. Both notices are stored.
  const kept: Notice[] = [];
  db.notification = {
    createMany: async ({ data }) => {
      kept.push(...data);
      return { count: data.length };
    },
  };
  await notify(db, ["super-admin"], "JOB_FAILED", { data: { job: "reminders", error: "one" } });
  await notify(db, ["super-admin"], "JOB_FAILED", { data: { job: "stalled-deals", error: "two" } });
  expect(kept.map((r) => r.data?.job)).toEqual(["reminders", "stalled-deals"]);
  expect(notifySrc).toContain("const seen = tx === db ? new Set<string>() : sent.get(tx) ?? new Set<string>();");
  expect(tell).toContain("await db.$transaction((tx) => notify(tx,");
  expect(tell).not.toContain("notify(db,");
});
