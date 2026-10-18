// SHO-US-12.7 Stalled deals (APL-2543).
// A deal is stalled only when its last activity is more than 30 days ago. Creating or editing a deal
// through the API stamps that activity as now, and a browser session cannot rewrite those timestamps
// (tests/crm5.test.ts does it with SQL). The stalled-deals job also needs JOB_SECRET, which a signed-in
// session does not have, and running it here would notify real Leaders on staging.
// AC4 and AC6 are the parts a session can see. The rest stay skipped: a 30-day history, or the stalled-deals cron.
import { test, expect, zz } from "../support";
import { ymd, type Who } from "../g2";
import { why } from "../helpers/jim-http";

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

test.skip("AC1: Stalled shows on the card, the list and the deal page, and any logged change counts as activity", why(
  "Needs a deal whose last activity is more than 30 days old. A session cannot move createdAt, stageChangedAt, task updatedAt or the action log backwards (30-day history). Covered by tests/crm5.test.ts.",
), () => {});

test.skip("AC2: any later activity clears the Stalled flag", why(
  "Clearing the flag needs a deal that is already stalled. A session cannot age one (30-day history). Covered by tests/crm5.test.ts.",
), () => {});

test.skip("AC3: one in-app notice per stall, and a new one only after new activity and 30 more quiet days", why(
  "The notice is sent by the stalled-deals cron. That route needs JOB_SECRET and a deal quiet for 30 days, and running it on staging would notify real Leaders. Covered by tests/crm5.test.ts.",
), () => {});

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

test.skip("AC5: archived, Paused, Done and Lost deals are never flagged", why(
  "Proving those stages are never stalled needs 30 quiet days. A new deal in those stages is also not stalled, so a session cannot show the stage rule (30-day history). Covered by tests/crm5.test.ts.",
), () => {});

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
