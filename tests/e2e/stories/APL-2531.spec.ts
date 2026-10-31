import { test } from "../helpers/2642-fixtures";
// SHO-US-10.5 One view engine for lists, boards and groupings (APL-2531).
// One test per acceptance criterion. ZZ-TEST deals, projects and organisations are archived afterwards.
// The Super Admin is the Admin (the same rule covers an Admin and the Super Admin). The plain Member is the person
// who is not on the admin's deal. workers is 1 in playwright.config.ts. Traces stay off.
import { expect, zz } from "../support";
import { archiveProject, newProject, newTask, ymd, type Who } from "../helpers/migration-2731";

type Later = (fn: () => Promise<unknown>) => void;
type Stage = { id: string; name: string; category: string; isRetired?: boolean };
type Pipe = { id: string; key: string; name: string; stages: Stage[] };

const CRM_OFF = "CRM routes answer not found on this server (CRM_VISIBLE is off).";
const CRM_MEMBER = "CRM is hidden from this Member (CRM_VISIBLE is admins or off).";
const board = (who: Who) => who.page.getByRole("region", { name: "Unclassified sales board", exact: true });
const column = (who: Who, name: string) => board(who).getByRole("region", { name: `Unclassified sales board · ${name}`, exact: true });
async function crmPipes(who: Who, hidden: string) {
  const r = await who.api.get("/api/deals/pipelines");
  if (r.status === 404) throw new Error(hidden);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.pipelines as Pipe[];
}

async function makeDeal(who: Who, later: Later, o: { label: string; leaderId?: string; pipelineKey?: string; cleanup?: Who }) {
  const pro = (await crmPipes(who, CRM_OFF)).find((p) => p.key === (o.pipelineKey ?? "DEAL_PROACTIVE"));
  if (!pro) throw new Error("Proactive pipeline is missing");
  const org = await who.api.post("/api/orgs", { name: zz(`org ${o.label}`) });
  expect(org.status, JSON.stringify(org.json)).toBe(201);
  const orgId = org.json.organisation.id as string;
  later(() => who.api.post(`/api/orgs/${orgId}/archive`, { archive: true }));
  const name = zz(`deal ${o.label}`);
  const step = zz(`step ${o.label}`);
  const d = await who.api.post("/api/deals", {
    name, organisationId: orgId, pipelineId: pro.id, leaderId: o.leaderId ?? who.user.id, whyPursue: "ZZ-TEST fit",
    nextStep: { title: step, dueDate: ymd(6) },
    ...(pro.key === "DEAL_BID" ? { submissionDeadline: ymd(7) } : {}),
  });
  expect(d.status, JSON.stringify(d.json)).toBe(201);
  const id = d.json.deal.id as string;
  const cleanup = o.cleanup ?? who;
  later(() => archiveProject(cleanup.api, id, cleanup.user.id));
  return { id, name, step, orgId, pro };
}

const dealIds = async (who: Who, pipeId: string, extra = "") =>
  ((await who.api.get(`/api/deals?pipelineId=${pipeId}${extra}`)).json.deals as { id: string }[]).map((d) => d.id);

