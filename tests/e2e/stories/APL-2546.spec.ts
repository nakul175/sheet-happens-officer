// SHO-US-13.3 Monday pipeline review (APL-2546).
// One test per acceptance criterion. ZZ-TEST deals, projects and tasks are archived afterwards.
// Ideas are listed only when the task's creation date is more than 30 days ago. A session cannot set that,
// so Drop (AC2) is skipped and the Convert button on the review row cannot be rendered. AC3 opens the same
// conversion dialog from the task the row would link to, and checks a Viewer is not offered it.
// The plain Member is the person who must not see someone else's deal.
import { expect, zz } from "../support";
import { test } from "../helpers/story-people";
import { storyGate } from "../helpers/qa-alias";
import { ageTaskCreated } from "../helpers/own-row";
import { newProject, newTask, ymd, type Who } from "../g2";

storyGate({ admin: true });

type Later = (fn: () => Promise<unknown>) => void;
type Review = { needsNextStep: { id: string }[]; overdueNextStep: { id: string }[]; stalled: { id: string }[]; ideas: { id: string; canEdit?: boolean }[] };

async function makeDeal(admin: Who, later: Later, o: { label: string; leaderId?: string; due?: string }) {
  const org = await admin.api.post("/api/orgs", { name: zz(`org ${o.label}`) });
  expect(org.status, JSON.stringify(org.json)).toBe(201);
  const orgId = org.json.organisation.id as string;
  later(() => admin.api.post(`/api/orgs/${orgId}/archive`, { archive: true }));
  const pro = ((await admin.api.get("/api/deals/pipelines")).json.pipelines as { id: string; key: string }[]).find((p) => p.key === "DEAL_PROACTIVE")!;
  const name = zz(`deal ${o.label}`);
  const d = await admin.api.post("/api/deals", {
    name, organisationId: orgId, pipelineId: pro.id, leaderId: o.leaderId ?? admin.user.id, whyPursue: "ZZ-TEST fit",
    nextStep: { title: zz(`step ${o.label}`), dueDate: o.due ?? ymd(4) },
  });
  expect(d.status, JSON.stringify(d.json)).toBe(201);
  const id = d.json.deal.id as string;
  later(() => admin.api.post(`/api/projects/${id}/archive`));
  return { id, name };
}

const review = async (who: Who) => (await who.api.get("/api/review")).json as Review;
const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

test("AC1: Admins see every deal on the review, everyone else only the deals on their projects, and archived deals are left out", async ({ admin, member, later }) => {
  test.setTimeout(180_000);
  const mine = await makeDeal(admin, later, { label: "mine", leaderId: member.user.id, due: ymd(-2) });
  let seen = await review(member);
  expect(ids(seen.overdueNextStep)).toContain(mine.id);
  expect(ids((await review(admin)).overdueNextStep)).toContain(mine.id);

  const hidden = await makeDeal(admin, later, { label: "hidden", due: ymd(-2) });
  seen = await review(member);
  expect(ids(seen.overdueNextStep).includes(hidden.id)).toBe(false);
  expect(ids(seen.needsNextStep).includes(hidden.id)).toBe(false);
  expect(ids((await review(admin)).overdueNextStep)).toContain(hidden.id);

  await member.page.goto("/review");
  await expect(member.page.getByRole("link", { name: new RegExp(mine.name) })).toBeVisible();
  await expect(member.page.getByText(hidden.name)).toHaveCount(0);
  await admin.page.goto("/review");
  await expect(admin.page.getByRole("link", { name: new RegExp(hidden.name) })).toBeVisible();

  expect((await admin.api.post(`/api/projects/${hidden.id}/members`, { userId: member.user.id, role: "VIEWER" })).status).toBe(201);
  expect(ids((await review(member)).overdueNextStep)).toContain(hidden.id);

  expect((await admin.api.post(`/api/projects/${hidden.id}/archive`)).status).toBeLessThan(300);
  for (const who of [admin, member]) {
    const r = await review(who);
    for (const key of ["needsNextStep", "overdueNextStep", "stalled"] as const) expect(ids(r[key]).includes(hidden.id)).toBe(false);
  }
  await admin.page.reload();
  await expect(admin.page.getByText(hidden.name)).toHaveCount(0);
});

