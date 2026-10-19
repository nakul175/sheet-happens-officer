// APL-2749. Overlapping reminder job runs (a cron retry, or a manual POST during the scheduled run)
// must not write the same due-date reminder twice. Everything goes through the shared test server:
// people, project and tasks are made through the API, the job is POSTed with JOB_SECRET, and the
// reminders are read back on GET /api/notifications. Names are ZZ-TEST, addresses nakul17+ aliases.
// The CRM_VISIBLE filter (AC3) is covered unchanged by tests/jobs-reminders-crm.test.ts and
// tests/jobs-reminders-crm-server.test.ts (`npm run test:reminder-modes`).
//
// qa:TC missing single run
// qa:TC missing 40 concurrent reminder requests
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BASE, istDate, task, type Account } from "./helpers";
import { zzTestData, type ZzProject } from "./zz-test-data";

const LOAD = 40;
const tag = `${Date.now().toString(36)}-${process.pid}`;
const zz = zzTestData("2749");

type BellItem = { text: string; href: string | null };

let leader: Account;
let holder: Account;
let proj: ZzProject;

async function postReminders(count: number) {
  const secret = process.env.JOB_SECRET ?? "";
  expect(secret.length, "JOB_SECRET (the shared test server's job token) is required").toBeGreaterThanOrEqual(16);
  const responses = await Promise.all(Array.from({ length: count }, () => fetch(`${BASE}/api/jobs/reminders`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}` },
  })));
  for (const res of responses) {
    const text = await res.text();
    expect(res.status, text.replaceAll(secret, "[redacted]").slice(0, 180)).toBe(200);
    expect((JSON.parse(text) as { status?: string }).status).toBe("OK");
  }
}

/** Bell items that are the due-tomorrow reminder for this task. */
async function dueTomorrow(who: Account, taskId: string, title: string) {
  const r = await who.c.get("/api/notifications?limit=200");
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return (r.json.items as BellItem[]).filter((item) => item.href === `/tasks/${taskId}` && item.text === `"${title}" is due tomorrow.`);
}

/** One task due tomorrow for each holder, so each run starts with no reminder written for them. */
async function dueTasks(label: string) {
  const holderTitle = `ZZ-TEST ${label} ${tag}`;
  const leaderTitle = `ZZ-TEST ${label} ${tag} leader`;
  const holderTaskId = await task(leader, proj.id, { title: holderTitle, assigneeId: holder.id, dueDate: istDate(1) });
  const leaderTaskId = await task(leader, proj.id, { title: leaderTitle, assigneeId: leader.id, dueDate: istDate(1) });
  return [
    { who: holder, taskId: holderTaskId, title: holderTitle },
    { who: leader, taskId: leaderTaskId, title: leaderTitle },
  ];
}

describe("qa:TC missing APL-2749: overlapping reminder runs write one reminder per holder, task, type and day", () => {
  beforeAll(async () => {
    leader = await zz.person("Leader");
    holder = await zz.person("Holder");
    proj = await zz.project(leader);
    const added = await leader.c.post(`/api/projects/${proj.id}/members`, { userId: holder.id, role: "EDITOR" });
    expect(added.status, JSON.stringify(added.json)).toBe(201);
  }, 60_000);

  afterAll(async () => {
    const problems = await zz.cleanUp();
    expect(problems, problems.join("\n")).toEqual([]);
  }, 60_000);

  it("qa:TC missing AC2: a single run writes the due-tomorrow reminder for each holder, linked to the task", async () => {
    const due = await dueTasks("single run");
    await postReminders(1);
    for (const d of due) {
      const items = await dueTomorrow(d.who, d.taskId, d.title);
      expect(items.map((item) => item.text)).toEqual([`"${d.title}" is due tomorrow.`]);
    }
  });

  it("qa:TC missing AC1: 40 concurrent POST /api/jobs/reminders leave exactly one reminder per holder and task", async () => {
    const due = await dueTasks("concurrent run");
    await postReminders(LOAD);
    const counts: Record<string, number> = {};
    for (const d of due) counts[d.who === holder ? "holder" : "leader"] = (await dueTomorrow(d.who, d.taskId, d.title)).length;
    console.log(`APL-2749 reminder rows per (recipient, task, TASK_DUE_TOMORROW) after ${LOAD} concurrent runs: ${JSON.stringify(counts)}`);
    expect(counts).toEqual({ holder: 1, leader: 1 });
  }, 90_000);
});
