// SHO-US-13.1 Home grouped by date or by project (APL-2544).
// One test per acceptance criterion. ZZ-TEST projects, deals and tasks are archived afterwards.
// The By date / By project choice is stored in the browser as sho.home.group.<userId>. Each test gets a fresh context.
// "The existing My tasks tests pass unchanged" is the unit suite; this file does not edit those tests.
import { test, expect, zz } from "../support";
import { newProject, newTask, ymd, type Who } from "../g2";

type Later = (fn: () => Promise<unknown>) => void;

async function makeDeal(admin: Who, later: Later, label: string, due = ymd(3)) {
  const org = await admin.api.post("/api/orgs", { name: zz(`org ${label}`) });
  expect(org.status, JSON.stringify(org.json)).toBe(201);
  const orgId = org.json.organisation.id as string;
  later(() => admin.api.post(`/api/orgs/${orgId}/archive`, { archive: true }));
  const pro = ((await admin.api.get("/api/deals/pipelines")).json.pipelines as { id: string; key: string }[]).find((p) => p.key === "DEAL_PROACTIVE")!;
  const step = zz(`step ${label}`);
  const name = zz(`deal ${label}`);
  const d = await admin.api.post("/api/deals", {
    name, organisationId: orgId, pipelineId: pro.id, leaderId: admin.user.id, whyPursue: "ZZ-TEST fit",
    nextStep: { title: step, dueDate: due },
  });
  expect(d.status, JSON.stringify(d.json)).toBe(201);
  const id = d.json.deal.id as string;
  later(() => admin.api.post(`/api/projects/${id}/archive`));
  return { id, name, step };
}

test("AC1: By date is the default and groups Overdue, Next 7 days and Later, with undated tasks last in Later", async ({ admin, later }) => {
  test.setTimeout(120_000);
  const p = await newProject(admin, later, { label: "by date" });
  const overdue = zz("overdue");
  const soon = zz("soon");
  const laterTitle = zz("later dated");
  const undated = zz("undated");
  await newTask(admin, p.id, { title: overdue, dueDate: ymd(-2), assigneeId: admin.user.id });
  await newTask(admin, p.id, { title: soon, dueDate: ymd(3), assigneeId: admin.user.id });
  await newTask(admin, p.id, { title: laterTitle, dueDate: ymd(20), assigneeId: admin.user.id });
  await newTask(admin, p.id, { title: undated, assigneeId: admin.user.id });

  const mine = (await admin.api.get("/api/my-tasks")).json as { overdue: { title: string; project: { id: string } }[]; next7: { title: string; project: { id: string } }[]; later: { title: string; dueDate: string | null; project: { id: string } }[] };
  const inGroup = (rows: { title: string; project: { id: string } }[], title: string) => rows.some((t) => t.project.id === p.id && t.title === title);
  expect(inGroup(mine.overdue, overdue)).toBe(true);
  expect(inGroup(mine.next7, soon)).toBe(true);
  const laterRows = mine.later.filter((t) => t.project.id === p.id);
  expect(laterRows.map((t) => t.title)).toEqual([laterTitle, undated]);
  expect(laterRows[laterRows.length - 1].dueDate).toBeNull();

  await admin.page.goto("/");
  await expect(admin.page.getByRole("button", { name: "By date" })).toHaveAttribute("aria-pressed", "true");
  await expect(admin.page.getByRole("button", { name: "By project" })).toHaveAttribute("aria-pressed", "false");
  await expect(admin.page.getByRole("region", { name: "Overdue" }).getByText(overdue)).toBeVisible();
  await expect(admin.page.getByRole("region", { name: "Next 7 days" }).getByText(soon)).toBeVisible();
  const laterText = await admin.page.getByRole("region", { name: "Later" }).innerText();
  expect(laterText.indexOf(laterTitle)).toBeGreaterThanOrEqual(0);
  expect(laterText.indexOf(laterTitle)).toBeLessThan(laterText.indexOf(undated));
});

test("AC2: By project shows each project as a heading, tasks soonest first, and a Deal heading carries the Deal chip and its stage", async ({ admin, later }) => {
  test.setTimeout(120_000);
  const p = await newProject(admin, later, { label: "by project" });
  const titles = [zz("p overdue"), zz("p soon"), zz("p later"), zz("p undated")];
  await newTask(admin, p.id, { title: titles[0], dueDate: ymd(-1), assigneeId: admin.user.id });
  await newTask(admin, p.id, { title: titles[1], dueDate: ymd(2), assigneeId: admin.user.id });
  await newTask(admin, p.id, { title: titles[2], dueDate: ymd(16), assigneeId: admin.user.id });
  await newTask(admin, p.id, { title: titles[3], assigneeId: admin.user.id });
  const deal = await makeDeal(admin, later, "heading", ymd(4));

  await admin.page.goto("/");
  await admin.page.getByRole("button", { name: "By project" }).click();
  const project = admin.page.getByRole("region", { name: p.name });
  await expect(project).toBeVisible();
  const text = await project.innerText();
  let at = -1;
  for (const title of titles) {
    const i = text.indexOf(title);
    expect(i, title).toBeGreaterThan(at);
    at = i;
  }
  const heading = admin.page.getByRole("region", { name: deal.name });
  await expect(heading.locator(".chip", { hasText: /^Deal$/ })).toBeVisible();
  await expect(heading.locator(".chip", { hasText: /^Lead$/ })).toBeVisible();
  await expect(heading.getByText(deal.step)).toBeVisible();
});

