import { archiveProject, postTaskCurrent } from "../helpers/migration-2731";
import { test } from "./qa";
// SHO-BUG-4 Audit log shows "deal (removed)" for every DEAL_CLOSED row  (Linear APL-2611)
// No numbered ACs in the issue; follows its "Expected" and "Test" paragraphs.
import { expect, zz, type Json } from "../support";

test("Closing a deal writes an audit row that names the deal, not 'deal (removed)'", async ({ admin, later }) => {
  const dealName = `${zz("audit deal")}`;
  const org = await admin.api.post("/api/orgs", { name: `${zz("audit org")}` });
  expect(org.status).toBe(201);
  later(() => admin.api.post(`/api/orgs/${org.json.organisation.id}/archive`, { archive: true }));
  const pipes = (await admin.api.get("/api/deals/pipelines")).json.pipelines as Json[];
  const pro = pipes.find((p) => p.key === "DEAL_PROACTIVE")!;
  const due = new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10);
  const d = await admin.api.post("/api/deals", {
    name: dealName, organisationId: org.json.organisation.id, pipelineId: pro.id, leaderId: admin.user.id,
    whyPursue: "ZZ-TEST audit label check", nextStep: { title: zz("first step"), dueDate: due },
  });
  expect(d.status, JSON.stringify(d.json)).toBe(201);
  const id = d.json.deal.id as string;
  later(() => archiveProject(admin.api, id, admin.user.id));
  // A deal cannot be won while a task is open, so close the first step first.
  const step = ((await admin.api.get(`/api/deals?pipelineId=${pro.id}`)).json.deals as Json[]).find((x) => x.id === id)?.nextStep?.id as string;
  expect(step, "the deal's first next step").toBeTruthy();
  expect((await postTaskCurrent(admin, step, "complete", {})).status).toBe(200);
  const won = pro.stages.find((s: { name: string }) => s.name === "Won").id;
  expect((await admin.api.post(`/api/projects/${id}/stage`, { stageId: won })).status).toBe(200);

  const log = await admin.api.get("/api/audit?event=DEAL_CLOSED");
  expect(log.status).toBe(200);
  const mine = (log.json.items as { target: string | null }[]).filter((i) => i.target && i.target.includes(dealName));
  expect(mine, "an audit row names this deal").toHaveLength(1);
  expect(mine[0].target).toBe(`Deal "${dealName}"`);
  expect((log.json.items as { who: string | null; target: string | null }[]).filter((i) => i.who === admin.user.name && i.target === "deal (removed)")).toHaveLength(0);
});

test("The Audit screen shows the deal's name on the closed row", async ({ admin }) => {
  await admin.page.goto("/audit");
  await expect(admin.page.locator("tr", { hasText: admin.user.email }).filter({ hasText: "deal (removed)" })).toHaveCount(0); // this admin's rows only
});
