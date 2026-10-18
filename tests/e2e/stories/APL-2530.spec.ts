// SHO-US-10.4 Projects list hides Deals; Deals has its own place (APL-2530).
// One test per acceptance criterion. ZZ-TEST projects, deals and organisations are archived afterwards.
// The Super Admin is the Admin. The plain Member creates the project in AC4 and moves the stage in AC3.
// workers is 1 in playwright.config.ts. Traces stay off.
import { expect, zz, RUN } from "../support";
import { test } from "../helpers/story-people";
import { storyGate } from "../helpers/qa-alias";
import { newProject, ymd, type Who } from "../g2";

storyGate({ admin: true });

type Later = (fn: () => Promise<unknown>) => void;
type Pipe = { id: string; key: string; stages: { id: string; name: string }[] };

const CRM_OFF = "CRM routes answer not found on this server (CRM_VISIBLE is off).";
const CRM_MEMBER = "CRM is hidden from this Member (CRM_VISIBLE is admins or off).";

async function crmOn(who: Who, hidden: string) {
  const r = await who.api.get("/api/deals/pipelines");
  expect(r.status, hidden + " " + JSON.stringify(r.json)).toBe(200);
  return r.json.pipelines as Pipe[];
}

async function makeDeal(who: Who, later: Later, o: { label: string; leaderId?: string; name?: string }) {
  const pro = (await crmOn(who, CRM_OFF)).find((p) => p.key === "DEAL_PROACTIVE");
  if (!pro) throw new Error("Proactive pipeline is missing");
  const org = await who.api.post("/api/orgs", { name: zz(`org ${o.label}`) });
  expect(org.status, JSON.stringify(org.json)).toBe(201);
  const orgId = org.json.organisation.id as string;
  later(() => who.api.post(`/api/orgs/${orgId}/archive`, { archive: true }));
  const name = o.name ?? zz(`deal ${o.label}`);
  const d = await who.api.post("/api/deals", {
    name, organisationId: orgId, pipelineId: pro.id, leaderId: o.leaderId ?? who.user.id, whyPursue: "ZZ-TEST fit",
    nextStep: { title: zz(`step ${o.label}`), dueDate: ymd(6) },
  });
  expect(d.status, JSON.stringify(d.json)).toBe(201);
  const id = d.json.deal.id as string;
  later(() => who.api.post(`/api/projects/${id}/archive`));
  return { id, name, pro };
}

test("AC1: the Projects list is type Project only, and Deals opens the pipeline board", async ({ admin, later }) => {
  test.setTimeout(120_000);
  await crmOn(admin, CRM_OFF);
  const project = await newProject(admin, later, { label: "2530 project" });
  const deal = await makeDeal(admin, later, { label: "2530 deal" });
  const projects = (await admin.api.get("/api/projects")).json.projects as { id: string }[];
  expect(projects.some((p) => p.id === project.id)).toBe(true);
  expect(projects.some((p) => p.id === deal.id)).toBe(false);
  expect((await admin.api.get(`/api/projects/${project.id}`)).json.project.type).toBe("PROJECT");
  expect((await admin.api.get(`/api/projects/${deal.id}`)).json.project.type).toBe("DEAL");
  const deals = (await admin.api.get(`/api/deals?pipelineId=${deal.pro.id}`)).json.deals as { id: string }[];
  expect(deals.some((d) => d.id === deal.id)).toBe(true);
  expect(deals.some((d) => d.id === project.id)).toBe(false);

  await admin.page.goto("/projects");
  await expect(admin.page.getByRole("heading", { level: 2, name: project.name })).toBeVisible();
  await expect(admin.page.getByRole("heading", { level: 2, name: deal.name })).toHaveCount(0);
  await admin.page.locator("nav").getByRole("link", { name: "Deals" }).click();
  await expect(admin.page).toHaveURL(/\/deals\/?$/);
  await expect(admin.page.getByRole("region", { name: "Lead" })).toBeVisible();
  await expect(admin.page.locator(".dcol header b").first()).toHaveText("Lead");
  await expect(admin.page.locator(".dcard", { hasText: deal.name })).toBeVisible();
  await expect(admin.page.locator(".dcard", { hasText: project.name })).toHaveCount(0);
});

