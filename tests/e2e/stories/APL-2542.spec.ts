// SHO-US-12.6 Pipeline board (APL-2542).
// One test per acceptance criterion. ZZ-TEST deals and organisations are archived afterwards.
// The plain Member is the second person for "who can see this" and "only my deals".
// No stage in the seeded pipelines has required fields, and stages cannot be edited (APL-2528 AC3), so AC5
// checks the reason and open-task gates and records that the required-field list is empty.
import { test, expect, zz, type Api } from "../support";
import { newTask, ymd, type Who } from "../g2";
import type { Page } from "@playwright/test";

type Later = (fn: () => Promise<unknown>) => void;
type Stage = { id: string; name: string; category: string; needsReason: boolean; requiredFields: string[] };
type Pipe = { id: string; key: string; name: string; stages: Stage[] };
type Deal = {
  id: string; name: string; archived: boolean; value: number | null; currency: string | null;
  stage: { id: string; name: string; category: string } | null; submissionDeadline: string | null;
  nextStep: { id: string; title: string } | null;
};

async function pipelines(api: Api) {
  const r = await api.get("/api/deals/pipelines");
  expect(r.status).toBe(200);
  const list = r.json.pipelines as Pipe[];
  return { pro: list.find((p) => p.key === "DEAL_PROACTIVE")!, bid: list.find((p) => p.key === "DEAL_BID")! };
}

async function makeDeal(admin: Who, later: Later, o: {
  label: string; leaderId?: string; pipe?: Pipe; due?: string; step?: string; deadline?: string;
  value?: number; currency?: "INR" | "USD" | "EUR";
}) {
  const org = await admin.api.post("/api/orgs", { name: zz(`org ${o.label}`) });
  expect(org.status, JSON.stringify(org.json)).toBe(201);
  const orgId = org.json.organisation.id as string;
  later(() => admin.api.post(`/api/orgs/${orgId}/archive`, { archive: true }));
  const pipes = await pipelines(admin.api);
  const pipe = o.pipe ?? pipes.pro;
  const step = o.step ?? zz(`step ${o.label}`);
  const name = zz(`deal ${o.label}`);
  const body: Record<string, unknown> = {
    name, organisationId: orgId, pipelineId: pipe.id, leaderId: o.leaderId ?? admin.user.id, whyPursue: "ZZ-TEST fit",
    nextStep: { title: step, dueDate: o.due ?? ymd(5) },
  };
  if (pipe.key === "DEAL_BID") body.submissionDeadline = o.deadline ?? ymd(14);
  if (o.value !== undefined) { body.value = o.value; body.currency = o.currency; }
  const d = await admin.api.post("/api/deals", body);
  expect(d.status, JSON.stringify(d.json)).toBe(201);
  const id = d.json.deal.id as string;
  later(() => admin.api.post(`/api/projects/${id}/archive`));
  return { id, name, step, pipe };
}

const dealsOf = async (api: Api, pipeId: string, extra = "") =>
  (await api.get(`/api/deals?pipelineId=${pipeId}${extra}`)).json.deals as Deal[];

/** The board reads text/deal from the drop. A real drag is simulated with one DataTransfer, which is what the card writes in dragstart. */
async function dropDeal(page: Page, dealName: string, column: string) {
  await page.locator(".dcard", { hasText: dealName }).scrollIntoViewIfNeeded();
  await page.getByRole("region", { name: column }).scrollIntoViewIfNeeded();
  await page.evaluate(({ dealName, column }) => {
    const card = [...document.querySelectorAll(".dcard")].find((el) => (el.textContent ?? "").includes(dealName));
    const col = [...document.querySelectorAll(".dcol")].find((el) => el.getAttribute("aria-label") === column);
    if (!card || !col) throw new Error(`missing ${card ? "column" : "card"} for ${dealName} -> ${column}`);
    const dataTransfer = new DataTransfer();
    card.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer }));
    col.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer }));
    col.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
  }, { dealName, column });
}

