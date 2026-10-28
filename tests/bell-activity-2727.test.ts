// SHO-2727: real projectAccess, real Activity reads; fixtures and cleanup use only the local HTTP API.
import { afterAll, beforeAll, expect, it } from "vitest";
import { projectActivity } from "@/lib/feed";
import { account, BASE, istDate, superAdmin, task, type Account } from "./helpers";
const previous = process.env.CRM_VISIBLE;
const run = `${Date.now().toString(36)}-${process.pid}`;
let root: Account, worker: Account;
let dealId = "", orgId = "";
beforeAll(async () => {
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(BASE).hostname) || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid").hostname)) throw new Error("SHO-2727 Activity fixture requires local API and database");
  root = await superAdmin();
  worker = await account("ZZ-TEST 2727 Activity worker", `nakul17+zz-2727-${run}-worker@aplyd.com`);
  const org = await root.c.post("/api/orgs", { name: `ZZ-TEST 2727 Activity org ${run}` }); expect(org.status).toBe(201); orgId = org.json.organisation.id;
  const pipes = await root.c.get("/api/deals/pipelines");
  const pipe = (pipes.json.pipelines as { id: string; key: string }[]).find(p => p.key === "DEAL_PROACTIVE"); expect(pipe).toBeDefined();
  const made = await root.c.post("/api/deals", { name: `ZZ-TEST 2727 private Activity deal ${run}`, organisationId: orgId, pipelineId: pipe!.id, leaderId: root.id, whyPursue: "ZZ-TEST Activity access", nextStep: { title: `ZZ-TEST 2727 next step ${run}`, dueDate: istDate(14) } });
  expect(made.status).toBe(201); dealId = made.json.deal.id;
  expect((await root.c.post(`/api/projects/${dealId}/members`, { userId: worker.id, role: "EDITOR" })).status).toBe(201);
  await task(root, dealId, { title: `ZZ-TEST 2727 held task ${run}`, assigneeId: worker.id });
});
afterAll(async () => {
  if (previous === undefined) delete process.env.CRM_VISIBLE; else process.env.CRM_VISIBLE = previous;
  const failures: string[] = [];
  for (const path of [dealId ? `/api/projects/${dealId}/archive` : "", worker ? `/api/team/${worker.id}/deactivate` : "", orgId ? `/api/orgs/${orgId}/archive` : ""].filter(Boolean)) {
    try {
      const body = path.includes("/deactivate") ? { reassign: "leaders" } : path.includes("/orgs/") ? { archive: true } : {};
      const r = await root.c.post(path, body); if (r.status !== 200) failures.push(`cleanup status ${r.status}`);
    } catch { failures.push("cleanup request failed"); }
  }
  expect(failures).toEqual([]);
});
it("qa:TC missing SHO-2727: a real member can read their deal Activity only while CRM is visible", async () => {
  process.env.CRM_VISIBLE = "all";
  const visible = await projectActivity({ id: worker.id, orgRole: "MEMBER" }, dealId);
  expect(visible.items.length).toBeGreaterThan(0);
  for (const mode of ["off", "admins"]) {
    process.env.CRM_VISIBLE = mode;
    await expect(projectActivity({ id: worker.id, orgRole: "MEMBER" }, dealId)).rejects.toMatchObject({ status: 404 });
  }
});
