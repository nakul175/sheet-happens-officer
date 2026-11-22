import { expect, test } from "@playwright/test";

test("Tasks sign-in renders with the approved Lato font", async ({ page }) => {
  await page.goto("/signin");
  await expect(page).toHaveTitle(/Sign in · Tasks by aplyd/);
  await expect(page.getByRole("main")).toContainText("Tasks by aplyd");

  const fontAsset = await page.request.get("/fonts/Lato-Regular.ttf");
  expect(fontAsset.status()).toBe(200);
  await page.evaluate(() => document.fonts.ready);
  const renderedFont = await page.getByRole("main").evaluate((element) => getComputedStyle(element).fontFamily);
  expect(renderedFont).toMatch(/^Lato\b/i);
  expect(await page.evaluate(() => document.fonts.check("16px Lato"))).toBe(true);
});
