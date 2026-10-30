import { test, expect } from "../support";

test.describe("SHO-3137 retired in-app assistant", () => {
  test.setTimeout(120_000);

  for (const width of [1512, 390, 320]) {
    test(`task shell remains usable without assistant controls at ${width}px`, async ({ admin, member }) => {
      for (const who of [admin, member]) {
        await who.page.setViewportSize({ width, height: 900 });
        for (const path of ["/", "/my-tasks", "/projects", "/profile"]) {
          await who.page.goto(path);
          await expect(who.page.locator("main#main")).toBeVisible();
          await expect(who.page.getByRole("button", { name: /concierge|show assistant/i })).toHaveCount(0);
          await expect(who.page.locator(".with-dock,.with-bar,.cc-sheet,.cc-host,.cc-fabwrap")).toHaveCount(0);
          expect(await who.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
        }
      }
    });
  }

  test("authenticated retired routes are 404 while normal product routes still answer", async ({ admin, member }) => {
    for (const who of [admin, member]) {
      for (const path of ["/api/concierge/state", "/api/concierge/messages", "/api/usage"]) {
        expect((await who.api.get(path)).status, path).toBe(404);
      }
      expect((await who.api.post("/api/concierge/messages", { text: "ZZ-TEST must not create a task" })).status).toBe(404);
      expect((await who.api.patch("/api/concierge/preferences", { hidden: false })).status).toBe(404);
      expect((await who.api.get("/api/my-tasks")).status).toBe(200);
      expect((await who.api.get("/api/projects")).status).toBe(200);
    }
  });
});
