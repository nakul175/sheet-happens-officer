import { readFileSync } from "node:fs";
// SHO-US-12.6 Pipeline board (APL-2542).
// One test per acceptance criterion; AC2 and AC3 are in APL-2542-totals.spec.ts, which runs serially. ZZ-TEST deals and organisations are archived afterwards.
// The plain Member is the second person for "who can see this" and "only my deals".
// Negotiation requires value and currency (APL-2739); AC5 also checks that gate.
import { test, expect, zz } from "../support";
import { newTask, ymd } from "../g2";
import { dealsOf, dropDeal, makeDeal, pipelines } from "../helpers/deal-board";

test("AC1: active stages are columns, On hold / Won / Lost share the last one, and a drop there asks which stage, a reason, and refuses Won while tasks are open", async ({ admin, later }) => {
  test.setTimeout(180_000);
  const d = await makeDeal(admin, later, { label: "columns", step: zz("open step") });
  await admin.page.setViewportSize({ width: 1400, height: 900 });
  await admin.page.goto("/deals");
  const board = admin.page.getByRole("region", { name: /^Deal board(?: —|$)/ }).filter({ has: admin.page.getByRole("button", { name: `Move ${d.name}`, exact: true }) });
  await expect(board.getByRole("region", { name: /^Lead(?: —|$)/ })).toBeVisible();
  await expect(board.locator(".dcol header b")).toHaveText(["Lead", "Conversation", "Concept note", "Proposal", "Negotiation", "On hold / Won / Lost"]);

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

test("AC4: Bid cards are ordered by submission deadline, with no deadline last, and a passed deadline is flagged", async ({ admin, later }) => {
  test.setTimeout(120_000);
  const pipes = await pipelines(admin.api);
  const passed = await makeDeal(admin, later, { label: "passed", pipe: pipes.bid, deadline: ymd(-1) });
  const future = await makeDeal(admin, later, { label: "future", pipe: pipes.bid, deadline: ymd(20) });
  const none = await makeDeal(admin, later, { label: "nodeadline", pipe: pipes.bid, deadline: ymd(12) });
  expect((await admin.api.patch(`/api/projects/${none.id}/deal`, { submissionDeadline: null })).status).toBe(200);

  await admin.page.goto("/deals");
  await admin.page.getByRole("tab", { name: "Bid" }).click();
  const col = admin.page.getByRole("region", { name: "Leads" });
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
  const negotiation = d.pipe.stages.find((s) => s.name === "Negotiation")!;
  expect(negotiation.requiredFields).toEqual(["value", "currency"]);
  const missing = await admin.api.post(`/api/projects/${d.id}/stage`, { stageId: negotiation.id });
  expect(missing.status).toBe(409);
  expect(missing.json.needsFields).toContain("value");

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

  expect((await member.api.post(`/api/tasks/${taskId}/complete`, { expectedUpdatedAt: (await member.api.get(`/api/tasks/${taskId}`)).json.task.updatedAt })).status).toBe(200);
  expect(await mine(), "a completed task no longer keeps the deal in Only my deals").not.toContain(held.id);
  expect(await mine()).toContain(led.id);
});

test("AC7: on a wide pipeline the board scrolls inside itself", async ({ admin }) => {
  await admin.page.setViewportSize({ width: 1280, height: 800 });
  await admin.page.goto("/deals");
  const boards = admin.page.getByRole("region", { name: /^Deal board(?: —|$)/ });
  await expect(boards.first()).toBeVisible();
  for (const board of await boards.all()) {
    await expect(board).toBeVisible();
    const box = await board.evaluate((el) => ({ overflowX: getComputedStyle(el).overflowX, scrolls: el.scrollWidth > el.clientWidth + 1 }));
    expect(box.overflowX).toBe("auto");
    expect(box.scrolls, "the columns are wider than the board, so the board is the scroller").toBe(true);
  }
});

test("AC8: at 700 px and below the columns stack, and just above that they stay in a row", async ({ admin }) => {
  test.setTimeout(120_000);
  await admin.page.goto("/deals");
  const boards = admin.page.getByRole("region", { name: /^Deal board(?: —|$)/ });
  await expect(boards.first()).toBeVisible();
  for (const board of await boards.all()) {
    const layout = () => board.evaluate((el) => {
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
      await expect(board.getByRole("region", { name: /^Lead(?: —|$)/ })).toBeVisible();
      await expect(board.getByRole("region", { name: /^On hold \/ Won \/ Lost(?: —|$)/ })).toBeVisible();
    }
  }
});


test("Opportunity groups have distinct board and stage landmarks", async ({ admin, later }) => {
  const classified = await makeDeal(admin, later, { label: "classified landmarks" });
  const other = await makeDeal(admin, later, { label: "unclassified landmarks" });
  expect((await admin.api.patch(`/api/projects/${classified.id}/deal`, { opportunityType: "RFP_RFA" })).status).toBe(200);
  await admin.page.goto("/deals");
  for (const name of [classified.name, other.name]) await expect(admin.page.getByRole("button", { name: `Move ${name}`, exact: true })).toBeVisible();
  const boards = admin.page.getByRole("region", { name: /^Deal board —/ });
  expect(await boards.count()).toBeGreaterThanOrEqual(2);
  const names = await boards.evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-label")));
  expect(new Set(names).size).toBe(names.length);
  await admin.page.addScriptTag({ content: readFileSync("node_modules/axe-core/axe.min.js", "utf8") });
  for (const width of [1280, 390]) {
    await admin.page.setViewportSize({ width, height: 900 });
    const violations = await admin.page.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- axe is injected into this browser page.
      const result = await (window as any).axe.run(document, { runOnly: { type: "rule", values: ["landmark-unique"] } });
      return result.violations;
    });
    expect(violations).toEqual([]);
  }
});
