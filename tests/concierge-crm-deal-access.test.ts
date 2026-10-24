// SHO-2584: actual PostgreSQL access regression. Only this file's synthetic IDs are created/deleted.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { db } from "@/lib/db";
import { findDeals, dealSummary } from "@/lib/concierge/crm-reads";
import { setFakeModel } from "@/lib/model";
import { sendMessage } from "@/lib/concierge/engine";
import { conciergeTools, newTurn, runTool } from "@/lib/concierge/tools";
const id = `zz2584-${randomUUID()}`;
const ws = `${id}-w`, lead = `${id}-lead`, member = `${id}-member`, outsider = `${id}-outsider`;
const org = `${id}-org`, visible = `${id}-visible`, hidden = `${id}-hidden`, archived = `${id}-archived`, ordinary = `${id}-ordinary`;
const projects = [visible, hidden, archived, ordinary];
const actor = { id: member, orgRole: "MEMBER" as const };
const before = process.env.CRM_VISIBLE;
beforeAll(async () => {
 const target = new URL(process.env.DATABASE_URL ?? "http://invalid");
 if (!["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)) throw new Error("SHO2584 access fixtures require an isolated local test database");
 process.env.CRM_VISIBLE = "all";
 await db.workspace.create({ data: { id: ws, name: "ZZ-TEST 2584 read access" } });
 for (const person of [lead, member, outsider]) await db.user.create({ data: { id: person, workspaceId: ws, name: `ZZ-TEST ${person}`, email: `${person}@example.invalid`, passwordHash: "not-a-login", orgRole: person === lead ? "ADMIN" : "MEMBER", emailVerifiedAt: new Date() } });
 await db.organisation.create({ data: { id: org, workspaceId: ws, name: "ZZ-TEST Buyer", createdById: lead } });
 const stage = await db.stage.findFirstOrThrow({ where: { pipelineId: "pl_bid", isRetired: false }, orderBy: { position: "asc" } });
 for (const projectId of projects) {
  const plain = projectId === ordinary;
  await db.project.create({ data: { id: projectId, workspaceId: ws, name: `ZZ-TEST JEEViKA ${id}`, typeId: plain ? "wst_project" : "wst_deal", ...(!plain ? { pipelineId: "pl_bid", stageId: stage.id } : {}), archivedAt: projectId === archived ? new Date() : null, createdAt: new Date(Date.now() - 60 * 86400000) } });
  await db.projectMember.create({ data: { projectId, userId: lead, role: "LEADER" } });
  if (projectId !== hidden) await db.projectMember.create({ data: { projectId, userId: member, role: "VIEWER" } });
  if (!plain) {
   await db.dealDetails.create({ data: { projectId, workspaceId: ws, whyPursue: "ZZ-TEST read fixture" } });
   await db.dealParty.create({ data: { projectId, organisationId: org, role: "BUYER" } });
  }
 }
 const section = await db.section.create({ data: { projectId: visible, name: "To do", position: 0 } });
 await db.task.create({ data: { workspaceId: ws, projectId: visible, sectionId: section.id, title: "ZZ-TEST Call\nBuyer", assigneeId: member, createdById: lead, dueDate: new Date("2031-06-01T00:00:00Z") } });
});
afterAll(async () => {
 try {
  await db.chatMessage.deleteMany({ where: { userId: { in: [lead, member, outsider] } } });
  await db.modelUsage.deleteMany({ where: { userId: { in: [lead, member, outsider] } } });
  await db.task.deleteMany({ where: { projectId: { in: projects } } });
  await db.section.deleteMany({ where: { projectId: { in: projects } } });
  await db.dealParty.deleteMany({ where: { projectId: { in: projects } } });
  await db.dealDetails.deleteMany({ where: { projectId: { in: projects } } });
  await db.projectMember.deleteMany({ where: { projectId: { in: projects } } });
  await db.project.deleteMany({ where: { id: { in: projects }, workspaceId: ws } });
  await db.organisation.deleteMany({ where: { id: org, workspaceId: ws } });
  await db.user.deleteMany({ where: { id: { in: [lead, member, outsider] }, workspaceId: ws } });
  await db.workspace.deleteMany({ where: { id: ws } });
 } finally { if (before === undefined) delete process.env.CRM_VISIBLE; else process.env.CRM_VISIBLE = before; await db.$disconnect(); }
});
it("VIEWER members read only their nonarchived deals, with real stage/buyer/next-step data", async () => {
 const result = await findDeals(actor, id);
 expect(result.deals.map(d => d.id)).toEqual([visible]);
 const summary = await dealSummary(actor, visible);
 expect(summary).toMatchObject({ id: visible, pipeline: "Bid", organisation: { id: org, name: "ZZ-TEST Buyer" }, nextStep: { title: "ZZ-TEST Call Buyer", due: "2031-06-01" }, stalled: false });
 expect(summary.stage).toBeTruthy();
});
it("nonmember, archived, ordinary-project and absent summaries are all not-found", async () => {
 for (const projectId of [hidden, archived, ordinary, `${id}-absent`]) await expect(dealSummary(actor, projectId)).rejects.toMatchObject({ status: 404 });
 expect((await findDeals({ id: outsider, orgRole: "MEMBER" }, id)).deals).toEqual([]);
});
it("CRM admins/off modes gate both advertised tools and real reads", async () => {
 try {
  for (const mode of ["admins", "off"]) {
   process.env.CRM_VISIBLE = mode;
   expect(conciergeTools(actor).some(t => t.name === "find_deals")).toBe(false);
   await expect(findDeals(actor, id)).rejects.toMatchObject({ status: 404 });
   await expect(dealSummary(actor, visible)).rejects.toMatchObject({ status: 404 });
  }
  process.env.CRM_VISIBLE = "admins";
  const admin = { id: lead, orgRole: "ADMIN" as const };
  expect((await findDeals(admin, id)).deals.map(d => d.id).sort()).toEqual([hidden, visible].sort());
  expect(await dealSummary(admin, hidden)).toMatchObject({ id: hidden, nextStep: null, needsNextStep: true, stalled: true });
 } finally { process.env.CRM_VISIBLE = "all"; }
});
it("a forged hidden id never reaches seen records; legitimate duplicate names force deal choice", async () => {
 const turn = newTurn(actor, new Date());
 expect(await runTool(turn, "deal_summary", { deal_id: hidden })).toMatchObject({ isError: true, content: "Not found." });
 expect(turn.seen.deals.size).toBe(0);
 const admin = newTurn({ id: lead, orgRole: "ADMIN" }, new Date());
 await runTool(admin, "find_deals", { text: id });
 expect(admin.forced?.kind).toBe("deal");
 expect(admin.forced?.ids.sort()).toEqual([hidden, visible].sort());
 expect(admin.ops).toEqual([]);
});

it("the real message engine returns linked stage facts from current-turn read tools without a confirmation card", async () => {
 const saved = { provider: process.env.MODEL_PROVIDER, consent: process.env.MODEL_DATA_APPROVED };
 try {
  process.env.MODEL_PROVIDER = "fake"; process.env.MODEL_DATA_APPROVED = "true";
  setFakeModel((_request, call) => ({ content: call === 1
   ? [{ type: "tool_use", id: "find", name: "find_deals", input: { text: id } }]
   : call === 2 ? [{ type: "tool_use", id: "summary", name: "deal_summary", input: { deal_id: visible } }]
   : [{ type: "text", text: `ZZ-TEST JEEViKA ${id}: Leads` }], stopReason: "end_turn", usage: { input: 1, output: 1, cacheWrite: 0, cacheRead: 0 } }));
  const response = await sendMessage(actor, "What stage is the JEEViKA deal at?");
  const answer = response.messages.find(message => message.kind === "answer");
  expect(answer?.links).toContainEqual({ label: `ZZ-TEST JEEViKA ${id}`, href: `/projects/${visible}` });
  expect(response.messages.some(message => message.kind === "card")).toBe(false);
 } finally {
  setFakeModel(null);
  if (saved.provider === undefined) delete process.env.MODEL_PROVIDER; else process.env.MODEL_PROVIDER = saved.provider;
  if (saved.consent === undefined) delete process.env.MODEL_DATA_APPROVED; else process.env.MODEL_DATA_APPROVED = saved.consent;
 }
});
it("duplicate deal names become server-built choices with buyer/stage detail, even if the model guesses an answer", async () => {
 const saved = { provider: process.env.MODEL_PROVIDER, consent: process.env.MODEL_DATA_APPROVED };
 try {
  process.env.MODEL_PROVIDER = "fake"; process.env.MODEL_DATA_APPROVED = "true";
  setFakeModel((_request, call) => ({ content: call === 1
   ? [{ type: "tool_use", id: "find", name: "find_deals", input: { text: id } }]
   : [{ type: "text", text: "The deal is in Leads." }], stopReason: "end_turn", usage: { input: 1, output: 1, cacheWrite: 0, cacheRead: 0 } }));
  const response = await sendMessage({ id: lead, orgRole: "ADMIN" }, "What stage is the JEEViKA deal at?");
  const choices = response.messages.find(message => message.kind === "choices");
  expect(choices?.text).toBe("Which deal do you mean?");
  expect(choices?.choices?.filter(option => [visible, hidden].includes(option.id))).toHaveLength(2);
  expect(choices?.choices?.find(option => option.id === visible)?.detail).toContain("ZZ-TEST Buyer");
  expect(choices?.choices?.find(option => option.id === visible)?.detail).toContain("Leads");
 } finally {
  setFakeModel(null);
  if (saved.provider === undefined) delete process.env.MODEL_PROVIDER; else process.env.MODEL_PROVIDER = saved.provider;
  if (saved.consent === undefined) delete process.env.MODEL_DATA_APPROVED; else process.env.MODEL_DATA_APPROVED = saved.consent;
 }
});
