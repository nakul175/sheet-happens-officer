// SHO-US-12.7 Stalled deals (APL-2543).
// A deal is stalled only when its last activity is more than 30 days ago. Creating or editing a deal
// through the API stamps that activity as now, and a browser session cannot rewrite those timestamps
// (tests/crm5.test.ts does it with SQL). The stalled-deals job also needs JOB_SECRET, which a signed-in
// session does not have, and running it here would notify real Leaders on staging.
// AC4 and AC6 are the parts a session can see. The rest stay skipped: a 30-day history, or the stalled-deals cron.
import { test, expect, zz } from "../support";
import { storyGate } from "../helpers/qa-alias";
import { ageDeal, ageNotification, runLocalJob } from "../helpers/own-row";
import { ymd, type Who } from "../g2";

storyGate({ admin: true });

type Later = (fn: () => Promise<unknown>) => void;

async function makeDeal(admin: Who, later: Later, label: string) {
  const org = await admin.api.post("/api/orgs", { name: zz(`org ${label}`) });
  expect(org.status, JSON.stringify(org.json)).toBe(201);
  const orgId = org.json.organisation.id as string;
  later(() => admin.api.post(`/api/orgs/${orgId}/archive`, { archive: true }));
  const pipes = (await admin.api.get("/api/deals/pipelines")).json.pipelines as { id: string; key: string }[];
  const pro = pipes.find((p) => p.key === "DEAL_PROACTIVE")!;
  const name = zz(`deal ${label}`);
  const d = await admin.api.post("/api/deals", {
    name, organisationId: orgId, pipelineId: pro.id, leaderId: admin.user.id, whyPursue: "ZZ-TEST fit",
    nextStep: { title: zz(`step ${label}`), dueDate: ymd(4) },
  });
  expect(d.status, JSON.stringify(d.json)).toBe(201);
  const id = d.json.deal.id as string;
  later(() => admin.api.post(`/api/projects/${id}/archive`));
  return { id, name };
}

const stalledOf = async (admin: Who, id: string) =>
  ((await admin.api.get("/api/deals")).json.deals as { id: string; stalled: boolean }[]).find((d) => d.id === id)?.stalled;

test("AC1: Stalled shows on the card, the list and the deal page, and any logged change counts as activity", async ({ admin, later }) => {
  test.setTimeout(180_000);
  const d = await makeDeal(admin, later, "stalled card");
  expect(await stalledOf(admin, d.id)).toBe(false);
  ageDeal(d.id, 31);
  expect(await stalledOf(admin, d.id)).toBe(true);
  expect((await admin.api.get(`/api/projects/${d.id}`)).json.project.deal.stalled).toBe(true);
  await admin.page.goto("/deals");
  await expect(admin.page.locator(".dcard", { hasText: d.name }).getByText("Stalled", { exact: true })).toBeVisible();
  await admin.page.goto("/review");
  await expect(admin.page.getByRole("region", { name: "Stalled for 30 days" }).getByText(d.name)).toBeVisible();
  await admin.page.goto(`/projects/${d.id}`);
  await expect(admin.page.getByText("Stalled · no activity for 30 days")).toBeVisible();
  expect((await admin.api.post(`/api/projects/${d.id}/tasks`, { title: zz("logged change") })).status).toBe(201);
  expect(await stalledOf(admin, d.id), "a logged change is activity, so the flag clears").toBe(false);
});

test("AC2: any later activity clears the Stalled flag", async ({ admin, later }) => {
  test.setTimeout(120_000);
  const d = await makeDeal(admin, later, "stalled clear");
  const pipes = (await admin.api.get("/api/deals/pipelines")).json.pipelines as { key: string; stages: { id: string; name: string }[] }[];
  const conversation = pipes.find((p) => p.key === "DEAL_PROACTIVE")!.stages.find((s) => s.name === "Conversation")!;
  ageDeal(d.id, 31);
  expect(await stalledOf(admin, d.id)).toBe(true);
  expect((await admin.api.post(`/api/projects/${d.id}/stage`, { stageId: conversation.id })).status).toBe(200);
  expect(await stalledOf(admin, d.id)).toBe(false);
  expect(((await admin.api.get("/api/review")).json.stalled as { id: string }[]).some((row) => row.id === d.id)).toBe(false);
});

test("AC3: one in-app notice per stall, and a new one only after new activity and 30 more quiet days", async ({ admin, later }) => {
  test.setTimeout(120_000);
  const d = await makeDeal(admin, later, "stalled notice");
  ageDeal(d.id, 31);
  const notes = async () => ((await admin.api.get("/api/notifications?limit=200")).json.items ?? []) as { id: string; text: string; href: string }[];
  const stalledNotes = async () => (await notes()).filter((n) => n.href.includes(d.id) && /no activity for 30 days/.test(n.text));
  await runLocalJob("stalled-deals");
  const first = await stalledNotes();
  expect(first).toHaveLength(1);
  await runLocalJob("stalled-deals");
  expect(await stalledNotes()).toHaveLength(1);
  expect((await admin.api.post(`/api/projects/${d.id}/tasks`, { title: zz("new activity") })).status).toBe(201);
  ageDeal(d.id, 31);
  ageNotification(first[0].id, admin.user.id as string, 80);
  await runLocalJob("stalled-deals");
  expect(await stalledNotes()).toHaveLength(2);
});