test("AC1: a deal list shows a deal to its members and to an Admin, and hides it from everyone else", async ({ admin, member, later }) => {
  test.setTimeout(180_000);
  await crmPipes(admin, CRM_OFF);
  await crmPipes(member, CRM_MEMBER);
  const hidden = await makeDeal(admin, later, { label: "2531 hidden" });
  const owned = await makeDeal(member, later, { label: "2531 owned", leaderId: member.user.id, cleanup: admin });

  expect(await dealIds(member, hidden.pro.id), "a non-member does not see the Admin's deal").not.toContain(hidden.id);
  expect(await dealIds(admin, hidden.pro.id)).toContain(hidden.id);
  expect(await dealIds(admin, owned.pro.id), "the Admin sees a deal they were not added to").toContain(owned.id);
  expect(await dealIds(member, owned.pro.id)).toContain(owned.id);

  const memberOrg = (await member.api.get(`/api/orgs/${hidden.orgId}`)).json.organisation.deals as { projectId: string }[];
  const adminOrg = (await admin.api.get(`/api/orgs/${hidden.orgId}`)).json.organisation.deals as { projectId: string }[];
  expect(memberOrg.some((d) => d.projectId === hidden.id)).toBe(false);
  expect(adminOrg.some((d) => d.projectId === hidden.id)).toBe(true);

  await member.page.goto("/deals");
  await expect(column(member, "Lead")).toBeVisible();
  await expect(member.page.getByText(hidden.name)).toHaveCount(0);
  await admin.page.goto("/deals");
  await expect(admin.page.locator(".dcard", { hasText: hidden.name })).toBeVisible();
  await expect(admin.page.locator(".dcard", { hasText: owned.name })).toBeVisible();

  await member.page.goto(`/accounts/${hidden.orgId}`);
  await expect(member.page.getByText("No deals you can see yet.")).toBeVisible();
  await expect(member.page.getByRole("link", { name: hidden.name })).toHaveCount(0);
  await admin.page.goto(`/accounts/${hidden.orgId}`);
  await expect(admin.page.getByRole("link", { name: hidden.name })).toBeVisible();

  expect((await admin.api.post(`/api/projects/${hidden.id}/members`, { userId: member.user.id, role: "VIEWER" })).status).toBe(201);
  expect(await dealIds(member, hidden.pro.id)).toContain(hidden.id);
  await member.page.goto("/deals");
  await expect(member.page.locator(".dcard", { hasText: hidden.name })).toBeVisible();
  await member.page.goto(`/accounts/${hidden.orgId}`);
  await expect(member.page.getByRole("link", { name: hidden.name })).toBeVisible();
});

test("AC2: each available sales stage has its own board column, including separate outcome stages", async ({ admin, later }) => {
  test.setTimeout(120_000);
  const pipes = await crmPipes(admin, CRM_OFF);
  const pro = pipes.find((p) => p.key === "DEAL_PROACTIVE")!;
  const bid = pipes.find((p) => p.key === "DEAL_BID")!;
  // SHO-3133 approved separate outcome columns; current pipeline stage names come from the server.
  const salesStages = (p: Pipe) => p.stages.filter(s => !s.isRetired && s.category !== "DELIVERY");
  const proactive = salesStages(pro).map(s => s.name);
  const bidTitles = salesStages(bid).map(s => s.name);
  expect(proactive.length).toBeGreaterThan(0);
  expect(bidTitles.length).toBeGreaterThan(0);
  const bidDeal = await makeDeal(admin, later, { label: "2531 bid columns", pipelineKey: "DEAL_BID" });
  const deal = await makeDeal(admin, later, { label: "2531 columns" });
  await admin.page.setViewportSize({ width: 1400, height: 900 });
  await admin.page.goto("/deals");
  await expect(board(admin).locator(".dcol header b")).toHaveText(proactive);
  await expect(column(admin, proactive[0]).locator(".dcard", { hasText: deal.name })).toBeVisible();
  for (const stage of salesStages(pro).filter(s => ["PAUSED", "DONE", "LOST"].includes(s.category)))
    await expect(column(admin, stage.name).locator(".dcard", { hasText: deal.name })).toHaveCount(0);

  await admin.page.getByRole("tab", { name: "Bid" }).click();
  await expect(board(admin).locator(".dcol header b")).toHaveText(bidTitles);
  await expect(column(admin, "Lead")).toHaveCount(0);
  await expect(column(admin, bidTitles[0]).locator(".dcard", { hasText: bidDeal.name })).toBeVisible();
  await expect(admin.page.getByText(deal.name)).toHaveCount(0);
});

