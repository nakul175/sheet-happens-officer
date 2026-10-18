// SHO-US-10.1 Workstream type on every project (APL-2527).
// One test per acceptance criterion. ZZ-TEST projects, deals and organisations are archived afterwards.
// The Super Admin is the Admin. workers is 1 in playwright.config.ts. Traces stay off.
import { readdirSync, readFileSync } from "node:fs";
import { expect, test, zz } from "../support";
import { storyGate } from "../helpers/qa-alias";
import { newProject, ymd, type Who } from "../g2";

storyGate({ admin: true });

type Later = (fn: () => Promise<unknown>) => void;
type Stage = { id: string; name: string; category: string };
type Pipe = { id: string; key: string; name: string; stages: Stage[] };
type Proj = { id: string; name: string };

const CRM_OFF = "CRM routes answer not found on this server (CRM_VISIBLE is off).";

async function crmPipes(who: Who) {
  const r = await who.api.get("/api/deals/pipelines");
  expect(r.status, CRM_OFF + " " + JSON.stringify(r.json)).toBe(200);
  return r.json.pipelines as Pipe[];
}

/** A ZZ-TEST organisation and a Proactive deal. Both are archived afterwards. */
async function makeDeal(admin: Who, later: Later, label: string) {
  const pro = (await crmPipes(admin)).find((p) => p.key === "DEAL_PROACTIVE");
  if (!pro) throw new Error("Proactive pipeline is missing");
  const org = await admin.api.post("/api/orgs", { name: zz(`org ${label}`) });
  expect(org.status, JSON.stringify(org.json)).toBe(201);
  const orgId = org.json.organisation.id as string;
  later(() => admin.api.post(`/api/orgs/${orgId}/archive`, { archive: true }));
  const name = zz(`deal ${label}`);
  const d = await admin.api.post("/api/deals", {
    name, organisationId: orgId, pipelineId: pro.id, leaderId: admin.user.id, whyPursue: "ZZ-TEST fit",
    nextStep: { title: zz(`step ${label}`), dueDate: ymd(6) },
  });
  expect(d.status, JSON.stringify(d.json)).toBe(201);
  const id = d.json.deal.id as string;
  later(() => admin.api.post(`/api/projects/${id}/archive`));
  return { id, name, pro };
}

const load = async (admin: Who, id: string) => (await admin.api.get(`/api/projects/${id}`)).json.project as {
  type: string; deal: unknown; sections: { id: string; name: string; position: number; isDone: boolean }[];
};

test("AC1: every project on the Projects list is type Project", async ({ admin, later }) => {
  test.setTimeout(120_000);
  // The rehearsal (607 projects, no table's row count changed) is a one-time migration. A browser can check the live result of that default.
  const mine = await newProject(admin, later, { label: "2527 default" });
  const created = await load(admin, mine.id);
  expect(created.type, "a project created with no type is Project").toBe("PROJECT");
  expect(created.deal).toBeNull();

  const listed = (await admin.api.get("/api/projects")).json.projects as Proj[];
  expect(listed.some((p) => p.id === mine.id)).toBe(true);
  const sample = listed.filter((p) => p.id !== mine.id).slice(0, 8);
  for (const p of sample) {
    const row = await load(admin, p.id);
    expect(row.type, p.name).toBe("PROJECT");
    expect(row.deal, p.name).toBeNull();
  }
  const old = ((await admin.api.get("/api/projects?archived=true")).json.projects as Proj[]).slice(0, 4);
  for (const p of old) expect((await load(admin, p.id)).type, p.name).toBe("PROJECT");

  // A deal is a different type and is not slipped into this list. Skipped when the CRM is hidden.
  const crm = await admin.api.get("/api/deals/pipelines");
  if (crm.status === 404) return;
  expect(crm.status).toBe(200);
  const deal = await makeDeal(admin, later, "2527 not-a-project");
  const again = (await admin.api.get("/api/projects")).json.projects as Proj[];
  expect(again.some((p) => p.id === deal.id), "a deal is not a project row").toBe(false);
  expect((await load(admin, deal.id)).type).toBe("DEAL");
});

