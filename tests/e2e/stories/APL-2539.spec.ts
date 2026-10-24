// SHO-US-12.3 Deal page (Linear APL-2539).
// One test per acceptance criterion. Sign-in is login("ADMIN") / login("MEMBER") via the fixtures.
// Deals and organisations are ZZ-TEST and archived afterwards.
// On hold, Won and Lost are stages in the stepper. The page is /projects/:id.
import { test, expect, zz } from "../support";
import { newTask, ymd } from "../g2";
import { pipelines } from "../helpers/deal-board";
import { activity, createDeal, createOrg, dealBody, dealPanel, noSideways, projectOf } from "../helpers/claude-a";

test("APL-2539 > AC1: the panel shows the pipeline, the organisation and the stage stepper, and the Leader is on Members", async ({ admin, later }) => {
  const pipes = await pipelines(admin.api);
  const org = await createOrg(admin, later, "page buyer");
  const deal = await createDeal(admin, later, dealBody({ name: zz("page deal"), organisationId: org.id, pipelineId: pipes.pro.id, leaderId: admin.user.id }));
  await admin.page.goto(`/projects/${deal.id}`);
  const main = admin.page.getByRole("main");
  const stages = main.getByRole("group", { name: "Stage" });
  // SHO-2996: the panel is a landmark, not the Stage group's parent -- the shared helper APL-2540 AC1/AC3 and this spec's
  // AC2 use, so a wrapper around the group cannot make AC1 disagree with them.
  const panel = dealPanel(admin.page);
  await expect(panel.getByText(pipes.pro.name, { exact: true })).toBeVisible();
  // The organisation is linked twice in the panel (beside the pipeline and as the Buyer). The Buyer link is the one in the "Buyer:" field.
  await expect(panel.getByText(/^Buyer:/).getByRole("link", { name: org.name, exact: true })).toHaveAttribute("href", `/accounts/${org.id}`);
  await expect(stages.getByRole("button", { name: "Lead", exact: true })).toHaveAttribute("aria-current", "step");
  await expect(stages.getByRole("button", { name: "On hold", exact: true })).toBeEnabled();
  await expect(stages.getByRole("button", { name: "Won", exact: true })).toBeEnabled();
  await expect(stages.getByRole("button", { name: "Lost", exact: true })).toBeEnabled();
  await expect(main.getByRole("button", { name: "Put on hold", exact: true })).toHaveCount(0);
  await expect(main.getByRole("button", { name: "Close", exact: true })).toHaveCount(0);
  await expect(panel).not.toContainText(admin.user.name);
  await admin.page.getByRole("link", { name: "Members", exact: true }).click();
  await expect(admin.page.getByRole("heading", { name: "Members" })).toBeVisible();
  // The Leader is the only member, so their name and the Leader role each appear once on the list.
  await expect(main.getByText(admin.user.name, { exact: true })).toBeVisible();
  await expect(main.getByText("Leader", { exact: true })).toBeVisible();
});

test("APL-2539 > AC2: the next step is a line in the panel, a red chip when there is none, and a muted note when the stage needs none", async ({ admin, later }) => {
  const pipes = await pipelines(admin.api);
  const org = await createOrg(admin, later, "step buyer");
  const step = zz("panel step");
  const deal = await createDeal(admin, later, dealBody({ name: zz("step deal"), organisationId: org.id, pipelineId: pipes.pro.id, leaderId: admin.user.id, step, due: ymd(4) }));
  await admin.page.goto(`/projects/${deal.id}`);
  const panel = dealPanel(admin.page);
  const line = panel.locator("p", { hasText: "Next step:" });
  await expect(line).toContainText(step);
  await expect(line).toContainText("·");
  const stepId = (await projectOf(admin, deal.id)).deal.nextStep.id as string;
  // The complete endpoint is versioned: send the step's current updatedAt, as the app does.
  const stepVersion = (await admin.api.get(`/api/tasks/${stepId}`)).json.task.updatedAt as string;
  expect(stepVersion, "the step's current updatedAt").toBeTruthy();
  expect((await admin.api.post(`/api/tasks/${stepId}/complete`, { expectedUpdatedAt: stepVersion })).status).toBe(200);
  await admin.page.reload();
  await expect(panel.locator(".chip.red", { hasText: "No next step. Add a dated task." })).toBeVisible();
  await panel.getByRole("button", { name: "On hold", exact: true }).click();
  const dialog = admin.page.getByRole("dialog", { name: "Move to On hold" });
  await dialog.getByLabel("Reason (required)").fill("ZZ-TEST pause");
  await dialog.getByRole("button", { name: "Move deal" }).click();
  await expect(panel.getByText("No next step needed in this stage.")).toBeVisible();
  await expect(panel.locator(".chip.red")).toHaveCount(0);
});