test("AC2: search finds a project and a deal, and the Search screen shows no type mark on the deal", async ({ admin, later }) => {
  test.setTimeout(120_000);
  await crmOn(admin, CRM_OFF);
  const token = `ZZ-TEST ${RUN} pair`;
  const projectName = `${token} project`;
  const dealName = `${token} deal`;
  const created = await admin.api.post("/api/projects", { name: projectName, leaderId: admin.user.id });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const projectId = created.json.project.id as string;
  later(() => admin.api.post(`/api/projects/${projectId}/archive`));
  const deal = await makeDeal(admin, later, { label: "2530 search", name: dealName });

  const found = await admin.api.get(`/api/search?q=${encodeURIComponent(token)}`);
  expect(found.status).toBe(200);
  const rows = found.json.projects as { id: string; type: string }[];
  expect(rows.find((p) => p.id === projectId)?.type).toBe("PROJECT");
  expect(rows.find((p) => p.id === deal.id)?.type).toBe("DEAL");

  await admin.page.goto("/search");
  await expect(admin.page.getByRole("checkbox", { name: "Ideas only" })).toBeVisible();
  await admin.page.getByLabel("Search").fill(token);
  const projectRow = admin.page.locator("a.item", { hasText: projectName });
  const dealRow = admin.page.locator("a.item", { hasText: dealName });
  await expect(projectRow).toBeVisible();
  await expect(dealRow).toBeVisible();
  await expect(admin.page.locator(".grp", { hasText: /^Projects$/ })).toBeVisible();
  await expect(admin.page.locator(".grp", { hasText: /^Deals$/ })).toHaveCount(0);
  await expect(dealRow.locator(".chip")).toHaveCount(0);
  await expect(dealRow).toHaveText(dealName);
});

test("AC3: a deal link and a notification open the deal page, and the breadcrumb says Deals", async ({ admin, member, later }) => {
  test.setTimeout(180_000);
  await crmOn(admin, CRM_OFF);
  await crmOn(member, CRM_MEMBER);
  const deal = await makeDeal(admin, later, { label: "2530 open" });
  expect((await admin.api.post(`/api/projects/${deal.id}/members`, { userId: member.user.id, role: "EDITOR" })).status).toBe(201);
  const conversation = deal.pro.stages.find((s) => s.name === "Conversation")!;
  expect((await member.api.post(`/api/projects/${deal.id}/stage`, { stageId: conversation.id })).status).toBe(200);
  const notes = (await admin.api.get("/api/notifications?limit=200")).json.items as { text: string; href: string }[];
  const note = notes.find((n) => n.text.includes(deal.name) && n.text.includes("to Conversation"));
  expect(note, "the Leader's notice points at the deal").toBeTruthy();
  expect(note!.href).toBe(`/projects/${deal.id}`);

  await admin.page.goto("/deals");
  await admin.page.locator(".dcard", { hasText: deal.name }).getByRole("link", { name: deal.name }).click();
  await expect(admin.page).toHaveURL(new RegExp(`/projects/${deal.id}`));
  await expect(admin.page.locator(".crumb").getByRole("link", { name: "Deals" })).toBeVisible();
  await expect(admin.page.getByRole("group", { name: "Stage" })).toBeVisible();
  await expect(admin.page.locator(".crumb").getByRole("link", { name: "Projects" })).toHaveCount(0);

  await admin.page.goto("/projects");
  await admin.page.getByRole("button", { name: /Notifications/ }).click();
  await admin.page.getByRole("dialog", { name: "Notifications" }).locator("a", { hasText: deal.name }).filter({ hasText: "to Conversation" }).click();
  await expect(admin.page).toHaveURL(new RegExp(`/projects/${deal.id}`));
  await expect(admin.page.locator(".crumb").getByRole("link", { name: "Deals" })).toBeVisible();
  await expect(admin.page.getByRole("group", { name: "Stage" }).getByRole("button", { name: "Conversation", exact: true })).toHaveAttribute("aria-current", "step");
});