test("AC2: a project created on the Projects screen has type Project and is listed", async ({ admin, later }) => {
  test.setTimeout(120_000);
  const name = zz("2527 screen");
  await admin.page.goto("/projects/new");
  const form = admin.page.locator("form");
  await expect(form.getByLabel("Project name")).toBeVisible();
  // The form asks for a name and a Leader. It does not ask for a type, and there is no Deal choice.
  await expect(form.getByRole("combobox", { name: "Leader" })).toBeVisible();
  await expect(form.getByLabel(/type/i)).toHaveCount(0);
  await expect(form.getByText("Deal", { exact: true })).toHaveCount(0);
  await form.getByLabel("Project name").fill(name);
  await admin.page.getByRole("button", { name: "Create project" }).click();
  await admin.page.waitForURL(/\/projects\/(?!new\b)[^/?]+/);
  const id = new URL(admin.page.url()).pathname.split("/").pop()!;
  later(() => admin.api.post(`/api/projects/${id}/archive`));

  await admin.page.keyboard.press("Escape"); // a new project asks for its first task; that dialog is not the type
  await expect(admin.page.locator(".crumb").getByRole("link", { name: "Projects" })).toBeVisible();
  await expect(admin.page.locator(".crumb")).toContainText(name);
  const row = await load(admin, id);
  expect(row.type).toBe("PROJECT");
  expect(row.deal).toBeNull();

  // The create and update bodies have no type. Sending one does not turn the project into a deal.
  const flipped = await admin.api.patch(`/api/projects/${id}`, { description: "ZZ-TEST still a project", typeId: "wst_deal" });
  expect(flipped.status, JSON.stringify(flipped.json)).toBe(200);
  const still = await load(admin, id);
  expect(still.type).toBe("PROJECT");
  expect(still.deal).toBeNull();

  await admin.page.goto("/projects");
  await expect(admin.page.getByRole("heading", { level: 2, name })).toBeVisible();

  const deals = await admin.api.get("/api/deals");
  if (deals.status === 200) expect((deals.json.deals as { id: string }[]).some((d) => d.id === id)).toBe(false);
});

test("AC3: the migration only adds columns with defaults, and a rollback restores code but not the database", () => {
  const dir = "prisma/migrations/20261017124803_crm_workstreams_deals";
  expect(readdirSync(dir).sort()).toEqual(["migration.sql"]);
  const sql = readFileSync(`${dir}/migration.sql`, "utf8");
  expect(sql).toMatch(/"typeId" TEXT NOT NULL DEFAULT 'wst_project'/);
  expect(sql).toMatch(/"isIdea" BOOLEAN NOT NULL DEFAULT false/);
  expect(sql).toMatch(/ADD COLUMN\s+"pipelineId" TEXT/);
  expect(sql).toMatch(/ADD COLUMN\s+"stageId" TEXT/);
  expect(sql).toMatch(/ADD COLUMN\s+"stageReason" TEXT/);
  expect(sql).toMatch(/ADD COLUMN\s+"stageChangedAt" TIMESTAMP\(3\)/);
  expect(sql).not.toMatch(/\bDROP TABLE\b/);
  expect(sql).not.toMatch(/\bTRUNCATE\b/);
});

test("AC4: deal pipelines are separate from the project status pipeline, and moving a deal does not change a project", async ({ admin, later }) => {
  test.setTimeout(120_000);
  const pipes = await crmPipes(admin);
  const keys = pipes.map((p) => p.key);
  expect(keys).toContain("DEAL_PROACTIVE");
  expect(keys).toContain("DEAL_BID");
  expect(keys, "the project status pipeline is not a deal pipeline").not.toContain("PROJECT_STATUS");
  expect(pipes.some((p) => p.name === "Status")).toBe(false);
  const pro = pipes.find((p) => p.key === "DEAL_PROACTIVE")!;
  const bid = pipes.find((p) => p.key === "DEAL_BID")!;
  const proIds = new Set(pro.stages.map((s) => s.id));
  expect(bid.stages.filter((s) => proIds.has(s.id)), "the two deal pipelines do not share stage rows").toEqual([]);
  expect(pro.stages.some((s) => s.name === "Active"), "Active is the project status stage, not a deal stage").toBe(false);

  // Nothing in the product edits a stage row. A write to the pipeline list is refused, and the rows stay put.
  const edit = await admin.api.patch("/api/deals/pipelines", { name: "ZZ-TEST" });
  expect(edit.status).toBeGreaterThanOrEqual(400);
  const reread = (await admin.api.get("/api/deals/pipelines")).json.pipelines as Pipe[];
  expect(reread.flatMap((p) => p.stages.map((s) => s.id)).sort()).toEqual(pipes.flatMap((p) => p.stages.map((s) => s.id)).sort());

  const plain = await newProject(admin, later, { label: "2527 untouched" });
  const deal = await makeDeal(admin, later, "2527 move");
  const before = await load(admin, plain.id);
  expect(before.sections.map((s) => s.name)).toEqual(["To do", "In progress", "Done"]);
  const sectionIds = new Set(before.sections.map((s) => s.id));
  expect(pro.stages.some((s) => sectionIds.has(s.id)), "a project's sections are not deal stage rows").toBe(false);

  const conversation = pro.stages.find((s) => s.name === "Conversation")!;
  expect((await admin.api.post(`/api/projects/${deal.id}/stage`, { stageId: conversation.id })).status).toBe(200);
  expect((await load(admin, deal.id)).type).toBe("DEAL");
  expect(await load(admin, plain.id)).toEqual(before);

  await admin.page.goto(`/projects/${plain.id}`);
  await expect(admin.page.getByRole("group", { name: "Stage" })).toHaveCount(0);
  await expect(admin.page.getByRole("region", { name: "To do" })).toBeVisible();
  await expect(admin.page.getByRole("region", { name: "Done" })).toBeVisible();
});