test("AC1: active stages are columns, On hold / Won / Lost share the last one, and a drop there asks which stage, a reason, and refuses Won while tasks are open", async ({ admin, later }) => {
  test.setTimeout(180_000);
  const d = await makeDeal(admin, later, { label: "columns", step: zz("open step") });
  await admin.page.setViewportSize({ width: 1400, height: 900 });
  await admin.page.goto("/deals");
  await expect(admin.page.getByRole("region", { name: "Lead" })).toBeVisible();
  await expect(admin.page.locator(".dcol header b")).toHaveText(["Lead", "Conversation", "Concept note", "Proposal", "Negotiation", "On hold / Won / Lost"]);

  await dropDeal(admin.page, d.name, "On hold / Won / Lost");
  const which = admin.page.getByRole("dialog", { name: "Move to which stage?" });
  await expect(which).toBeVisible();
  await expect(which.getByRole("button", { name: "On hold" })).toBeVisible();
  await expect(which.getByRole("button", { name: "Won" })).toBeVisible();
  await expect(which.getByRole("button", { name: "Lost" })).toBeVisible();

  await which.getByRole("button", { name: "On hold" }).click();
  let move = admin.page.getByRole("dialog", { name: "Move to On hold" });
  await expect(move.getByLabel("Reason (required)")).toBeVisible();
  await expect(move.getByRole("button", { name: "Move deal" })).toBeDisabled();
  await move.getByRole("button", { name: "Cancel" }).click();

  await dropDeal(admin.page, d.name, "On hold / Won / Lost");
  await which.getByRole("button", { name: "Lost" }).click();
  move = admin.page.getByRole("dialog", { name: "Move to Lost" });
  await expect(move.getByLabel("Reason (required)")).toBeVisible();
  await move.getByRole("button", { name: "Cancel" }).click();

  await dropDeal(admin.page, d.name, "On hold / Won / Lost");
  await which.getByRole("button", { name: "Won" }).click();
  move = admin.page.getByRole("dialog", { name: "Move to Won" });
  await move.getByRole("button", { name: "Move deal" }).click();
  await expect(move.getByRole("alert")).toContainText(d.step);
  await expect(move.getByRole("link", { name: d.step })).toBeVisible();
  const still = (await dealsOf(admin.api, d.pipe.id)).find((x) => x.id === d.id)!;
  expect(still.stage?.name, "the refused move leaves the deal where it was").toBe("Lead");
});

test("AC2: a person only sees and counts deals they belong to, and an archived deal is not on the board", async ({ admin, member, later }) => {
  test.setTimeout(180_000);
  const d = await makeDeal(admin, later, { label: "hidden" });
  const memberDeals = async (extra = "") => dealsOf(member.api, d.pipe.id, extra);
  expect((await memberDeals()).some((x) => x.id === d.id), "not a member, so not in the list the board counts").toBe(false);
  expect((await dealsOf(admin.api, d.pipe.id)).some((x) => x.id === d.id)).toBe(true);

  await member.page.goto("/deals");
  await expect(member.page.getByRole("region", { name: "Lead" })).toBeVisible();
  await expect(member.page.getByText(d.name)).toHaveCount(0);
  const memberLead = (await memberDeals()).filter((x) => x.stage?.name === "Lead");
  await expect(member.page.getByRole("region", { name: "Lead" }).locator("header .chip")).toHaveText(String(memberLead.length));

  await admin.page.goto("/deals");
  await expect(admin.page.locator(".dcard", { hasText: d.name })).toBeVisible();
  const adminLead = (await dealsOf(admin.api, d.pipe.id)).filter((x) => x.stage?.name === "Lead");
  await expect(admin.page.getByRole("region", { name: "Lead" }).locator("header .chip")).toHaveText(String(adminLead.length));

  expect((await admin.api.post(`/api/projects/${d.id}/members`, { userId: member.user.id, role: "VIEWER" })).status).toBe(201);
  expect((await memberDeals()).some((x) => x.id === d.id)).toBe(true);
  await member.page.reload();
  await expect(member.page.locator(".dcard", { hasText: d.name })).toBeVisible();

  expect((await admin.api.post(`/api/projects/${d.id}/archive`)).status).toBeLessThan(300);
  expect((await dealsOf(admin.api, d.pipe.id)).some((x) => x.id === d.id)).toBe(false);
  expect((await dealsOf(admin.api, d.pipe.id, "&archived=true")).some((x) => x.id === d.id)).toBe(true);
  await admin.page.reload();
  await expect(admin.page.locator(".dcard", { hasText: d.name })).toHaveCount(0);
  await member.page.reload();
  await expect(member.page.locator(".dcard", { hasText: d.name })).toHaveCount(0);
});