test("AC4: All projects shows type Project, and a deal is reached through Deals", async ({ admin, member, later }) => {
  test.setTimeout(120_000);
  await crmOn(admin, CRM_OFF);
  await crmOn(member, CRM_MEMBER);
  const name = zz("2530 all");
  const created = await member.api.post("/api/projects", { name, leaderId: member.user.id });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const projectId = created.json.project.id as string;
  later(() => admin.api.post(`/api/projects/${projectId}/archive`));
  const deal = await makeDeal(member, later, { label: "2530 all-deal", leaderId: member.user.id });
  const all = (await admin.api.get("/api/projects")).json.projects as { id: string }[];
  expect(all.some((p) => p.id === projectId)).toBe(true);
  expect(all.some((p) => p.id === deal.id)).toBe(false);
  expect((await admin.api.get(`/api/projects/${projectId}`)).json.project.type).toBe("PROJECT");
  expect((await admin.api.get("/api/deals")).json.deals.some((d: { id: string }) => d.id === deal.id)).toBe(true);

  await admin.page.goto("/projects");
  const which = admin.page.getByRole("group", { name: "Which projects" });
  await which.getByRole("button", { name: "Mine" }).click();
  await expect(admin.page.getByRole("heading", { level: 2, name })).toHaveCount(0);
  await which.getByRole("button", { name: "All projects" }).click();
  await expect(admin.page.getByRole("heading", { level: 2, name })).toBeVisible();
  await expect(admin.page.getByRole("heading", { level: 2, name: deal.name })).toHaveCount(0);

  await admin.page.locator("nav").getByRole("link", { name: "Deals" }).click();
  await expect(admin.page.locator(".dcard", { hasText: deal.name })).toBeVisible();
  await expect(admin.page.locator(".dcard", { hasText: name })).toHaveCount(0);
});

test("AC5: Show archived is a read-only table of archived deals, not an Archived group on the board", async ({ admin, later }) => {
  test.setTimeout(120_000);
  await crmOn(admin, CRM_OFF);
  const deal = await makeDeal(admin, later, { label: "2530 archived" });
  await admin.page.goto("/deals");
  await expect(admin.page.locator(".dcard", { hasText: deal.name })).toBeVisible();
  await expect(admin.page.locator(".dboard")).toBeVisible();
  expect((await admin.api.post(`/api/projects/${deal.id}/archive`)).status).toBeLessThan(300);
  await admin.page.reload();
  await expect(admin.page.locator(".dcard", { hasText: deal.name })).toHaveCount(0);
  await expect(admin.page.getByText("Archived (read-only)")).toHaveCount(0);

  await admin.page.getByRole("button", { name: "Show archived" }).click();
  await expect(admin.page.getByRole("button", { name: "Show live" })).toHaveAttribute("aria-pressed", "true");
  await expect(admin.page.locator(".dboard")).toHaveCount(0);
  await expect(admin.page.getByText("Archived (read-only)")).toHaveCount(0);
  const row = admin.page.locator("tr", { hasText: deal.name });
  await expect(row).toBeVisible();
  await expect(row.getByRole("link", { name: deal.name })).toBeVisible();
  await expect(admin.page.getByRole("button", { name: `Move ${deal.name}` })).toHaveCount(0);

  await row.getByRole("link", { name: deal.name }).click();
  await expect(admin.page.getByText("This project is archived and read-only.")).toBeVisible();
  const buttons = admin.page.getByRole("group", { name: "Stage" }).getByRole("button");
  await expect(buttons.first()).toBeVisible();
  for (const button of await buttons.all()) await expect(button).toBeDisabled();
  const live = (await admin.api.get(`/api/deals?pipelineId=${deal.pro.id}`)).json.deals as { id: string }[];
  const old = (await admin.api.get(`/api/deals?pipelineId=${deal.pro.id}&archived=true`)).json.deals as { id: string }[];
  expect(live.some((d) => d.id === deal.id)).toBe(false);
  expect(old.some((d) => d.id === deal.id)).toBe(true);
});
