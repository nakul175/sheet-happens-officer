import { existsSync } from "node:fs";
import { expect, it } from "vitest";
import { chromium } from "playwright-core";
import { BASE, PW, superAdmin } from "./helpers";
import { workloadEnabled } from "../src/lib/workload";

it("the configured Workload flag controls the actual API, page and Team entry", async () => {
  if (new URL(BASE).hostname !== "localhost") throw new Error("Workload availability acceptance requires localhost.");
  const root = await superAdmin();
  const enabled = workloadEnabled();
  const api = await root.c.get("/api/workload");
  expect(api.status).toBe(enabled ? 200 : 404);
  const paths = [process.env.PW_CHROMIUM, "/usr/bin/google-chrome", "/usr/bin/chromium"].filter((p): p is string => !!p);
  const browser = await chromium.launch({ executablePath: paths.find(p => existsSync(p)), args: ["--no-sandbox"] });
  const context = await browser.newContext({ baseURL: BASE });
  try {
    expect((await context.request.post("/api/auth/signin", { data: { email: root.email, password: PW } })).ok()).toBe(true);
    const page = await context.newPage();
    const requests: string[] = [];
    page.on("request", request => requests.push(new URL(request.url()).pathname));
    const response = await page.goto("/workload", { waitUntil: "load" });
    if (enabled) {
      expect(response?.status()).toBe(200);
      await page.getByRole("heading", { name: "Workload", exact: true }).waitFor({ state: "visible" });
      await page.locator(".workload-table").waitFor({ state: "visible" });
    } else {
      // Next.js streams notFound() with 200 once Suspense has flushed headers.
      // https://nextjs.org/docs/app/api-reference/file-conventions/not-found
      // Verify the rendered refusal, rather than mistaking an HTTP 200 for feature access.
      expect([200, 404]).toContain(response?.status());
      await page.getByRole("heading", { name: "404", exact: true }).waitFor({ state: "visible" });
      expect(await page.getByRole("heading", { name: "Workload", exact: true }).count()).toBe(0);
      expect(await page.locator(".workload-page").count()).toBe(0);
      expect(await page.locator('meta[name="robots"][content="noindex"]').count()).toBeGreaterThan(0);
      expect(requests).not.toContain("/api/workload");
    }
    expect((await page.goto("/team", { waitUntil: "load" }))?.ok()).toBe(true);
    await page.getByRole("heading", { name: "Team", exact: true }).waitFor({ state: "visible" });
    expect(await page.getByRole("link", { name: "Workload", exact: true }).count()).toBe(enabled ? 1 : 0);
  } finally { await context.close(); await browser.close(); }
}, 60000);
