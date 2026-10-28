// SHO-US-7.4 Due-tomorrow and overdue reminders (Linear APL-2509, child of APL-2471).
// One test per acceptance criterion. People are nakul17+ aliases signed in with SHO_QA_PASS.
// Tasks are ZZ-TEST. The reminders job runs only against the local server.
// Pam left no qa:TC cases on this issue.
import { test, expect, zz } from "../support";
import { newProject, newTask, ymd, type Who } from "../g2";
import { QA_PASS, cast, gateFile, noSecret, runLocalJob } from "../helpers/qa-alias";

gateFile();

type Note = { text: string };
const notices = async (who: Who) => {
  const r = await who.api.get("/api/notifications?limit=200");
  noSecret(JSON.stringify(r.json));
  return (r.json.items as Note[]).map((n) => n.text);
};
const about = (texts: string[], title: string) => texts.filter((t) => t.includes(`"${title}"`) && / is (due|overdue)/.test(t));

test("AC1: an open task due tomorrow sends its holder one Due tomorrow notice when the day-before job runs", async ({ browser, later }) => {
  const { admin, people: [holder] } = await cast(browser, later, ["tomorrow"]);
  const project = await newProject(admin, later, { label: "us74 tomorrow", members: [{ who: holder, role: "EDITOR" }] });
  const title = zz("due tomorrow");
  await newTask(admin, project.id, { title, assigneeId: holder.user.id, dueDate: ymd(1) });
  const jobs = (await admin.api.get("/api/jobs")).json.jobs as { job: string; about: string }[];
  expect(jobs.find((j) => j.job === "reminders")?.about).toMatch(/8:00/);
  await runLocalJob("reminders");
  const hits = about(await notices(holder), title);
  expect(hits).toEqual([`"${title}" is due tomorrow.`]);
  expect(about(await notices(admin), title)).toHaveLength(0);
});

test("AC2: running the job twice on the same day does not send a second reminder", async ({ browser, later }) => {
  const { admin, people: [holder] } = await cast(browser, later, ["twice"]);
  const project = await newProject(admin, later, { label: "us74 twice", members: [{ who: holder, role: "EDITOR" }] });
  const title = zz("once a day");
  await newTask(admin, project.id, { title, assigneeId: holder.user.id, dueDate: ymd(0) });
  await runLocalJob("reminders");
  await runLocalJob("reminders");
  expect(about(await notices(holder), title)).toEqual([`"${title}" is due today.`]);
});

test("AC3: a completed task sends no reminder", async ({ browser, later }) => {
  const { admin, people: [holder] } = await cast(browser, later, ["done"]);
  const project = await newProject(admin, later, { label: "us74 done", members: [{ who: holder, role: "EDITOR" }] });
  const done = zz("already done");
  const open = zz("still open");
  const doneId = await newTask(admin, project.id, { title: done, assigneeId: holder.user.id, dueDate: ymd(1) });
  await newTask(admin, project.id, { title: open, assigneeId: holder.user.id, dueDate: ymd(1) });
  expect((await holder.api.post(`/api/tasks/${doneId}/complete`, {})).status).toBe(200);
  await runLocalJob("reminders");
  const texts = await notices(holder);
  expect(about(texts, done)).toHaveLength(0);
  expect(about(texts, open)).toEqual([`"${open}" is due tomorrow.`]);
});

test("AC4: overdue reminders go out on day 1 and then weekly through day 22, and not on the days in between or after 28 days", async ({ browser, later }) => {
  test.setTimeout(120_000);
  const { admin, people: [holder] } = await cast(browser, later, ["late"]);
  const project = await newProject(admin, later, { label: "us74 late", members: [{ who: holder, role: "EDITOR" }] });
  const cases = [
    { off: 1, title: zz("r tomorrow"), text: (t: string) => `"${t}" is due tomorrow.` },
    { off: 0, title: zz("r today"), text: (t: string) => `"${t}" is due today.` },
    { off: -1, title: zz("r late 1"), text: (t: string) => `"${t}" is overdue by 1 day.` },
    { off: -8, title: zz("r late 8"), text: (t: string) => `"${t}" is overdue by 8 days.` },
    { off: -15, title: zz("r late 15"), text: (t: string) => `"${t}" is overdue by 15 days.` },
    { off: -22, title: zz("r late 22"), text: (t: string) => `"${t}" is overdue by 22 days.` },
    { off: -2, title: zz("r late 2"), text: null },
    { off: -29, title: zz("r late 29"), text: null },
  ];
  for (const row of cases) {
    await newTask(admin, project.id, { title: row.title, assigneeId: holder.user.id, dueDate: ymd(row.off) });
  }
  await runLocalJob("reminders");
  const texts = await notices(holder);
  expect(JSON.stringify(texts).includes(QA_PASS)).toBe(false);
  for (const row of cases) {
    const hits = about(texts, row.title);
    expect(hits, row.title).toEqual(row.text ? [row.text(row.title)] : []);
  }
});

test("AC5: while a task awaits approval the approver gets the reminder and the previous assignee does not", async ({ browser, later }) => {
  test.setTimeout(120_000);
  const { admin, people: [holder, approver] } = await cast(browser, later, ["sender", "approver"]);
  const project = await newProject(admin, later, { label: "us74 approval", members: [{ who: holder, role: "EDITOR" }, { who: approver, role: "EDITOR" }] });
  const title = zz("awaiting");
  const id = await newTask(admin, project.id, { title, assigneeId: holder.user.id, dueDate: ymd(1) });
  expect((await admin.api.put(`/api/tasks/${id}/approver`, { approverId: approver.user.id })).status).toBe(200);
  expect((await holder.api.post(`/api/tasks/${id}/send-for-approval`, {})).status).toBe(200);
  const task = (await admin.api.get(`/api/tasks/${id}`)).json.task as { assignee: { id: string } };
  expect(task.assignee.id).toBe(approver.user.id);
  await runLocalJob("reminders");
  expect(about(await notices(approver), title)).toEqual([`"${title}" is due tomorrow.`]);
  expect(about(await notices(holder), title)).toHaveLength(0);
});

test("AC6: a blocked task sends no reminder, and the next run after the flag is removed does", async ({ browser, later }) => {
  test.setTimeout(120_000);
  const { admin, people: [holder] } = await cast(browser, later, ["blocked"]);
  const project = await newProject(admin, later, { label: "us74 blocked", members: [{ who: holder, role: "EDITOR" }] });
  const title = zz("blocked due");
  const id = await newTask(admin, project.id, { title, assigneeId: holder.user.id, dueDate: ymd(1) });
  expect((await admin.api.patch(`/api/tasks/${id}`, { blocked: true, blockedReason: "ZZ-TEST wait" })).status).toBe(200);
  await runLocalJob("reminders");
  expect(about(await notices(holder), title)).toHaveLength(0);
  expect((await admin.api.patch(`/api/tasks/${id}`, { blocked: false })).status).toBe(200);
  await runLocalJob("reminders");
  expect(about(await notices(holder), title)).toEqual([`"${title}" is due tomorrow.`]);
});
