import { test, expect } from "../support";

for (const width of [1512, 390, 320]) {
  test(`SHO-3136 branding preserves shell layout and Home link at ${width}px`, async ({ admin }) => {
    await admin.page.setViewportSize({ width, height: 900 });
    for (const route of ["/", "/my-tasks", "/projects"]) {
      await admin.page.goto(route);
      const brand = admin.page.locator(".top-brand");
      await expect(brand).toHaveAccessibleName("SHO, Sheet Happens Officer home");
      await expect(brand).toHaveAttribute("href", "/");
      const image = brand.locator("img");
      await expect(image).toHaveAttribute("alt", "");
      expect(await image.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
      const box = await brand.boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(await admin.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await brand.focus();
      expect(await brand.evaluate(el => getComputedStyle(el).outlineStyle)).not.toBe("none");
      if (width < 600) await expect(brand.locator(".wordmark-full")).toBeHidden();
    }
    await admin.page.getByRole("button", { name: /^Account and utilities,/ }).click();
    await expect(admin.page.locator(".account-options")).toBeVisible();
    expect(await admin.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await admin.page.keyboard.press("Escape");
    await admin.page.screenshot({ path: test.info().outputPath(`brand-${width}.png`), fullPage: true });
  });

  test(`SHO-3136 public branding loads without overflow at ${width}px`, async ({ anon }) => {
    await anon.setViewportSize({ width, height: 900 });
    for (const route of ["/signin", "/signup", "/forgot", "/reset", "/verify", "/offline"]) {
      await anon.goto(route);
      const marks = anon.locator('img[src^="/logo-"]:visible');
      expect(await marks.count()).toBeGreaterThan(0);
      for (const mark of await marks.all()) {
        expect(await mark.evaluate(img => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0)).toBe(true);
      }
      expect(await anon.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await anon.screenshot({ path: test.info().outputPath(`${route.slice(1)}-${width}.png`), fullPage: true });
    }
  });
}