test("AC2: Drop removes the Idea flag and the task stays", async ({ admin, member, later }) => {
  test.setTimeout(120_000);
  const p = await newProject(admin, later, { label: "review drop" });
  const title = zz("old idea");
  const id = await newTask(admin, p.id, { title, dueDate: ymd(6), assigneeId: admin.user.id });
  expect((await admin.api.post(`/api/tasks/${id}/idea`, { isIdea: true })).status).toBe(200);
  expect((await admin.api.post(`/api/projects/${p.id}/members`, { userId: member.user.id, role: "VIEWER" })).status).toBe(201);
  ageTaskCreated(id, 40);
  expect(ids((await review(admin)).ideas)).toContain(id);
  expect((await review(member)).ideas.find((i) => i.id === id)?.canEdit).toBe(false);
  await admin.page.goto("/review");
  const row = admin.page.locator("li, tr, .item, div", { hasText: title }).filter({ has: admin.page.getByRole("button", { name: "Drop" }) }).first();
  await expect(row.getByRole("button", { name: "Drop" })).toBeVisible();
  await row.getByRole("button", { name: "Drop" }).click();
  await expect.poll(async () => ids((await review(admin)).ideas).includes(id)).toBe(false);
  const task = await admin.api.get(`/api/tasks/${id}`);
  expect(task.status).toBe(200);
  expect(task.json.task.isIdea).toBe(false);
  expect(task.json.task.title).toBe(title);
  await member.page.goto("/review");
  await expect(member.page.locator(".item", { hasText: title }).getByRole("button", { name: "Drop" })).toHaveCount(0);
});

test("AC3: Convert to deal opens the conversion dialog, and a Viewer is not offered it", async ({ admin, member, later }) => {
  test.setTimeout(180_000);
  const p = await newProject(admin, later, { label: "review convert" });
  const title = zz("review idea");
  const id = await newTask(admin, p.id, { title, dueDate: ymd(6), assigneeId: admin.user.id });
  expect((await admin.api.post(`/api/tasks/${id}/idea`, { isIdea: true })).status).toBe(200);
  expect((await admin.api.post(`/api/projects/${p.id}/members`, { userId: member.user.id, role: "VIEWER" })).status).toBe(201);
  // A new idea is not on the review, so the row's Convert and Drop are not offered yet.
  expect(ids((await review(admin)).ideas).includes(id)).toBe(false);
  expect(ids((await review(member)).ideas).includes(id)).toBe(false);

  await admin.page.goto(`/projects/${p.id}?task=${id}`);
  await admin.page.getByRole("button", { name: "Convert to deal" }).click();
  const dialog = admin.page.getByRole("dialog", { name: "Convert to deal" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Convert to deal" })).toBeVisible();
  await expect(dialog.getByLabel("Organisation (buyer)")).toBeVisible();
  await expect(dialog.getByLabel("Why are we pursuing this?")).toBeVisible();
  await admin.page.keyboard.press("Escape");

  await member.page.goto(`/projects/${p.id}?task=${id}`);
  await expect(member.page.getByRole("dialog")).toBeVisible();
  await expect(member.page.getByRole("button", { name: "Convert to deal" })).toHaveCount(0);
  const refused = await member.api.post(`/api/tasks/${id}/convert`, { whyPursue: "ZZ-TEST fit" });
  expect(refused.status).toBe(403);
  expect((await admin.api.get(`/api/tasks/${id}`)).json.task.projectId).toBe(p.id);
});

test("AC4: a review row opens the deal it describes", async ({ admin, later }) => {
  test.setTimeout(120_000);
  const d = await makeDeal(admin, later, { label: "open row" });
  const step = ((await admin.api.get("/api/deals")).json.deals as { id: string; nextStep: { id: string } | null }[]).find((x) => x.id === d.id)!.nextStep!.id;
  expect((await admin.api.post(`/api/tasks/${step}/complete`, {})).status).toBe(200);
  expect(ids((await review(admin)).needsNextStep)).toContain(d.id);

  await admin.page.goto("/review");
  const link = admin.page.getByRole("region", { name: "Needs a next step" }).getByRole("link", { name: new RegExp(d.name) });
  await expect(link).toHaveAttribute("href", `/projects/${d.id}`);
  await link.click();
  await expect(admin.page).toHaveURL(new RegExp(`/projects/${d.id}$`));
  await expect(admin.page.getByText(d.name).first()).toBeVisible();
});

test("AC5: at 390 px the review does not scroll sideways", async ({ admin, later }) => {
  test.setTimeout(120_000);
  const d = await makeDeal(admin, later, { label: "narrow" });
  const step = ((await admin.api.get("/api/deals")).json.deals as { id: string; nextStep: { id: string } | null }[]).find((x) => x.id === d.id)!.nextStep!.id;
  expect((await admin.api.post(`/api/tasks/${step}/complete`, {})).status).toBe(200);
  await admin.page.setViewportSize({ width: 390, height: 800 });
  await admin.page.goto("/review");
  await expect(admin.page.getByRole("heading", { name: "Pipeline review" })).toBeVisible();
  await expect(admin.page.getByRole("region", { name: "Needs a next step" }).getByText(d.name)).toBeVisible();
  await expect(admin.page.getByText("Pipeline by stage")).toBeVisible();
  const overflow = await admin.page.evaluate(() => ({
    page: document.documentElement.scrollWidth - window.innerWidth,
    body: document.body.scrollWidth - window.innerWidth,
  }));
  expect(overflow.page).toBeLessThanOrEqual(1);
  expect(overflow.body).toBeLessThanOrEqual(1);
});
