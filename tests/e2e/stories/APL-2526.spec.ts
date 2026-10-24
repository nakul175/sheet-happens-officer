// SHO-E13 Home and Monday review (Linear APL-2526).
// One test per acceptance criterion. People are nakul17+ aliases signed in with SHO_QA_PASS.
// Projects, deals and tasks are ZZ-TEST and archived afterwards.
// Pam left no qa:TC cases on this issue.
// A new idea is not 30 days old, so the review cannot render Convert and Drop for one this spec creates.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test, expect, zz, RUN } from "../support";
import { runVitest } from "../helpers/named-suite";
import { newProject, newTask, ymd, type Who } from "../g2";
import { createDeal, createOrg, dealBody, projectOf } from "../helpers/claude-a";
import { pipelines } from "../helpers/deal-board";
import { cast, gateFile } from "../helpers/qa-alias";

gateFile();

type Groups = { overdue: { id: string; title: string }[]; next7: { id: string; title: string }[]; later: { id: string; title: string }[] };
type Review = {
  needsNextStep: { id: string; name: string }[];
  overdueNextStep: { id: string; name: string }[];
  stalled: { id: string }[];
  ideas: { id: string; title: string; canEdit: boolean }[];
  counts: { name: string; stages: { id: string; name: string; count: number; withoutValue: number }[] }[];
};

const home = async (who: Who) => (await who.api.get("/api/my-tasks")).json as Groups;
const reviewOf = async (who: Who) => (await who.api.get("/api/review")).json as Review;

test("AC1: Home opens grouped By date: Overdue, Next 7 days, Later, with undated tasks last", async ({ browser, later }) => {
  test.setTimeout(180_000);
  const { admin, people: [holder] } = await cast(browser, later, ["home date"]);
  const project = await newProject(admin, later, { label: "e13 date", members: [{ who: holder, role: "EDITOR" }] });
  const overdue = zz("home overdue");
  const soon = zz("home soon");
  const far = zz("home later");
  const undated = zz("home undated");
  await newTask(admin, project.id, { title: overdue, assigneeId: holder.user.id, dueDate: ymd(-1) });
  await newTask(admin, project.id, { title: soon, assigneeId: holder.user.id, dueDate: ymd(2) });
  await newTask(admin, project.id, { title: far, assigneeId: holder.user.id, dueDate: ymd(20) });
  await newTask(admin, project.id, { title: undated, assigneeId: holder.user.id });
  const groups = await home(holder);
  expect(groups.overdue.map((t) => t.title)).toContain(overdue);
  expect(groups.next7.map((t) => t.title)).toContain(soon);
  expect(groups.later.map((t) => t.title)).toEqual(expect.arrayContaining([far, undated]));
  const laterTitles = groups.later.map((t) => t.title);
  expect(laterTitles.indexOf(far)).toBeLessThan(laterTitles.indexOf(undated));
  await holder.page.goto("/");
  await expect(holder.page.getByRole("button", { name: "By date" })).toHaveAttribute("aria-pressed", "true");
  await expect(holder.page.getByRole("region", { name: "Overdue" }).getByText(overdue)).toBeVisible();
  await expect(holder.page.getByRole("region", { name: "Next 7 days" }).getByText(soon)).toBeVisible();
  const laterRegion = holder.page.getByRole("region", { name: "Later" });
  await expect(laterRegion.getByText(far)).toBeVisible();
  await expect(laterRegion.getByText(undated)).toBeVisible();
  const y = async (title: string) => (await laterRegion.getByText(title).boundingBox())!.y;
  expect(await y(far)).toBeLessThan(await y(undated));
});

test("AC2: By project groups tasks by project, and the choice is remembered in this browser", async ({ browser, later }) => {
  test.setTimeout(180_000);
  const { admin, people: [holder] } = await cast(browser, later, ["home project"]);
  const first = await newProject(admin, later, { label: "e13 alpha", members: [{ who: holder, role: "EDITOR" }] });
  const second = await newProject(admin, later, { label: "e13 beta", members: [{ who: holder, role: "EDITOR" }] });
  const alpha = zz("alpha task");
  const beta = zz("beta task");
  await newTask(admin, first.id, { title: alpha, assigneeId: holder.user.id, dueDate: ymd(1) });
  await newTask(admin, second.id, { title: beta, assigneeId: holder.user.id, dueDate: ymd(3) });
  await holder.page.goto("/");
  await holder.page.getByRole("button", { name: "By project" }).click();
  await expect(holder.page.getByRole("button", { name: "By project" })).toHaveAttribute("aria-pressed", "true");
  await expect(holder.page.getByRole("region", { name: first.name }).getByText(alpha)).toBeVisible();
  await expect(holder.page.getByRole("region", { name: second.name }).getByText(beta)).toBeVisible();
  const stored = await holder.page.evaluate((id) => localStorage.getItem(`sho.home.group.${id}`), holder.user.id as string);
  expect(stored).toBe("project");
  await holder.page.reload();
  await expect(holder.page.getByRole("button", { name: "By project" })).toHaveAttribute("aria-pressed", "true");
  await expect(holder.page.getByRole("region", { name: first.name }).getByText(alpha)).toBeVisible();
});