test("AC3: a deal the person leads that needs a next step is a heading with + Add task, even with no task of theirs", async ({ admin, later }) => {
  test.setTimeout(120_000);
  const deal = await makeDeal(admin, later, "needs");
  const stepId = ((await admin.api.get("/api/deals")).json.deals as { id: string; nextStep: { id: string } | null }[]).find((d) => d.id === deal.id)!.nextStep!.id;
  expect((await admin.api.post(`/api/tasks/${stepId}/complete`, { expectedUpdatedAt: (await admin.api.get(`/api/tasks/${stepId}`)).json.task.updatedAt })).status).toBe(200);

  await admin.page.goto("/");
  await admin.page.getByRole("button", { name: "By project" }).click();
  const heading = admin.page.getByRole("region", { name: deal.name });
  await expect(heading).toBeVisible();
  await expect(heading.getByRole("button", { name: "+ Add task" })).toBeVisible();
  await expect(heading.locator(".chip.red")).toHaveText("Needs a next step");
  await expect(heading.getByText(deal.step)).toHaveCount(0);
});

test("AC4: What is next for the deal appears at the top of the page in both groupings", async ({ admin, later }) => {
  test.setTimeout(120_000);
  const deal = await makeDeal(admin, later, "both", ymd(1));
  await admin.page.goto("/");
  await admin.page.getByRole("button", { name: `Complete "${deal.step}"` }).click();
  const prompt = admin.page.locator(".card", { hasText: `What is next for ${deal.name}?` });
  await expect(prompt).toBeVisible();
  const aboveGroups = async () => {
    const y = (await prompt.boundingBox())!.y;
    return y < (await admin.page.locator(".grp").first().boundingBox())!.y;
  };
  expect(await aboveGroups(), "By date: the prompt is above the groups, not under the completed task").toBe(true);
  await admin.page.getByRole("button", { name: "By project" }).click();
  await expect(prompt).toBeVisible();
  await expect(admin.page.getByRole("region", { name: deal.name })).toBeVisible();
  expect(await aboveGroups(), "By project: the same prompt stays at the top").toBe(true);
});

test("AC5: the grouping is remembered for that person, and Home stays By date when the browser cannot store it", async ({ admin }) => {
  test.setTimeout(120_000);
  const key = `sho.home.group.${admin.user.id}`;
  await admin.page.goto("/");
  await admin.page.getByRole("button", { name: "By project" }).click();
  await admin.page.reload();
  await expect(admin.page.getByRole("button", { name: "By project" })).toHaveAttribute("aria-pressed", "true");
  expect(await admin.page.evaluate((k) => localStorage.getItem(k), key)).toBe("project");

  // Another person's key does not change this Home.
  await admin.page.evaluate((k) => { localStorage.removeItem(k); localStorage.setItem("sho.home.group.someone-else", "project"); }, key);
  await admin.page.reload();
  await expect(admin.page.getByRole("button", { name: "By date" })).toHaveAttribute("aria-pressed", "true");

  await admin.page.evaluate((k) => localStorage.setItem(k, "project"), key);
  await admin.page.addInitScript(() => {
    const orig = Storage.prototype.getItem;
    Storage.prototype.getItem = function (k: string) {
      if (String(k).startsWith("sho.home.group.")) throw new Error("storage blocked");
      return orig.call(this, k);
    };
  });
  await admin.page.reload();
  await expect(admin.page.getByRole("button", { name: "By date" })).toHaveAttribute("aria-pressed", "true");
});

test("AC6: tasks in an archived project stay hidden in both groupings", async ({ admin, later }) => {
  test.setTimeout(120_000);
  const p = await newProject(admin, later, { label: "archived home" });
  const title = zz("hidden when archived");
  await newTask(admin, p.id, { title, dueDate: ymd(1), assigneeId: admin.user.id });
  const listed = async () => JSON.stringify((await admin.api.get("/api/my-tasks")).json).includes(title);
  expect(await listed()).toBe(true);

  await admin.page.goto("/");
  await expect(admin.page.getByText(title)).toBeVisible();
  await admin.page.getByRole("button", { name: "By project" }).click();
  await expect(admin.page.getByRole("region", { name: p.name }).getByText(title)).toBeVisible();

  expect((await admin.api.post(`/api/projects/${p.id}/archive`)).status).toBeLessThan(300);
  expect(await listed()).toBe(false);
  await admin.page.reload();
  await expect(admin.page.getByText(title)).toHaveCount(0);
  await admin.page.getByRole("button", { name: "By date" }).click();
  await expect(admin.page.getByText(title)).toHaveCount(0);
});