test("AC3: each column shows its count, the sum of known values per currency, and how many have no value", async ({ admin, later }) => {
  test.setTimeout(120_000);
  await makeDeal(admin, later, { label: "inr", value: 1000, currency: "INR" });
  await makeDeal(admin, later, { label: "usd", value: 50, currency: "USD" });
  const unknown = await makeDeal(admin, later, { label: "unknown" });
  const pipes = await pipelines(admin.api);
  await admin.page.setViewportSize({ width: 1400, height: 900 });
  await admin.page.goto("/deals");
  await expect(admin.page.getByRole("region", { name: "Lead" })).toBeVisible();
  // Read the list the board just rendered, so the header is checked against the same deals.
  const deals = await dealsOf(admin.api, pipes.pro.id);
  const row = deals.find((d) => d.id === unknown.id)!;
  expect(row.value, "unknown stays null and is never stored as zero").toBeNull();

  const isTail = (c: string) => c === "PAUSED" || c === "DONE" || c === "LOST";
  const cols = pipes.pro.stages.filter((s) => !isTail(s.category)).map((s) => ({ title: s.name, ids: [s.id] }));
  const tail = pipes.pro.stages.filter((s) => isTail(s.category));
  cols.push({ title: tail.map((s) => s.name).join(" / "), ids: tail.map((s) => s.id) });

  for (const col of cols) {
    const here = deals.filter((d) => d.stage && col.ids.includes(d.stage.id));
    for (const d of here) if (d.value !== null && d.currency) expect(d.value).toBeGreaterThan(0);
    // Format with the browser's en-IN so the string matches the header the page renders.
    const text = await admin.page.evaluate((rows: { value: number | null; currency: string | null }[]) => {
      const byCurrency = new Map<string, number>();
      let unknown = 0;
      for (const d of rows) {
        if (d.value === null || !d.currency) unknown++;
        else byCurrency.set(d.currency, (byCurrency.get(d.currency) ?? 0) + d.value);
      }
      const parts = [...byCurrency].map(([c, v]) => `${c} ${v.toLocaleString("en-IN")}`);
      return `${parts.length ? parts.join(" · ") : "No values"}${unknown ? ` · ${unknown} without value` : ""}`;
    }, here.map((d) => ({ value: d.value, currency: d.currency })));
    const region = admin.page.getByRole("region", { name: col.title });
    await expect(region.locator("header .chip")).toHaveText(String(here.length));
    await expect(region.locator("header .sub2")).toHaveText(text);
  }
});