test("APL-2539 > AC3: unset probability, expected close and deadline are hidden, and an unset value is never zero", async ({ admin, later }) => {
  const pipes = await pipelines(admin.api);
  const org = await createOrg(admin, later, "blank buyer");
  const deal = await createDeal(admin, later, dealBody({ name: zz("blank deal"), organisationId: org.id, pipelineId: pipes.pro.id, leaderId: admin.user.id }));
  await admin.page.goto(`/projects/${deal.id}`);
  const panel = dealPanel(admin.page);
  await expect(panel.getByText("No value yet")).toBeVisible();
  await expect(panel.getByText("Not set")).toHaveCount(0);
  await expect(panel).not.toContainText("%");
  await expect(panel).not.toContainText(/\b(INR|USD|EUR)\b/);
  await expect(panel.getByText(/^Close /)).toHaveCount(0);
  await expect(panel).not.toContainText("Submit by");
  const patched = await admin.api.patch(`/api/projects/${deal.id}/deal`, { probability: 40, expectedClose: ymd(10) });
  expect(patched.status, JSON.stringify(patched.json)).toBe(200);
  await admin.page.reload();
  await expect(panel.getByText("40%")).toBeVisible();
  await expect(panel.getByText(/^Close /)).toBeVisible();
  await expect(panel.getByText("No value yet")).toBeVisible();

  const bid = await createDeal(admin, later, dealBody({
    name: zz("blank bid"), organisationId: org.id, pipelineId: pipes.bid.id, leaderId: admin.user.id, deadline: ymd(12),
  }));
  await admin.page.goto(`/projects/${bid.id}`);
  const bidPanel = dealPanel(admin.page);
  await expect(bidPanel.getByText(/^Submit by /)).toBeVisible();
  expect((await admin.api.patch(`/api/projects/${bid.id}/deal`, { submissionDeadline: null })).status).toBe(200);
  await admin.page.reload();
  await expect(bidPanel.getByText(/^Submit by /)).toHaveCount(0);
  await expect(bidPanel.getByText("Not set")).toHaveCount(0);
});

test("APL-2539 > AC4: tasks use the project List and Board, with the same Sections", async ({ admin, later }) => {
  const pipes = await pipelines(admin.api);
  const org = await createOrg(admin, later, "tasks buyer");
  const step = zz("listed step");
  const deal = await createDeal(admin, later, dealBody({ name: zz("tasks deal"), organisationId: org.id, pipelineId: pipes.pro.id, leaderId: admin.user.id, step }));
  const doing = zz("doing step");
  const project = await projectOf(admin, deal.id);
  const doingId = (project.sections as { id: string; name: string }[]).find((s) => s.name === "In progress")!.id;
  await newTask(admin, deal.id, { title: doing, sectionId: doingId });
  await admin.page.goto(`/projects/${deal.id}`);
  await expect(admin.page.getByRole("region", { name: "To do" }).getByText(step)).toBeVisible();
  await expect(admin.page.getByRole("region", { name: "In progress" }).getByText(doing)).toBeVisible();
  await expect(admin.page.getByRole("region", { name: "Done" })).toBeVisible();
  await admin.page.getByRole("tab", { name: "Board", exact: true }).click();
  await expect(admin.page.locator(".board").locator(".col", { hasText: "To do" }).getByText(step)).toBeVisible();
  await expect(admin.page.locator(".board").locator(".col", { hasText: "In progress" }).getByText(doing)).toBeVisible();
});

