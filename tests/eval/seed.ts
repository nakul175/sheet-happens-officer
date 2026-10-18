// Synthetic fixtures in the throwaway database. One workspace per run, so prompts cannot see each other.
import { randomBytes } from "node:crypto";
import { db } from "../../src/lib/db";
import { EVAL_NOW, fixtureDue } from "./clock";
import type { FixtureSpec, Prompt, World } from "./types";

const SECTIONS = ["To do", "In progress", "Done"];

export function assertFixture(prompt: Prompt) {
  const f = prompt.fixture;
  const people = new Set(f.people.map((p) => p.key));
  const orgs = new Set((f.orgs ?? []).map((o) => o.key));
  const projects = new Set(f.projects.map((p) => p.key));
  if (!people.has(f.actor)) throw new Error(`${prompt.id}: actor ${f.actor} is not a person`);
  for (const p of f.projects) {
    if (!people.has(p.leader)) throw new Error(`${prompt.id}: leader ${p.leader} is missing`);
    if (p.kind === "deal" && (!p.org || !orgs.has(p.org))) throw new Error(`${prompt.id}: deal ${p.key} needs an organisation`);
    for (const m of p.members ?? []) if (!people.has(m.key)) throw new Error(`${prompt.id}: member ${m.key} is missing`);
  }
  for (const t of f.tasks ?? []) {
    if (!projects.has(t.project)) throw new Error(`${prompt.id}: task ${t.key} project is missing`);
    if (!people.has(t.assignee)) throw new Error(`${prompt.id}: assignee ${t.assignee} is missing`);
    if (t.approver && !people.has(t.approver)) throw new Error(`${prompt.id}: approver ${t.approver} is missing`);
  }
  for (const n of f.notes ?? []) {
    if (!orgs.has(n.org)) throw new Error(`${prompt.id}: note ${n.key} organisation is missing`);
    if (n.deal && !projects.has(n.deal)) throw new Error(`${prompt.id}: note ${n.key} deal is missing`);
  }
}

export async function seed(prompt: Prompt, run: number): Promise<{ world: World; workspaceId: string }> {
  assertFixture(prompt);
  const f: FixtureSpec = prompt.fixture;
  const tag = `${prompt.id}.${run}.${randomBytes(4).toString("hex")}`;
  const workspace = await db.workspace.create({ data: { name: `Eval ${tag}` } });
  const people: World["people"] = {};
  for (const p of f.people) {
    const email = `${tag}.${p.key}@eval.invalid`;
    const row = await db.user.create({
      data: {
        workspaceId: workspace.id, email, name: p.name, passwordHash: "eval-not-a-password",
        emailVerifiedAt: EVAL_NOW, orgRole: p.orgRole ?? "MEMBER",
      },
    });
    people[p.key] = { id: row.id, name: p.name, email };
  }
  const orgs: Record<string, string> = {};
  for (const o of f.orgs ?? []) {
    const row = await db.organisation.create({
      data: { workspaceId: workspace.id, name: o.name, createdById: people[f.actor].id },
    });
    orgs[o.key] = row.id;
  }
  const projects: World["projects"] = {};
  const sections = new Map<string, string>();
  for (const p of f.projects) {
    const row = await db.project.create({
      data: {
        workspaceId: workspace.id, name: p.name,
        typeId: p.kind === "deal" ? "wst_deal" : "wst_project",
        ...(p.kind === "deal" ? { pipelineId: "pl_proactive", stageId: "st_pro_lead", stageChangedAt: EVAL_NOW } : {}),
      },
    });
    await db.projectMember.create({ data: { projectId: row.id, userId: people[p.leader].id, role: "LEADER" } });
    for (const m of p.members ?? []) {
      if (m.key === p.leader) continue;
      await db.projectMember.create({ data: { projectId: row.id, userId: people[m.key].id, role: m.role } });
    }
    for (const [i, name] of SECTIONS.entries()) {
      const s = await db.section.create({ data: { projectId: row.id, name, position: i, isDone: i === SECTIONS.length - 1 } });
      if (i === 0) sections.set(p.key, s.id);
    }
    if (p.kind === "deal" && p.org) {
      await db.dealDetails.create({ data: { projectId: row.id, workspaceId: workspace.id, whyPursue: "Synthetic eval fixture." } });
      await db.dealParty.create({ data: { projectId: row.id, organisationId: orgs[p.org], role: "BUYER" } });
    }
    projects[p.key] = { id: row.id, name: p.name };
  }
  const tasks: World["tasks"] = {};
  for (const [i, t] of (f.tasks ?? []).entries()) {
    const sectionId = sections.get(t.project);
    if (!sectionId) throw new Error(`${prompt.id}: project ${t.project} has no section`);
    const row = await db.task.create({
      data: {
        workspaceId: workspace.id, projectId: projects[t.project].id, sectionId,
        title: t.title, description: t.description ?? null, assigneeId: people[t.assignee].id, createdById: people[f.actor].id,
        dueDate: fixtureDue(t.due), priority: t.priority ?? "MEDIUM", blocked: !!t.blocked,
        blockedReason: t.blockedReason ?? null, completedAt: t.done ? EVAL_NOW : null,
        approverId: t.approver ? people[t.approver].id : null, position: i,
      },
    });
    tasks[t.key] = { id: row.id, title: t.title };
  }
  const notes: World["notes"] = {};
  for (const n of f.notes ?? []) {
    const row = await db.note.create({
      data: {
        workspaceId: workspace.id, organisationId: orgs[n.org], projectId: n.deal ? projects[n.deal].id : null,
        kind: "OTHER", date: EVAL_NOW, text: n.text, authorId: people[f.actor].id,
      },
    });
    notes[n.key] = { id: row.id, text: n.text };
  }
  const actor = f.people.find((p) => p.key === f.actor)!;
  return {
    workspaceId: workspace.id,
    world: { actor: { id: people[f.actor].id, name: actor.name, orgRole: actor.orgRole ?? "MEMBER" }, people, projects, tasks, notes },
  };
}

export async function snapshot(workspaceId: string): Promise<string> {
  const [tasks, projects, members] = await Promise.all([
    db.task.findMany({
      where: { workspaceId },
      select: { id: true, title: true, description: true, dueDate: true, completedAt: true, assigneeId: true, deletedAt: true, priority: true, blocked: true, blockedReason: true },
      orderBy: { id: "asc" },
    }),
    db.project.findMany({
      where: { workspaceId },
      select: { id: true, name: true, archivedAt: true, description: true },
      orderBy: { id: "asc" },
    }),
    db.projectMember.findMany({
      where: { project: { workspaceId } },
      select: { projectId: true, userId: true, role: true },
      orderBy: [{ projectId: "asc" }, { userId: "asc" }],
    }),
  ]);
  return JSON.stringify({ tasks, projects, members });
}
