// Direct task-link writes versus membership changes and a competing add.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { getOrCreateWorkspace } from "@/lib/workspace";
import { addTaskLink, removeTaskLink } from "@/lib/records";
import { changeMemberRole, removeMember } from "@/lib/projects";
import type { Tx } from "@/lib/access";
import { assertLocalFixture } from "./e2e/local-fixture-guard";

vi.mock("next/server", () => ({ connection: vi.fn() }));

const prefix = `task-link-write-${randomUUID()}`;
const leader = { id: `${prefix}-leader`, orgRole: "MEMBER" as const };
const editor = { id: `${prefix}-editor`, orgRole: "MEMBER" as const };
const projects: string[] = [];
const organisations: string[] = [];
let workspaceId = "";
let safe = false;
let sentinel: { id: string; name: string };
const transact = db.$transaction.bind(db);

async function fixture(withLink = false) {
  const project = await db.project.create({ data: { workspaceId, name: prefix } });
  projects.push(project.id);
  await db.projectMember.createMany({ data: [
    { projectId: project.id, userId: leader.id, role: "LEADER" },
    { projectId: project.id, userId: editor.id, role: "EDITOR" },
  ] });
  const section = await db.section.create({ data: { projectId: project.id, name: "To do", position: 0 } });
  const task = await db.task.create({ data: {
    workspaceId, projectId: project.id, sectionId: section.id,
    title: "Task link race", assigneeId: leader.id, createdById: leader.id,
  } });
  const org = await db.organisation.create({ data: { workspaceId, name: `${prefix}-org`, createdById: leader.id } });
  organisations.push(org.id);
  const link = withLink ? await db.taskLink.create({ data: { taskId: task.id, organisationId: org.id } }) : null;
  return { projectId: project.id, taskId: task.id, orgId: org.id, linkId: link?.id ?? "" };
}

function pauseBeforeTransactions(count: number) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let arrived = 0;
  const spy = vi.spyOn(db, "$transaction").mockImplementation((async (
    callback: (tx: Tx) => Promise<unknown>, options?: Parameters<typeof db.$transaction>[1],
  ) => {
    arrived++;
    await gate;
    return transact(callback, options);
  }) as typeof db.$transaction);
  return {
    async ready() {
      await vi.waitFor(() => expect(arrived).toBe(count), { timeout: 5000 });
      spy.mockRestore();
    },
    release,
  };
}

async function state(projectId: string, taskId: string) {
  const [links, actions, notices] = await Promise.all([
    db.taskLink.findMany({ where: { taskId }, orderBy: { id: "asc" } }),
    db.actionLog.findMany({ where: { projectId }, orderBy: { id: "asc" } }),
    db.notification.findMany({ where: { projectId }, orderBy: { id: "asc" } }),
  ]);
  return { links, actions, notices };
}

beforeAll(async () => {
  assertLocalFixture(process.env.DATABASE_URL);
  safe = true;
  workspaceId = (await getOrCreateWorkspace()).id;
  for (const person of [leader, editor]) {
    await db.user.create({ data: {
      id: person.id, workspaceId, name: person.id, email: `${person.id}@example.invalid`,
      passwordHash: "unused", emailVerifiedAt: new Date(),
    } });
  }
  const row = await db.project.create({ data: { workspaceId, name: `${prefix}-sentinel` } });
  sentinel = { id: row.id, name: row.name };
  projects.push(row.id);
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  if (!safe) return;
  let cleanup = false;
  try {
    expect(await db.project.findUniqueOrThrow({ where: { id: sentinel.id }, select: { id: true, name: true } })).toEqual(sentinel);
  } finally {
    try {
      await db.notification.deleteMany({ where: { projectId: { in: projects } } });
      await db.actionLog.deleteMany({ where: { projectId: { in: projects } } });
      await db.project.deleteMany({ where: { id: { in: projects } } });
      await db.organisation.deleteMany({ where: { id: { in: organisations } } });
      await db.user.deleteMany({ where: { id: { in: [leader.id, editor.id] } } });
      expect(await db.project.count({ where: { id: { in: projects } } })).toBe(0);
      expect(await db.organisation.count({ where: { id: { in: organisations } } })).toBe(0);
      expect(await db.user.count({ where: { id: { in: [leader.id, editor.id] } } })).toBe(0);
      cleanup = true;
    } finally {
      mkdirSync("test-results/task-link-write-race", { recursive: true });
      writeFileSync("test-results/task-link-write-race/cleanup.json", JSON.stringify({ fixture: prefix, cleanup, projects: projects.length, organisations: organisations.length, people: 2 }, null, 2));
    }
  }
});

it("removal committed after preflight denies a direct task-link add", async () => {
  const f = await fixture();
  const pause = pauseBeforeTransactions(1);
  const pending = Promise.allSettled([addTaskLink(editor, f.taskId, { organisationId: f.orgId })]);
  try {
    await pause.ready();
    await removeMember(leader, f.projectId, editor.id);
    const before = await state(f.projectId, f.taskId);
    pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ status: 404 }) })]);
    expect(await state(f.projectId, f.taskId)).toEqual(before);
  } finally { pause.release(); await pending; }
}, 20_000);

it("Viewer downgrade committed after preflight denies a direct task-link add", async () => {
  const f = await fixture();
  const pause = pauseBeforeTransactions(1);
  const pending = Promise.allSettled([addTaskLink(editor, f.taskId, { organisationId: f.orgId })]);
  try {
    await pause.ready();
    await changeMemberRole(leader, f.projectId, editor.id, "VIEWER");
    const before = await state(f.projectId, f.taskId);
    pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ status: 403 }) })]);
    expect(await state(f.projectId, f.taskId)).toEqual(before);
  } finally { pause.release(); await pending; }
}, 20_000);

it("removal committed after preflight denies a direct task-link removal", async () => {
  const f = await fixture(true);
  const pause = pauseBeforeTransactions(1);
  const pending = Promise.allSettled([removeTaskLink(editor, f.taskId, f.linkId)]);
  try {
    await pause.ready();
    await removeMember(leader, f.projectId, editor.id);
    const before = await state(f.projectId, f.taskId);
    pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ status: 404 }) })]);
    expect(await state(f.projectId, f.taskId)).toEqual(before);
  } finally { pause.release(); await pending; }
}, 20_000);

it("two concurrent adds of the same task link have one winner and one action", async () => {
  const f = await fixture();
  const pause = pauseBeforeTransactions(2);
  const pending = Promise.allSettled([
    addTaskLink(editor, f.taskId, { organisationId: f.orgId }),
    addTaskLink(editor, f.taskId, { organisationId: f.orgId }),
  ]);
  try {
    await pause.ready();
    pause.release();
    const results = await pending;
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason as { status?: number }).status).toBe(409);
    const after = await state(f.projectId, f.taskId);
    expect(after.links).toHaveLength(1);
    expect(after.actions.filter((a) => a.action === "task.link_added")).toHaveLength(1);
  } finally { pause.release(); await pending; }
}, 20_000);

it("an eligible Editor can add and remove one link with matching action history", async () => {
  const f = await fixture();
  const link = await addTaskLink(editor, f.taskId, { organisationId: f.orgId });
  expect((await state(f.projectId, f.taskId)).links.map((row) => row.id)).toEqual([link.id]);
  await removeTaskLink(editor, f.taskId, link.id);
  const after = await state(f.projectId, f.taskId);
  expect(after.links).toHaveLength(0);
  expect(after.actions.filter((a) => a.action.startsWith("task.link_"))).toHaveLength(2);
});
