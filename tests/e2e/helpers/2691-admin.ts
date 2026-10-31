// Local CI self-provisions only in a guarded synthetic database. Explicit staging
// keeps the existing credential contract; production is refused by support/base-url.
import { api, BASE_URL, expect, login, type Who } from "../support";
import { test as strictTest } from "../stories/qa";
export const local2691 = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(BASE_URL).hostname);
export const test = strictTest.extend<{ admin: Who }>({
  admin: async ({ browser }, use) => {
    let email: string, password: string;
    if (local2691) {
      const database = new URL(process.env.DATABASE_URL ?? "");
      if (!["localhost", "127.0.0.1", "[::1]"].includes(database.hostname) || !/^\/sho_test(?:_[\w-]+)?$/.test(database.pathname) || process.env.TASKBOARD_URL !== BASE_URL)
        throw new Error("Use one loopback app and synthetic sho_test database for APL-2691 local provisioning.");
      const local = await import("../local-api");
      const root = await local.superAdmin(); email = root.email; password = local.PW;
      expect((await root.c.post("/api/auth/signout")).status).toBe(204);
    } else ({ email, password } = login("ADMIN"));
    const context = await browser.newContext({ baseURL: BASE_URL,
      httpCredentials: process.env.STAGING_USER ? { username: process.env.STAGING_USER, password: process.env.STAGING_PASS ?? "" } : undefined });
    try {
      const response = await context.request.post("/api/auth/signin", { data: { email, password } });
      expect(response.status()).toBe(200); const user = (await response.json()).user;
      expect(user.orgRole).toBe("SUPER_ADMIN");
      await use({ page: await context.newPage(), api: api(context.request), user });
    } finally {
      try { expect((await context.request.post("/api/auth/signout")).status()).toBe(204); }
      finally { await context.close(); }
    }
  },
});