test("AC4: Bid cards are ordered by submission deadline, with no deadline last, and a passed deadline is flagged", async ({ admin, later }) => {
  test.setTimeout(120_000);
  const pipes = await pipelines(admin.api);
  const passed = await makeDeal(admin, later, { label: "passed", pipe: pipes.bid, deadline: ymd(-1) });
  const future = await makeDeal(admin, later, { label: "future", pipe: pipes.bid, deadline: ymd(20) });
  const none = await makeDeal(admin, later, { label: "nodeadline", pipe: pipes.bid, deadline: ymd(12) });
  expect((await admin.api.patch(`/api/projects/${none.id}/deal`, { submissionDeadline: null })).status).toBe(200);

  await admin.page.goto("/deals");
  await admin.page.getByRole("tab", { name: "Bid" }).click();
  const col = admin.page.getByRole("region", { name: "Identified" });
  await expect(col.locator(".dcard", { hasText: passed.name })).toBeVisible();
  const titles = (await col.locator(".dcard b").allTextContents()).map((t) => t.trim());
  const at = (name: string) => titles.indexOf(name);
  expect(at(passed.name)).toBeGreaterThanOrEqual(0);
  expect(at(passed.name)).toBeLessThan(at(future.name));
  expect(at(future.name)).toBeLessThan(at(none.name));
  await expect(col.locator(".dcard", { hasText: passed.name })).toContainText("Deadline passed");
  await expect(col.locator(".dcard", { hasText: future.name })).toContainText("Submit by");
  await expect(col.locator(".dcard", { hasText: future.name })).not.toContainText("Deadline passed");
  await expect(col.locator(".dcard", { hasText: none.name })).not.toContainText("Deadline passed");
  await expect(col.locator(".dcard", { hasText: none.name })).not.toContainText("Submit by");
});

test("AC5: Move to… and a drop both follow the stage rules for reason and open tasks", async ({ admin, later }) => {
  test.setTimeout(180_000);
  const d = await makeDeal(admin, later, { label: "move", step: zz("still open") });
  const lost = d.pipe.stages.find((s) => s.name === "Lost")!;
  const noReason = await admin.api.post(`/api/projects/${d.id}/stage`, { stageId: lost.id });
  expect(noReason.status, "Lost needs a reason").toBe(400);
  const blocked = await admin.api.post(`/api/projects/${d.id}/stage`, { stageId: lost.id, reason: "ZZ-TEST lost" });
  expect(blocked.status).toBe(409);
  expect(JSON.stringify(blocked.json.tasks)).toContain(d.step);
  // Every seeded stage has an empty required-field list, so a move is not asked for extra fields. Nothing in the product edits that list.
  expect(d.pipe.stages.every((s) => Array.isArray(s.requiredFields) && s.requiredFields.length === 0)).toBe(true);

  await admin.page.setViewportSize({ width: 1400, height: 900 });
  await admin.page.goto("/deals");
  await expect(admin.page.locator(".dcard", { hasText: d.name })).toBeVisible();
  await dropDeal(admin.page, d.name, "Conversation");
  await expect.poll(async () => (await dealsOf(admin.api, d.pipe.id)).find((x) => x.id === d.id)?.stage?.name).toBe("Conversation");
  await expect(admin.page.getByRole("dialog")).toHaveCount(0);

  const card = admin.page.locator(".dcard", { hasText: d.name });
  await card.getByRole("button", { name: `Move ${d.name}` }).click();
  await admin.page.getByRole("menuitem", { name: "On hold" }).click();
  const holdDialog = admin.page.getByRole("dialog", { name: "Move to On hold" });
  await expect(holdDialog.getByRole("button", { name: "Move deal" })).toBeDisabled();
  await holdDialog.getByLabel("Reason (required)").fill("ZZ-TEST pause");
  await holdDialog.getByRole("button", { name: "Move deal" }).click();
  await expect.poll(async () => (await dealsOf(admin.api, d.pipe.id)).find((x) => x.id === d.id)?.stage?.name).toBe("On hold");

  await card.getByRole("button", { name: `Move ${d.name}` }).click();
  await admin.page.getByRole("menuitem", { name: "Won" }).click();
  const won = admin.page.getByRole("dialog", { name: "Move to Won" });
  await won.getByRole("button", { name: "Move deal" }).click();
  await expect(won.getByRole("alert")).toContainText(d.step);
  expect((await dealsOf(admin.api, d.pipe.id)).find((x) => x.id === d.id)?.stage?.name).toBe("On hold");
});