test("AC3: Home, Organisation, Deal and Pipeline screens each open their list or board", async ({ admin, later }) => {
  // NJ removed the single shared component on 18 Oct 2026 (the shared view is APL-2642). Each screen still opens.
  test.setTimeout(180_000);
  const pipes = await crmPipes(admin, CRM_OFF);
  const bid = pipes.find(p => p.key === "DEAL_BID")!;
  const bidDeal = await makeDeal(admin, later, { label: "2531 screens bid", pipelineKey: "DEAL_BID" });
  const deal = await makeDeal(admin, later, { label: "2531 screens" });
  await admin.page.setViewportSize({ width: 1400, height: 900 });

  await admin.page.goto("/");
  await expect(admin.page.getByRole("heading", { name: "Your workspace", exact: true })).toBeVisible();

  await admin.page.goto(`/accounts/${deal.orgId}`);
  await expect(admin.page.getByRole("link", { name: deal.name })).toBeVisible();

  await admin.page.goto(`/projects/${deal.id}`);
  await expect(admin.page.getByText(deal.step).first()).toBeVisible();

  await admin.page.goto("/deals");
  await expect(column(admin, "Lead")).toBeVisible();
  await expect(admin.page.locator(".dcard", { hasText: deal.name })).toBeVisible();
  await admin.page.getByRole("tab", { name: "Bid" }).click();
  await expect(column(admin, bid.stages.find(s => !s.isRetired && s.category !== "DELIVERY")!.name).locator(".dcard", { hasText: bidDeal.name })).toBeVisible();
});

test("AC4: archiving leaves a deal off the live list, and Trash still only holds deleted tasks", async ({ admin, later }) => {
  test.setTimeout(180_000);
  await crmPipes(admin, CRM_OFF);
  const deal = await makeDeal(admin, later, { label: "2531 trash" });
  const trashedTitle = zz("trashed task");
  const trashed = await newTask(admin, deal.id, { title: trashedTitle });
  const plain = await newProject(admin, later, { label: "2531 plain trash" });
  const plainTitle = zz("plain trashed");
  const plainTask = await newTask(admin, plain.id, { title: plainTitle });

  await admin.page.goto("/deals");
  await expect(admin.page.locator(".dcard", { hasText: deal.name })).toBeVisible();
  expect((await admin.api.del(`/api/tasks/${trashed}`)).status).toBe(204);
  expect(await dealIds(admin, deal.pro.id), "trashing a task does not archive the deal").toContain(deal.id);
  await admin.page.reload();
  await expect(admin.page.locator(".dcard", { hasText: deal.name })).toBeVisible();

  const trashOf = async (id: string) => ((await admin.api.get(`/api/projects/${id}/trash`)).json.items as { title: string }[]).map((i) => i.title);
  expect(await trashOf(deal.id)).toContain(trashedTitle);
  expect(await trashOf(deal.id)).not.toContain(deal.step);
  await admin.page.goto(`/projects/${deal.id}/trash`);
  await expect(admin.page.getByRole("cell", { name: trashedTitle })).toBeVisible();
  await expect(admin.page.getByText(deal.step)).toHaveCount(0);

  expect((await admin.api.del(`/api/tasks/${plainTask}`)).status).toBe(204);
  expect(await trashOf(plain.id)).toEqual([plainTitle]);
  const projects = (await admin.api.get("/api/projects")).json.projects as { id: string }[];
  expect(projects.some((p) => p.id === plain.id), "trashing a task does not archive the project").toBe(true);
  await admin.page.goto(`/projects/${plain.id}/trash`);
  await expect(admin.page.getByRole("cell", { name: plainTitle })).toBeVisible();

  expect((await admin.api.post(`/api/projects/${deal.id}/archive`)).status).toBeLessThan(300);
  expect(await dealIds(admin, deal.pro.id)).not.toContain(deal.id);
  expect(await dealIds(admin, deal.pro.id, "&archived=true")).toContain(deal.id);
  expect(await trashOf(deal.id), "archiving does not move the remaining task into Trash").toEqual([trashedTitle]);
  await admin.page.goto("/deals");
  await expect(admin.page.locator(".dcard", { hasText: deal.name })).toHaveCount(0);
  await admin.page.goto(`/projects/${deal.id}/trash`);
  await expect(admin.page.getByRole("cell", { name: trashedTitle })).toBeVisible();
  await expect(admin.page.getByText(deal.step)).toHaveCount(0);
});
