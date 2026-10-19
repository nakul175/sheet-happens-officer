import type { Locator, Page } from "@playwright/test";

/**
 * Clicks a control the way a phone user would. The sheet is scrolled to the end, and if the
 * Main tab bar still covers the centre, the click lands on the part of the control that is clear.
 * Never uses force.
 */
export async function clickAboveTabBar(button: Locator) {
  const page = button.page();
  // The Main tab bar exists only under 600px. On a wider screen it is hidden, and a plain click reaches the control.
  if ((page.viewportSize()?.width ?? 1280) >= 600) {
    await button.click();
    return;
  }
  await button.scrollIntoViewIfNeeded();
  await button.evaluate((el) => {
    let node = el.parentElement;
    while (node) {
      const style = getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 2) {
        node.scrollTop = node.scrollHeight;
        return;
      }
      node = node.parentElement;
    }
  });
  const bar = page.getByRole("navigation", { name: "Main" });
  const box = await button.boundingBox();
  const barBox = await bar.boundingBox();
  if (box && barBox && box.y < barBox.y && box.y + box.height > barBox.y) {
    const y = Math.max(2, Math.floor(barBox.y - box.y) - 4);
    await button.click({ position: { x: Math.round(box.width / 2), y } });
    return;
  }
  await button.click();
}

/**
 * One Activity row. The sentence is the innermost text; Undo and "Too old to undo" sit two levels up.
 */
export function activityRow(page: Page, text: string | RegExp, also?: string | RegExp): Locator {
  let sentence = page.getByRole("main").getByText(text);
  if (also) sentence = sentence.filter({ hasText: also });
  return sentence.locator("..").locator("..");
}
