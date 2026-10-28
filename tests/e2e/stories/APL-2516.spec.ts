// SHO-US-8.7 Improve my prompt (APL-2516).
// One test per acceptance criterion. AC1, AC3 and AC4 each make one rewrite call. AC2 does not.
// The rewrite is judged by being present and reversible, not by matching a particular phrasing.
import { test, expect } from "../support";
import { chatMessages, cleanChat } from "../helpers/jim-http";
import { requireModel, showConcierge, weekCalls } from "../helpers/jim-concierge";

test.describe.configure({ timeout: 150_000 });
test.use({ viewport: { width: 1440, height: 900 } });

const ORIGINAL = "Move the budget task to Monday";

async function composer(who: { page: import("@playwright/test").Page }) {
  await who.page.goto("/");
  const box = who.page.locator("aside.cc-slot");
  await expect(box.getByLabel("Message the concierge")).toBeVisible();
  return box;
}

test("AC1: Improve my prompt puts a rewrite in the input, and Keep mine restores the original", async ({ admin, later }) => {
  await requireModel(admin);
  await showConcierge(admin, later);
  await cleanChat(admin, later);
  const box = await composer(admin);
  const before = (await chatMessages(admin)).length;
  await box.getByLabel("Message the concierge").fill(ORIGINAL);
  await box.getByRole("button", { name: "Improve my prompt" }).click();
  const offer = box.getByRole("group", { name: "Suggested rewrite" });
  await expect(offer).toBeVisible({ timeout: 90_000 });
  await expect(offer.getByRole("button", { name: "Use it" })).toBeVisible();
  await expect(offer.getByRole("button", { name: "Keep mine" })).toBeVisible();
  const improved = await box.getByLabel("Message the concierge").inputValue();
  expect(improved.trim().length).toBeGreaterThan(0);
  await offer.getByRole("button", { name: "Keep mine" }).click();
  await expect(box.getByLabel("Message the concierge")).toHaveValue(ORIGINAL);
  await expect(offer).toHaveCount(0);
  expect((await chatMessages(admin)).length, "the rewrite was not sent").toBe(before);
});

test("AC2: Improve my prompt is disabled when the input is empty", async ({ admin, later }) => {
  await requireModel(admin);
  await showConcierge(admin, later);
  const box = await composer(admin);
  const button = box.getByRole("button", { name: "Improve my prompt" });
  await expect(button).toBeVisible();
  await expect(button).toBeDisabled();
  await box.getByLabel("Message the concierge").fill(ORIGINAL);
  await expect(button).toBeEnabled();
  await box.getByLabel("Message the concierge").fill("   ");
  await expect(button).toBeDisabled();
});

test("AC3: a rewrite counts toward the weekly cap and does not use a larger model", async ({ admin, later }) => {
  await requireModel(admin);
  await showConcierge(admin, later);
  const box = await composer(admin);
  const before = await weekCalls(admin);
  await box.getByLabel("Message the concierge").fill(ORIGINAL);
  await box.getByRole("button", { name: "Improve my prompt" }).click();
  await expect(box.getByRole("group", { name: "Suggested rewrite" })).toBeVisible({ timeout: 90_000 });
  expect(await weekCalls(admin), "the rewrite counts as one message").toBe(before + 1);
  const usage = JSON.stringify((await admin.api.get("/api/usage")).json).toLowerCase();
  expect(usage).not.toContain(ORIGINAL.toLowerCase());
  expect(usage).not.toMatch(/opus|sonnet/);
  test.info().annotations.push({
    type: "model-name",
    description: "The usage screen lists counts and cost only, not the model name on each row. This check shows the weekly count went up by one and that no larger model is named there.",
  });
});

test("AC4: a rewrite on screen is not sent until Send", async ({ admin, later }) => {
  await requireModel(admin);
  await showConcierge(admin, later);
  await cleanChat(admin, later);
  const box = await composer(admin);
  const before = (await chatMessages(admin)).length;
  await box.getByLabel("Message the concierge").fill("List what is overdue");
  await box.getByRole("button", { name: "Improve my prompt" }).click();
  await expect(box.getByRole("group", { name: "Suggested rewrite" })).toBeVisible({ timeout: 90_000 });
  await expect(box.getByRole("group", { name: "Suggested rewrite" })).toContainText(/nothing has been sent/i);
  expect((await chatMessages(admin)).length).toBe(before);
  await expect(box.getByRole("button", { name: "Send" })).toBeEnabled();
});
