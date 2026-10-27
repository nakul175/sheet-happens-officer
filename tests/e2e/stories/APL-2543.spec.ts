// SHO-US-12.7 Stalled deals (APL-2543).
// Pam left no qa:TC id. Each title says qa:TC missing. The annotation is qa:TC with description missing. An AC number is not a TC id.
// A deal is stalled only when its last activity is more than 30 days ago. Every activity time is stamped by the
// server, no API can backdate it, and this suite writes nothing to the database. So the 30-quiet-days halves of
// AC1, AC2, AC3 and AC5 run in tests/stall-clock-2709.test.ts: ZZ-TEST deals made through the API, with Date faked
// in that process only. A server-side clock hook for these screens is APL-2757.
import { test, expect, zz } from "../support";
import { gateFile } from "../helpers/qa-alias";
import { rowFromLink, stageColumn } from "../helpers/locate";
import { ymd, type Who } from "../g2";

gateFile();

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

// qa:TC missing
test("AC1 (screen): a deal with activity today carries no Stalled mark on the card, the review or the deal page qa:TC missing", async ({ admin, later }) => {
  test.setTimeout(180_000);
  const d = await makeDeal(admin, later, "stalled card");
  expect(await stalledOf(admin, d.id)).toBe(false);
  expect((await admin.api.get(`/api/projects/${d.id}`)).json.project.deal.stalled).toBe(false);
  await admin.page.goto("/deals");
  const card = rowFromLink(stageColumn(admin.page, "Lead").getByRole("link", { name: d.name, exact: true }));
  await expect(card).toBeVisible();
  await expect(card.getByText("Stalled", { exact: true })).toHaveCount(0);
  await admin.page.goto("/review");
  const stalledRegion = admin.page.getByRole("region", { name: "Stalled for 30 days" });
  await expect(stalledRegion).toBeVisible();
  await expect(stalledRegion.getByText(d.name)).toHaveCount(0);
  await admin.page.goto(`/projects/${d.id}`);
  await expect(admin.page.getByRole("heading", { name: d.name })).toBeVisible();
  await expect(admin.page.getByText("Stalled · no activity for 30 days")).toHaveCount(0);
});
// AC2 (later activity clears the flag) and AC3 (one notice per stall) need a deal 30 days quiet.
// They run in tests/stall-clock-2709.test.ts on an in-process clock.

// qa:TC missing
test("AC4: 30 days is a fixed part of the product, not a setting on the deal qa:TC missing", async ({ admin, later }) => {
  await admin.page.goto("/review");
  await expect(admin.page.getByRole("region", { name: "Stalled for 30 days" })).toBeVisible();

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
// AC5 (archived, Paused, Done and Lost are never flagged) needs 30 quiet days to mean anything.
// It runs in tests/stall-clock-2709.test.ts with a working control deal that is flagged at the same moment.

// qa:TC missing
test("AC6: stalled-deals is on the job list the daily check reads, with the same fields as the other jobs qa:TC missing", async ({ admin }) => {
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
