// Existing explicit staging roles; guarded synthetic local roles for release CI.
import { api, BASE_URL, expect, login, RUN, type Who } from "../support";
import { test as adminTest, local2691 } from "./2691-admin";
export const test = adminTest.extend<{ member: Who }>({
  member: async ({ admin, browser }, use) => {
    let email: string, password: string, createdId: string | undefined;
    if (local2691) {
      // The admin dependency already enforced loopback + sho_test database scope.
      const local = await import("../local-api");
      const person = await local.account(`ZZ-TEST2642 member ${RUN}`, `nakul17+zz-2642-${RUN}@aplyd.com`);
      email = person.email; password = local.PW; createdId = person.id;
      expect((await person.c.post("/api/auth/signout")).status).toBe(204);
    } else ({ email, password } = login("MEMBER"));
    const context = await browser.newContext({ baseURL: BASE_URL,
      httpCredentials: process.env.STAGING_USER ? { username: process.env.STAGING_USER, password: process.env.STAGING_PASS ?? "" } : undefined });
    try {
      const response = await context.request.post("/api/auth/signin", { data: { email, password } });
      expect(response.status()).toBe(200); const user = (await response.json()).user; expect(user.orgRole).toBe("MEMBER");
      await use({ page: await context.newPage(), api: api(context.request), user });
    } finally {
      try { if (createdId) expect((await admin.api.post(`/api/team/${createdId}/deactivate`, { reassign: "leaders" })).status).toBe(200); }
      finally { await context.close(); }
    }
  },
});