test("AC6: Only my deals keeps deals the person leads or holds an open assigned task in", async ({ admin, member, later }) => {
  test.setTimeout(180_000);
  const led = await makeDeal(admin, later, { label: "led", leaderId: member.user.id, step: zz("led step") });
  const held = await makeDeal(admin, later, { label: "held", step: zz("leader step") });
  expect((await admin.api.post(`/api/projects/${held.id}/members`, { userId: member.user.id, role: "EDITOR" })).status).toBe(201);
  const heldTask = zz("held task");
  const taskId = await newTask(admin, held.id, { title: heldTask, assigneeId: member.user.id, dueDate: ymd(2) });
  const other = await makeDeal(admin, later, { label: "other", step: zz("not mine") });
  expect((await admin.api.post(`/api/projects/${other.id}/members`, { userId: member.user.id, role: "EDITOR" })).status).toBe(201);

  const mine = async () => (await dealsOf(member.api, led.pipe.id, "&mine=true")).map((d) => d.id);
  expect(await mine()).toContain(led.id);
  expect(await mine()).toContain(held.id);
  expect(await mine()).not.toContain(other.id);
  const all = await dealsOf(member.api, led.pipe.id);
  expect(all.some((d) => d.id === other.id), "the same deal is visible when the filter is off").toBe(true);

  await member.page.goto("/deals");
  await member.page.getByRole("button", { name: "Only my deals" }).click();
  await expect(member.page.locator(".dcard", { hasText: led.name })).toBeVisible();
  await expect(member.page.locator(".dcard", { hasText: held.name })).toBeVisible();
  await expect(member.page.getByText(other.name)).toHaveCount(0);

  expect((await member.api.post(`/api/tasks/${taskId}/complete`, {})).status).toBe(200);
  expect(await mine(), "a completed task no longer keeps the deal in Only my deals").not.toContain(held.id);
  expect(await mine()).toContain(led.id);
});

test("AC7: on a wide pipeline the board scrolls inside itself", async ({ admin }) => {
  await admin.page.setViewportSize({ width: 1280, height: 800 });
  await admin.page.goto("/deals");
  const board = admin.page.locator(".dboard");
  await expect(board).toBeVisible();
  const box = await board.evaluate((el) => ({ overflowX: getComputedStyle(el).overflowX, scrolls: el.scrollWidth > el.clientWidth + 1 }));
  expect(box.overflowX).toBe("auto");
  expect(box.scrolls, "the columns are wider than the board, so the board is the scroller").toBe(true);
});

test("AC8: at 700 px and below the columns stack, and just above that they stay in a row", async ({ admin }) => {
  test.setTimeout(120_000);
  await admin.page.goto("/deals");
  await expect(admin.page.locator(".dboard")).toBeVisible();
  const layout = () => admin.page.locator(".dboard").evaluate((el) => {
    const cols = [...el.querySelectorAll(".dcol")].map((c) => c.getBoundingClientRect());
    const stacked = cols.length >= 2 && cols[1].top >= cols[0].bottom - 1;
    const row = cols.length >= 2 && Math.abs(cols[1].top - cols[0].top) < 2 && cols[1].left > cols[0].left;
    return { dir: getComputedStyle(el).flexDirection, stacked, row };
  });
  await admin.page.setViewportSize({ width: 701, height: 800 });
  await expect.poll(layout).toMatchObject({ dir: "row", row: true });
  for (const width of [700, 390]) {
    await admin.page.setViewportSize({ width, height: 800 });
    await expect.poll(layout, { timeout: 10_000 }).toMatchObject({ dir: "column", stacked: true });
    await expect(admin.page.getByRole("region", { name: "Lead" })).toBeVisible();
    await expect(admin.page.getByRole("region", { name: "On hold / Won / Lost" })).toBeVisible();
  }
});
