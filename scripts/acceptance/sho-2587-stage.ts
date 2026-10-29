import { performance } from "node:perf_hooks";
import { db } from "../../src/lib/db";
import { search } from "../../src/lib/search";
import queries from "../../tests/fixtures/sho-2587-stage-a-queries.json";

const schema = new URL(process.env.DATABASE_URL ?? "postgres://invalid").searchParams.get("schema");
if (process.env.SHO_ACCEPTANCE_STAGE_A !== "1" || schema !== "sho_2587_stage") {
  throw new Error("Refusing: SHO_ACCEPTANCE_STAGE_A=1 and schema=sho_2587_stage are required");
}

const workspaceId = "sho2587-workspace";
const userId = "sho2587-admin";
const commonOrgId = "sho2587-org";

async function chunks<T>(rows: T[], write: (part: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += 1000) await write(rows.slice(i, i + 1000));
}

async function main() {
await db.workspace.create({ data: { id: workspaceId, name: "SHO-2587 acceptance" } });
await db.user.create({ data: { id: userId, workspaceId, email: "sho2587+admin@invalid.example", name: "SHO-2587 Admin", passwordHash: "not-a-login", orgRole: "ADMIN" } });
await db.organisation.create({ data: { id: commonOrgId, workspaceId, name: "SHO-2587 Notes", createdById: userId } });

const expected = queries as { query: string; expected: string }[];
const taskRows = expected.filter((x) => x.expected.startsWith("task-")).map((x, position) => ({
  id: x.expected, workspaceId, projectId: "sho2587-project", sectionId: "sho2587-section", title: x.query === "budgets" || x.query === "budegt" ? "Revised budget" : x.query,
  description: `Acceptance record for ${x.query}`, position, assigneeId: userId, createdById: userId,
}));
const projectRows = expected.filter((x) => x.expected.startsWith("project-")).map((x) => ({ id: x.expected, workspaceId, name: x.query, description: `Acceptance project ${x.query}` }));
const dealRows = expected.filter((x) => x.expected.startsWith("deal-")).map((x) => ({ id: x.expected, workspaceId, name: x.query, description: `Acceptance deal ${x.query}`, typeId: "wst_deal" }));
const organisationRows = expected.filter((x) => x.expected.startsWith("organisation-")).map((x) => ({ id: x.expected, workspaceId, name: x.query, createdById: userId }));
const contactRows = expected.filter((x) => x.expected.startsWith("contact-")).map((x) => ({ id: x.expected, workspaceId, organisationId: commonOrgId, name: x.query, createdById: userId }));
const noteRows = expected.filter((x) => x.expected.startsWith("note-")).map((x) => ({ id: x.expected, workspaceId, organisationId: commonOrgId, kind: "OTHER" as const, date: new Date("2026-10-29"), text: x.query, authorId: userId }));

await db.project.create({ data: { id: "sho2587-project", workspaceId, name: "SHO-2587 task corpus", members: { create: { userId, role: "LEADER" } }, sections: { create: { id: "sho2587-section", name: "Open", position: 0 } } } });
await db.project.createMany({ data: [...projectRows, ...dealRows] });
await db.projectMember.createMany({ data: [...projectRows, ...dealRows].map((p) => ({ projectId: p.id, userId, role: "LEADER" })) });
await db.dealDetails.createMany({ data: dealRows.map((p) => ({ projectId: p.id, workspaceId, whyPursue: p.name })) });
await db.organisation.createMany({ data: organisationRows });
await db.contact.createMany({ data: contactRows });
await db.task.createMany({ data: taskRows });
await db.note.createMany({ data: noteRows });

await chunks(Array.from({ length: 20_000 - taskRows.length }, (_, i) => ({
  id: `sho2587-filler-task-${i}`, workspaceId, projectId: "sho2587-project", sectionId: "sho2587-section", title: `Routine corpus task ${i}`,
  description: `Synthetic bounded-search load row ${i}`, position: taskRows.length + i, assigneeId: userId, createdById: userId,
})), (data) => db.task.createMany({ data }));
await chunks(Array.from({ length: 5_000 - noteRows.length }, (_, i) => ({
  id: `sho2587-filler-note-${i}`, workspaceId, organisationId: commonOrgId, kind: "OTHER" as const, date: new Date("2026-10-29"),
  text: `Synthetic benchmark note ${i}`, authorId: userId,
})), (data) => db.note.createMany({ data }));

const actor = { id: userId, email: "sho2587+admin@invalid.example", name: "SHO-2587 Admin", orgRole: "ADMIN" as const };
const samples: number[] = [];
const failures: { query: string; expected: string; actual?: string }[] = [];
for (const item of expected) {
  const started = performance.now();
  const result = await search(actor, item.query, false);
  samples.push(performance.now() - started);
  if (result.results[0]?.id !== item.expected) failures.push({ ...item, actual: result.results[0]?.id });
}
samples.sort((a, b) => a - b);
const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
const receipt = { tasks: await db.task.count({ where: { workspaceId } }), notes: await db.note.count({ where: { workspaceId } }), queries: expected.length, passed: expected.length - failures.length, failures, p95Ms: Number(p95.toFixed(2)), maxMs: Number(samples.at(-1)!.toFixed(2)), resultCap: 25 };
console.log(JSON.stringify(receipt));
await db.$disconnect();
if (failures.length || p95 >= 500) process.exitCode = 1;
}

main().catch(async (error) => {
  console.error(error);
  await db.$disconnect();
  process.exitCode = 1;
});
