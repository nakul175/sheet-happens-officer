// SHO-3054 API acceptance uses only an isolated local app/DB and synthetic owned fixtures.
import { afterAll, beforeAll, expect, it } from "vitest";
import { account, BASE, cleanupZz, istDate, type Account } from "./helpers";
import { db } from "@/lib/db";
import { sendReminders } from "@/lib/jobs";
let owner: Account, viewer: Account, outsider: Account, org = "", pipeline = "", sequence = 0;
const projects: string[] = [];
const prefix = `ZZ-TEST 3054 ${Date.now()}`;
const input = () => ({ name: `${prefix} ${sequence++}`, organisationId: org, pipelineId: pipeline, leaderId: owner.id, whyPursue: "Deadline acceptance", nextStep: { title: "ZZ-TEST next", dueDate: istDate(3) }, submissionDeadline: "2026-11-01", submissionDeadlineTime: "17:30", submissionDeadlineZone: "Asia/Kolkata" });
async function create(extra: Record<string, unknown> = {}) {
  const r = await owner.c.post("/api/deals", { ...input(), ...extra });
  expect(r.status, JSON.stringify(r.json)).toBe(201); projects.push(r.json.deal.id); return r.json.deal.id as string;
}
const details = async (id: string) => (await owner.c.get(`/api/projects/${id}`)).json.project.deal.details;
beforeAll(async () => {
  expect(["localhost", "127.0.0.1", "[::1]"].includes(new URL(BASE).hostname)).toBe(true);
  expect(["127.0.0.1", "localhost", "[::1]"].includes(new URL(process.env.DATABASE_URL!).hostname)).toBe(true);
  expect(["/sho_test", "/sho_staging"].includes(new URL(process.env.DATABASE_URL!).pathname)).toBe(true);
  owner = await account("zz3054owner"); viewer = await account("zz3054viewer"); outsider = await account("zz3054outsider");
  const o = await owner.c.post("/api/orgs", { name: `${prefix} Buyer` }); expect(o.status).toBe(201); org = o.json.organisation.id;
  const pipes = (await owner.c.get("/api/deals/pipelines")).json.pipelines as { id: string; key: string }[];
  pipeline = pipes.find(p => p.key === "DEAL_BID")!.id;
}, 180000);
afterAll(async () => {
  if (owner) await cleanupZz(projects, [owner, viewer, outsider].filter(Boolean));
  if (org) { const sa = await import("./helpers").then(m => m.superAdmin()); expect((await sa.c.post(`/api/orgs/${org}/archive`, { archive: true })).status).toBe(200); }
}, 180000);
it("SHO-3054 AC1/2 requires new Bid time+zone and round-trips exact local and UTC values", async () => {
  for (const missing of ["submissionDeadlineTime", "submissionDeadlineZone"]) expect((await owner.c.post("/api/deals", { ...input(), [missing]: undefined })).status).toBe(400);
  const id = await create();
  expect(await details(id)).toMatchObject({ submissionDeadline: "2026-11-01", submissionDeadlineTime: "17:30", submissionDeadlineZone: "Asia/Kolkata", submissionDeadlineAt: "2026-11-01T12:00:00.000Z" });
  const row = (await owner.c.get(`/api/deals?pipelineId=${pipeline}`)).json.deals.find((d: { id: string }) => d.id === id);
  expect(row).toMatchObject({ submissionDeadlineTime: "17:30", submissionDeadlineZone: "Asia/Kolkata", submissionDeadlineAt: "2026-11-01T12:00:00.000Z" });
  expect(row.nextStep.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/); expect(row.nextStep.dueDate).toBe(istDate(3));
}, 120000);
it("SHO-3054 AC4 refuses DST gaps/fold ambiguity and preserves an explicitly chosen fold after reload/edit", async () => {
  const id = await create();
  expect((await owner.c.patch(`/api/projects/${id}/deal`, { submissionDeadline: "2026-03-08", submissionDeadlineTime: "02:30", submissionDeadlineZone: "America/New_York" })).status).toBe(400);
  const fold = { submissionDeadline: "2026-11-01", submissionDeadlineTime: "01:30", submissionDeadlineZone: "America/New_York" };
  const ambiguous = await owner.c.patch(`/api/projects/${id}/deal`, fold); expect(ambiguous.status).toBe(400); expect(ambiguous.json.deadlineChoices).toHaveLength(2);
  expect((await owner.c.patch(`/api/projects/${id}/deal`, { ...fold, submissionDeadlineChoice: "later" })).status).toBe(200);
  expect((await details(id)).submissionDeadlineAt).toBe("2026-11-01T06:30:00.000Z");
  expect((await owner.c.patch(`/api/projects/${id}/deal`, { ...fold, need: "Unrelated edit" })).status).toBe(200);
  expect((await details(id)).submissionDeadlineAt).toBe("2026-11-01T06:30:00.000Z");
  expect((await owner.c.patch(`/api/projects/${id}/deal`, { ...fold, submissionDeadlineChoice: "earlier" })).status).toBe(200);
  expect((await details(id)).submissionDeadlineAt).toBe("2026-11-01T05:30:00.000Z");
}, 120000);
it("SHO-3054 AC3/6 preserves a legacy date-only fixture and supports exact upgrade plus Undo", async () => {
  const id = await create();
  // Simulate the pre-migration shape on this test's own record only. No shared/production DB target is allowed.
  await db.dealDetails.update({ where: { projectId: id }, data: { submissionDeadlineAt: null, submissionDeadlineZone: null } });
  expect((await owner.c.patch(`/api/projects/${id}/deal`, { need: "Legacy untouched", submissionDeadline: "2026-11-01", submissionDeadlineTime: null, submissionDeadlineZone: null })).status).toBe(200);
  expect(await details(id)).toMatchObject({ submissionDeadline: "2026-11-01", submissionDeadlineAt: null, submissionDeadlineZone: null, submissionDeadlineTime: null });
  expect((await owner.c.patch(`/api/projects/${id}/deal`, { submissionDeadline: "2026-11-02" })).status).toBe(400);
  const upgraded = await owner.c.patch(`/api/projects/${id}/deal`, { submissionDeadlineTime: "09:00", submissionDeadlineZone: "Asia/Kolkata" });
  expect(upgraded.status).toBe(200); expect((await details(id)).submissionDeadlineAt).toBe("2026-11-01T03:30:00.000Z");
  expect((await owner.c.post(`/api/actions/${upgraded.headers.get("x-undo-id")}/undo`)).status).toBe(200);
  expect(await details(id)).toMatchObject({ submissionDeadline: "2026-11-01", submissionDeadlineAt: null, submissionDeadlineZone: null });
}, 120000);
it("SHO-3054 keeps existing member permissions and reminder timing, adding exact deadline context", async () => {
  const id = await create({ nextStep: { title: "ZZ-TEST due today", dueDate: istDate(0) } });
  expect((await owner.c.post(`/api/projects/${id}/members`, { userId: viewer.id, role: "VIEWER" })).status).toBe(201);
  expect((await viewer.c.patch(`/api/projects/${id}/deal`, { submissionDeadlineTime: "10:00" })).status).toBe(403);
  expect((await outsider.c.get(`/api/projects/${id}`)).status).toBe(404);
  await sendReminders();
  const next = (await owner.c.get(`/api/projects/${id}`)).json.project.deal.nextStep.id;
  const n = (await owner.c.get("/api/notifications")).json.items.find((n: { text: string; href: string }) => n.href === `/tasks/${next}` && n.text.includes("is due today"));
  expect(n?.text).toContain("2026-11-01 17:30 Asia/Kolkata (GMT+5:30)");
  expect(n.text).toContain("due today");
}, 120000);