test("APL-2539 > AC5: Members, Activity and Trash are the project pages", async ({ admin, later }) => {
  const pipes = await pipelines(admin.api);
  const org = await createOrg(admin, later, "links buyer");
  const name = zz("links deal");
  const deal = await createDeal(admin, later, dealBody({ name, organisationId: org.id, pipelineId: pipes.pro.id, leaderId: admin.user.id }));
  expect((await activity(admin, deal.id)).some((row) => row.what === `created the deal "${name}"`)).toBe(true);
  await admin.page.goto(`/projects/${deal.id}`);
  await admin.page.getByRole("link", { name: "Members", exact: true }).click();
  await expect(admin.page).toHaveURL(new RegExp(`/projects/${deal.id}/members$`));
  await expect(admin.page.getByRole("heading", { name: "Members" })).toBeVisible();
  await admin.page.goto(`/projects/${deal.id}/activity`);
  await expect(admin.page.getByRole("heading", { name: "Activity" })).toBeVisible();
  await expect(admin.page.locator(".item.act", { hasText: `created the deal "${name}"` })).toBeVisible();
  await admin.page.goto(`/projects/${deal.id}/trash`);
  await expect(admin.page.getByRole("heading", { name: "Trash" })).toBeVisible();
  await expect(admin.page.getByText("Trash is empty.")).toBeVisible();
});

test("APL-2539 > AC6: a Viewer cannot move the stage or edit details, and an archived deal is read-only", async ({ admin, member, later }) => {
  const pipes = await pipelines(admin.api);
  const org = await createOrg(admin, later, "viewer buyer");
  const deal = await createDeal(admin, later, dealBody({ name: zz("viewer deal"), organisationId: org.id, pipelineId: pipes.pro.id, leaderId: admin.user.id }));
  expect((await admin.api.post(`/api/projects/${deal.id}/members`, { userId: member.user.id, role: "VIEWER" })).status).toBe(201);
  await member.page.goto(`/projects/${deal.id}`);
  const panel = dealPanel(member.page);
  await expect(panel.getByRole("button", { name: "Conversation", exact: true })).toBeDisabled();
  await expect(panel.getByRole("button", { name: "On hold", exact: true })).toBeDisabled();
  await expect(panel.getByRole("button", { name: "Won", exact: true })).toBeDisabled();
  await expect(panel.getByRole("button", { name: "Lost", exact: true })).toBeDisabled();
  await expect(panel.getByRole("button", { name: "Edit details" })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "+ Add organisation" })).toHaveCount(0);
  expect((await member.api.post(`/api/projects/${deal.id}/stage`, { stageId: pipes.pro.stages[1].id })).status).toBe(403);

  expect((await admin.api.post(`/api/projects/${deal.id}/archive`)).status).toBeLessThan(300);
  await admin.page.goto(`/projects/${deal.id}`);
  await expect(admin.page.getByText("This project is archived and read-only.")).toBeVisible();
  const archived = dealPanel(admin.page);
  await expect(archived.getByRole("button", { name: "Conversation", exact: true })).toBeDisabled();
  await expect(archived.getByRole("button", { name: "Edit details" })).toHaveCount(0);
  await expect(archived.getByRole("button", { name: "+ Add organisation" })).toHaveCount(0);
  expect((await admin.api.patch(`/api/projects/${deal.id}/deal`, { probability: 10 })).status).toBe(409);
});

test("APL-2539 > AC7: at 390px the deal page does not scroll sideways", async ({ admin, later }) => {
  const pipes = await pipelines(admin.api);
  const org = await createOrg(admin, later, "narrow buyer with a long organisation name");
  const deal = await createDeal(admin, later, dealBody({ name: zz("narrow deal"), organisationId: org.id, pipelineId: pipes.pro.id, leaderId: admin.user.id }));
  await admin.page.setViewportSize({ width: 390, height: 844 });
  await admin.page.goto(`/projects/${deal.id}`);
  await expect(dealPanel(admin.page).getByRole("group", { name: "Stage" })).toBeVisible();
  await noSideways(admin.page);
});
