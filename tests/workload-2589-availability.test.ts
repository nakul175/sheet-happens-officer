import { expect, it } from "vitest";
import { BASE, superAdmin } from "./helpers";
import { workloadEnabled } from "../src/lib/workload";

it("the configured Workload flag controls the actual API, page and Team entry", async () => {
  if (new URL(BASE).hostname !== "localhost") throw new Error("Workload availability acceptance requires localhost.");
  const root = await superAdmin();
  const enabled = workloadEnabled();
  const api = await root.c.get("/api/workload");
  expect(api.status).toBe(enabled ? 200 : 404);
  const page = await root.c.get("/workload");
  expect(page.status).toBe(enabled ? 200 : 404);
  const team = await root.c.get("/team");
  expect(team.status).toBe(200);
  const response = await fetch(`${BASE}/team`, { headers: { cookie: root.c.cookie } });
  expect(/<a\b[^>]*\bhref="\/workload"/.test(await response.text())).toBe(enabled);
});