test("AC4: 30 days is a fixed part of the product, not a setting on the deal", async ({ admin, later }) => {
  await admin.page.goto("/review");
  await expect(admin.page.getByRole("region", { name: "Stalled for 30 days" })).toBeVisible();
  await expect(admin.page.getByText("Stalled for 30 days").first()).toBeVisible();

  const jobs = (await admin.api.get("/api/jobs")).json.jobs as { job: string; about: string }[];
  const stalled = jobs.find((j) => j.job === "stalled-deals");
  expect(stalled?.about).toMatch(/30 days/);
  expect(stalled?.about).toMatch(/7:50/);

  const d = await makeDeal(admin, later, "fixed");
  const row = ((await admin.api.get("/api/deals")).json.deals as { id: string; stalled: boolean }[]).find((x) => x.id === d.id)!;
  expect(row.stalled, "a deal touched today is not stalled").toBe(false);
  expect("stallDays" in row, "the deal has no stall-days setting to change").toBe(false);
  const block = (await admin.api.get(`/api/projects/${d.id}`)).json.project.deal as { stalled: boolean };
  expect(block.stalled).toBe(false);
  expect("stallDays" in block).toBe(false);
});

test("AC5: archived, Paused, Done and Lost deals are never flagged", async ({ admin, later }) => {
  test.setTimeout(180_000);
  const pipes = (await admin.api.get("/api/deals/pipelines")).json.pipelines as { key: string; stages: { id: string; name: string }[] }[];
  const stages = pipes.find((p) => p.key === "DEAL_PROACTIVE")!.stages;
  const stage = (name: string) => stages.find((s) => s.name === name)!;
  const hold = await makeDeal(admin, later, "never hold");
  const won = await makeDeal(admin, later, "never won");
  const lost = await makeDeal(admin, later, "never lost");
  const archived = await makeDeal(admin, later, "never archived");
  expect((await admin.api.post(`/api/projects/${hold.id}/stage`, { stageId: stage("On hold").id, reason: "ZZ-TEST pause" })).status).toBe(200);
  for (const deal of [won, lost]) {
    const step = (await admin.api.get(`/api/projects/${deal.id}`)).json.project.deal.nextStep.id as string;
    expect((await admin.api.post(`/api/tasks/${step}/complete`, {})).status).toBe(200);
  }
  expect((await admin.api.post(`/api/projects/${won.id}/stage`, { stageId: stage("Won").id })).status).toBe(200);
  expect((await admin.api.post(`/api/projects/${lost.id}/stage`, { stageId: stage("Lost").id, reason: "ZZ-TEST lost" })).status).toBe(200);
  expect((await admin.api.post(`/api/projects/${archived.id}/archive`)).status).toBeLessThan(300);
  for (const deal of [hold, won, lost, archived]) ageDeal(deal.id, 45);
  const before = ((await admin.api.get("/api/notifications?limit=200")).json.items as { href: string; text: string }[])
    .filter((n) => /no activity for 30 days/.test(n.text)).length;
  await runLocalJob("stalled-deals");
  const live = (await admin.api.get("/api/deals")).json.deals as { id: string; stalled: boolean }[];
  for (const deal of [hold, won, lost]) expect(live.find((row) => row.id === deal.id)?.stalled).toBe(false);
  const old = (await admin.api.get(`/api/deals?archived=true`)).json.deals as { id: string; stalled: boolean }[];
  expect(old.find((row) => row.id === archived.id)?.stalled).toBe(false);
  const after = ((await admin.api.get("/api/notifications?limit=200")).json.items as { href: string; text: string }[])
    .filter((n) => /no activity for 30 days/.test(n.text) && [hold, won, lost, archived].some((d) => n.href.includes(d.id)));
  expect(after).toEqual([]);
  expect(before).toBeGreaterThanOrEqual(0);
});

test("AC6: stalled-deals is on the job list the daily check reads, with the same fields as the other jobs", async ({ admin }) => {
  const jobs = (await admin.api.get("/api/jobs")).json.jobs as { job: string; about: string; lastStartedAt: string | null; lastFinishedAt: string | null; lastStatus: string | null; lastError: string | null }[];
  const stalled = jobs.find((j) => j.job === "stalled-deals");
  expect(stalled, "the job the checker walks").toBeTruthy();
  expect(jobs.map((j) => j.job)).toEqual(expect.arrayContaining(["reminders", "check", "stalled-deals"]));
  for (const key of ["about", "lastStartedAt", "lastFinishedAt", "lastStatus", "lastError"] as const) expect(stalled).toHaveProperty(key);
  // Not visible to a signed-in session, so not asserted here:
  // the cloud-init line "50 7 * * * … stalled-deals", the release-script marker "# crm-stalled",
  // a missed-run notice (that is the check job, and running it would notify Super Admins),
  // and the job returning early when CRM_VISIBLE=off (that switch is server config).
});
