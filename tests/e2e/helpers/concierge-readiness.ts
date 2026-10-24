import { expect, type Locator } from "@playwright/test";

/** The landmark renders before async state. Wait for content before classifying an enabled/disabled panel. */
export async function settledConciergeContent(panel: Locator) {
  const quick = panel.getByRole("group", { name: "Quick actions" });
  const disabled = panel.locator(".cc-disabled");
  // The group itself can render while loading, with disabled buttons. It is not a ready signal.
  await expect(quick.locator("button:enabled").first().or(disabled).first()).toBeVisible();
  if (await disabled.isVisible()) return { kind: "disabled" as const, reason: (await disabled.innerText()).trim() };
  return { kind: "ready" as const, quick };
}