test("AC3: an idea shows a chip in lists, on Home and in Search, and Search can show ideas only", async ({ browser, later }) => {
  test.setTimeout(180_000);
  const { admin, people: [holder] } = await cast(browser, later, ["idea"]);
  const project = await newProject(admin, later, { label: "e13 ideas", members: [{ who: holder, role: "EDITOR" }] });
  const token = `iq${RUN.slice(-6)}`;
  const idea = zz(`${token} flagged`);
  const plain = zz(`${token} plain`);
  const ideaId = await newTask(holder, project.id, { title: idea, assigneeId: holder.user.id, dueDate: ymd(3) });
  await newTask(holder, project.id, { title: plain, assigneeId: holder.user.id, dueDate: ymd(4) });
  expect((await holder.api.post(`/api/tasks/${ideaId}/idea`, { isIdea: true })).status).toBe(200);
  await holder.page.goto(`/projects/${project.id}`);
  await expect(holder.page.locator(".item", { hasText: idea }).locator(".chip.gold", { hasText: "Idea" })).toBeVisible();
  await holder.page.goto("/");
  await expect(holder.page.locator(".item", { hasText: idea }).locator(".chip.gold", { hasText: "Idea" })).toBeVisible();
  const found = await holder.api.get(`/api/search?q=${encodeURIComponent(token)}`);
  const titles = (found.json.tasks as { title: string; isIdea: boolean }[]).filter((t) => t.title.includes(token));
  expect(titles.map((t) => t.title).sort()).toEqual([idea, plain].sort());
  const only = await holder.api.get(`/api/search?q=${encodeURIComponent(token)}&idea=true`);
  expect((only.json.tasks as { title: string }[]).map((t) => t.title)).toEqual([idea]);
  await holder.page.goto("/search");
  await holder.page.getByLabel("Search").fill(token);
  await expect(holder.page.getByRole("link", { name: new RegExp(plain) })).toBeVisible();
  await holder.page.getByRole("checkbox", { name: "Ideas only" }).check();
  await expect(holder.page.getByRole("link", { name: new RegExp(idea) }).locator(".chip.gold", { hasText: "Idea" })).toBeVisible();
  await expect(holder.page.getByRole("link", { name: new RegExp(plain) })).toHaveCount(0);
});

