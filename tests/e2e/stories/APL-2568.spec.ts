// SHO-US-14.9 Filters, sort and group on lists (APL-2568).
import { test, expect, zz, type Api } from "../support";
import { why } from "../helpers/jim-http";

const day = (n: number) => new Date(Date.now() + 5.5 * 3600_000 + n * 86400_000).toISOString().slice(0, 10);

async function seed(admin: { api: Api; user: Record<string, any> }, later: (f: () => Promise<unknown>) => void) {
  const r = await admin.api.post("/api/projects", { name: zz("filters"), leaderId: admin.user.id });
  expect(r.status).toBe(201);
  const id = r.json.project.id as string;
  later(() => admin.api.post(`/api/projects/${id}/archive`));
  const mk = async (title: string, dueDate: string | null, extra: object = {}) => {
    const t = await admin.api.post(`/api/projects/${id}/tasks`, { title, ...(dueDate ? { dueDate } : {}), ...extra });
    expect(t.status).toBe(201);
    return t.json.task.id as string;
  };
  const late = [await mk(zz("late-a"), day(-3)), await mk(zz("late-b"), day(-2)), await mk(zz("late-c"), day(-1))];
  const soon = await mk(zz("soon"), day(3));
  return { id, late, soon };
}

test("AC1: Filter then Overdue shows only overdue open tasks and the heading says '3 overdue'", async ({ admin, later }) => {
  const { id } = await seed(admin, later);
  const p = admin.page;
  await p.goto(`/projects/${id}`);
  await expect(p.getByText("3 overdue").first()).toBeVisible();
  await p.getByRole("button", { name: /^Filter/ }).click();
  await p.getByLabel("Overdue", { exact: true }).click(); // controlled by the URL, so no .check()
  await expect(p).toHaveURL(/f=overdue/);
  await expect(p.getByText(zz("late-a")).first()).toBeVisible();
  await expect(p.getByText(zz("late-c")).first()).toBeVisible();
  await expect(p.getByText(zz("soon"))).toHaveCount(0);
  await expect(p.getByText("3 overdue").first()).toBeVisible();
});

test("AC2: Group by assignee makes a section per person with a count, tasks keep their order", async ({ admin, later }) => {
  const { id } = await seed(admin, later);
  const p = admin.page;
  await p.goto(`/projects/${id}`);
  await p.getByLabel("Group by").selectOption("assignee");
  const sec = p.getByRole("region", { name: admin.user.name });
  await expect(sec).toBeVisible();
  await expect(sec.getByText(`${admin.user.name} · 4`)).toBeVisible();
  const text = await sec.innerText();
  const order = [zz("late-a"), zz("late-b"), zz("late-c"), zz("soon")].map((t) => text.indexOf(t));
  expect(order.every((i) => i >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
});

test("AC3: reloading or sharing the URL applies the same filters", async ({ admin, later }) => {
  const { id } = await seed(admin, later);
  const p = admin.page;
  await p.goto(`/projects/${id}?f=overdue&sort=priority`);
  await expect(p.getByText(zz("soon"))).toHaveCount(0);
  await expect(p.getByText(zz("late-b")).first()).toBeVisible();
  await p.reload();
  await expect(p).toHaveURL(/f=overdue/);
  await expect(p.getByText(zz("soon"))).toHaveCount(0);
  await expect(p.getByLabel("Sort")).toHaveValue("priority");
});

test("AC4: when nothing matches it says 'No tasks match' and Clear filters brings the list back", async ({ admin, later }) => {
  const { id } = await seed(admin, later);
  const p = admin.page;
  await p.goto(`/projects/${id}?f=nodate`); // every seeded task has a date
  await expect(p.getByText("No tasks match")).toBeVisible();
  await p.getByRole("button", { name: "Clear filters" }).first().click();
  await expect(p.getByText("No tasks match")).toHaveCount(0);
  await expect(p.getByText(zz("soon")).first()).toBeVisible();
});

test.skip("AC5: filtering 500 tasks responds within 300 ms", why(
  "Seeding 500 tasks on the shared staging server is too heavy, and a 300 ms budget cannot be separated from the network in a remote browser. Measure it on a prepared project locally.",
), () => {});