test("AC4: Monday review lists deals that need a next step, overdue next steps, stalled deals, and ideas older than 30 days", async ({ browser, later }) => {
  test.setTimeout(180_000);
  const { admin } = await cast(browser, later, []);
  const { pro } = await pipelines(admin.api);
  const org = await createOrg(admin, later, "e13 review org");
  const overdue = await createDeal(admin, later, dealBody({
    name: zz("e13 overdue deal"), organisationId: org.id, pipelineId: pro.id, leaderId: admin.user.id, due: ymd(-2),
  }));
  const empty = await createDeal(admin, later, dealBody({
    name: zz("e13 needs deal"), organisationId: org.id, pipelineId: pro.id, leaderId: admin.user.id,
  }));
  const stepId = (await projectOf(admin, empty.id)).deal.nextStep.id as string;
  expect((await admin.api.post(`/api/tasks/${stepId}/complete`, { expectedUpdatedAt: (await admin.api.get(`/api/tasks/${stepId}`)).json.task.updatedAt })).status).toBe(200);
  const project = await newProject(admin, later, { label: "e13 idea project" });
  const fresh = zz("fresh idea");
  const ideaId = await newTask(admin, project.id, { title: fresh, assigneeId: admin.user.id, dueDate: ymd(6) });
  expect((await admin.api.post(`/api/tasks/${ideaId}/idea`, { isIdea: true })).status).toBe(200);

  const data = await reviewOf(admin);
  expect(data.overdueNextStep.some((d) => d.id === overdue.id)).toBe(true);
  expect(data.needsNextStep.some((d) => d.id === empty.id)).toBe(true);
  expect(data.ideas.some((t) => t.id === ideaId)).toBe(false);
  await admin.page.goto("/review");
  await expect(admin.page.getByRole("region", { name: "Needs a next step" }).getByText(empty.name)).toBeVisible();
  await expect(admin.page.getByRole("region", { name: "Next step is overdue" }).getByText(overdue.name)).toBeVisible();
  await expect(admin.page.getByRole("region", { name: "Stalled for 30 days" })).toBeVisible();
  const ideas = admin.page.getByRole("region", { name: "Ideas older than 30 days" });
  await expect(ideas).toBeVisible();
  await expect(ideas.getByText(fresh)).toHaveCount(0);
  if (data.ideas.length === 0) {
    await expect(ideas.getByText("No old ideas.")).toBeVisible();
    await expect(ideas.getByRole("button", { name: "Convert to deal" })).toHaveCount(0);
    await expect(ideas.getByRole("button", { name: "Drop" })).toHaveCount(0);
  } else {
    const editable = data.ideas.filter((t) => t.canEdit);
    if (editable.length) {
      await expect(ideas.getByRole("button", { name: "Convert to deal" }).first()).toBeVisible();
      await expect(ideas.getByRole("button", { name: "Drop" }).first()).toBeVisible();
    }
  }
});

test("AC5: the review counts deals in each stage and how many have no value", async ({ browser, later }) => {
  test.setTimeout(120_000);
  const { admin } = await cast(browser, later, []);
  const { pro } = await pipelines(admin.api);
  const org = await createOrg(admin, later, "e13 count org");
  const deal = await createDeal(admin, later, dealBody({ name: zz("e13 no value"), organisationId: org.id, pipelineId: pro.id, leaderId: admin.user.id }));
  const data = await reviewOf(admin);
  const stage = data.counts.flatMap((p) => p.stages).find((s) => s.id === pro.stages[0].id)!;
  expect(stage.count).toBeGreaterThanOrEqual(1);
  expect(stage.withoutValue).toBeGreaterThanOrEqual(1);
  const listed = ((await admin.api.get("/api/deals")).json.deals as { id: string; value: number | null; stage: { id: string } }[]).find((d) => d.id === deal.id)!;
  expect(listed.stage.id).toBe(stage.id);
  expect(listed.value).toBeNull();
  await admin.page.goto("/review");
  const row = admin.page.locator("tr", { hasText: stage.name }).first();
  await expect(row).toContainText(String(stage.count));
  await expect(row).toContainText(`${stage.withoutValue} without value`);
});

function myTasksAssertions(source: string) {
  const start = source.indexOf('describe("My tasks (5.1)"');
  expect(start, "My tasks describe").toBeGreaterThanOrEqual(0);
  const rest = source.slice(start);
  const cuts = [rest.indexOf("\ndescribe(", 10), rest.indexOf("\nexport ", 10)].filter((at) => at > 0);
  const block = cuts.length ? rest.slice(0, Math.min(...cuts)) : rest;
  return block.split("\n").filter((line) => /\bexpect\(/.test(line)).map((line) => line.trim()).join("\n");
}

test("AC6: existing My tasks tests pass unchanged", async () => {
  test.setTimeout(15 * 60_000);
  const log = execFileSync("git", ["log", "-p", "d0f2522^..HEAD", "--", "tests/work.test.ts"], { encoding: "utf8" });
  const before = execFileSync("git", ["show", "d0f2522^:tests/work.test.ts"], { encoding: "utf8" });
  expect(myTasksAssertions(readFileSync("tests/work.test.ts", "utf8")), log.slice(0, 4_000) || "no edits to tests/work.test.ts since d0f2522^").toBe(myTasksAssertions(before));
  const work = await runVitest(["tests/work.test.ts", "tests/crm-visible.test.ts"]);
  expect(work.numPassedTests).toBe(work.numTotalTests);
  // The default vitest config excludes tests/viewport, so this file runs with the viewport config.
  const a11y = await runVitest(["tests/viewport/a11y.test.ts"], "vitest.viewport.config.mts");
  expect(a11y.numPassedTests).toBe(a11y.numTotalTests);
});
