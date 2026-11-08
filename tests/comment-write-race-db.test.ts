// Controlled comment-write versus membership-change interleavings on disposable PostgreSQL.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { getOrCreateWorkspace } from "@/lib/workspace";
import { addComment, editComment, removeComment } from "@/lib/comments";
import { changeMemberRole, removeMember } from "@/lib/projects";
import type { Tx } from "@/lib/access";
import { assertLocalFixture } from "./e2e/local-fixture-guard";

vi.mock("next/server", () => ({ connection: vi.fn() }));

const prefix = `comment-race-${randomUUID()}`;
const leader = { id: `${prefix}-leader`, orgRole: "MEMBER" as const };
const editor = { id: `${prefix}-editor`, orgRole: "MEMBER" as const };
const mentioned = { id: `${prefix}-mentioned`, orgRole: "MEMBER" as const };
const projects: string[] = [];
let workspaceId = "";
let safe = false;
let originalFlag: string | undefined;
let sentinel: { id: string; title: string; updatedAt: Date };
const transact = db.$transaction.bind(db);

async function fixture() {
  const project = await db.project.create({ data: { workspaceId, name: prefix } });
  projects.push(project.id);
  await db.projectMember.createMany({ data: [
    { projectId: project.id, userId: leader.id, role: "LEADER" },
    { projectId: project.id, userId: editor.id, role: "EDITOR" },
    { projectId: project.id, userId: mentioned.id, role: "EDITOR" },
  ] });
  const section = await db.section.create({ data: { projectId: project.id, name: "To do", position: 0 } });
  const task = await db.task.create({ data: {
    workspaceId, projectId: project.id, sectionId: section.id,
    title: "Comment race", assigneeId: leader.id, createdById: leader.id,
  } });
  return { projectId: project.id, taskId: task.id };
}

function pauseBeforeTransaction() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let arrived = false;
  const spy = vi.spyOn(db, "$transaction").mockImplementation((async (
    callback: (tx: Tx) => Promise<unknown>, options?: Parameters<typeof db.$transaction>[1],
  ) => {
    arrived = true;
    await gate;
    return transact(callback, options);
  }) as typeof db.$transaction);
  return {
    async ready() {
      await vi.waitFor(() => expect(arrived).toBe(true), { timeout: 5000 });
      spy.mockRestore();
    },
    release,
  };
}

beforeAll(async () => {
  assertLocalFixture(process.env.DATABASE_URL);
  safe = true;
  workspaceId = (await getOrCreateWorkspace()).id;
  for (const person of [leader, editor, mentioned]) {
    await db.user.create({ data: {
      id: person.id, workspaceId, name: person.id, email: `${person.id}@example.invalid`,
      passwordHash: "unused", emailVerifiedAt: new Date(),
    } });
  }
  const fixtureRow = await fixture();
  sentinel = await db.task.findUniqueOrThrow({ where: { id: fixtureRow.taskId }, select: { id: true, title: true, updatedAt: true } });
});
beforeEach(() => { originalFlag = process.env.FF_TASK_COMMENTS; process.env.FF_TASK_COMMENTS = "true"; });
afterEach(() => {
  if (originalFlag === undefined) delete process.env.FF_TASK_COMMENTS;
  else process.env.FF_TASK_COMMENTS = originalFlag;
  vi.restoreAllMocks();
});
afterAll(async () => {
  if (!safe) return;
  let cleanup = false;
  try {
    expect(await db.task.findUniqueOrThrow({ where: { id: sentinel.id }, select: { id: true, title: true, updatedAt: true } })).toEqual(sentinel);
  } finally {
    try {
      await db.notification.deleteMany({ where: { projectId: { in: projects } } });
      await db.actionLog.deleteMany({ where: { projectId: { in: projects } } });
      await db.project.deleteMany({ where: { id: { in: projects } } });
      await db.user.deleteMany({ where: { id: { in: [leader.id, editor.id, mentioned.id] } } });
      expect(await db.project.count({ where: { id: { in: projects } } })).toBe(0);
      expect(await db.user.count({ where: { id: { in: [leader.id, editor.id, mentioned.id] } } })).toBe(0);
      cleanup = true;
    } finally {
      mkdirSync("test-results/comment-race", { recursive: true });
      writeFileSync("test-results/comment-race/cleanup.json", JSON.stringify({ fixture: prefix, cleanup, projects: projects.length, people: 3 }, null, 2));
    }
  }
});

it("membership removal committed after preflight denies an in-flight comment add", async () => {
  const { projectId, taskId } = await fixture();
  const pause = pauseBeforeTransaction();
  const result = Promise.allSettled([addComment(editor, taskId, { text: "Must not be written" })]);
  try {
    await pause.ready();
    await removeMember(leader, projectId, editor.id);
    const notices = await db.notification.count({ where: { taskId } });
    pause.release();
    expect(await result).toEqual([expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ status: 404 }) })]);
    expect(await db.comment.count({ where: { taskId } })).toBe(0);
    expect(await db.actionLog.count({ where: { targetId: taskId, action: "comment.added" } })).toBe(0);
    expect(await db.notification.count({ where: { taskId } })).toBe(notices);
  } finally { pause.release(); await result; }
});

it("does not write a comment or notify a mention removed after preflight", async () => {
  const { projectId, taskId } = await fixture();
  const pause = pauseBeforeTransaction();
  const result = Promise.allSettled([addComment(editor, taskId, { text: "Review with teammate", mentions: [mentioned.id] })]);
  try {
    await pause.ready();
    await removeMember(leader, projectId, mentioned.id);
    const noticesBefore = await db.notification.count({ where: { taskId, recipientId: mentioned.id } });
    pause.release();
    expect(await result).toEqual([expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ status: 409 }) })]);
    expect(await db.comment.count({ where: { taskId } })).toBe(0);
    expect(await db.notification.count({ where: { taskId, recipientId: mentioned.id } })).toBe(noticesBefore);
  } finally { pause.release(); await result; }
});

it("does not replace an edited comment with a mention removed after preflight", async () => {
  const { projectId, taskId } = await fixture();
  const comment = await addComment(editor, taskId, { text: "Original text" });
  const pause = pauseBeforeTransaction();
  const result = Promise.allSettled([editComment(editor, taskId, comment.id, { text: "Changed text", mentions: [mentioned.id] })]);
  try {
    await pause.ready();
    await removeMember(leader, projectId, mentioned.id);
    pause.release();
    expect(await result).toEqual([expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ status: 409 }) })]);
    const stored = await db.comment.findUniqueOrThrow({ where: { id: comment.id } });
    expect({ text: stored.text, mentions: stored.mentions }).toEqual({ text: "Original text", mentions: [] });
  } finally { pause.release(); await result; }
});

it("Viewer downgrade committed after preflight denies an in-flight comment edit", async () => {
  const { projectId, taskId } = await fixture();
  const comment = await addComment(editor, taskId, { text: "Keep original" });
  const pause = pauseBeforeTransaction();
  const result = Promise.allSettled([editComment(editor, taskId, comment.id, { text: "Must not replace" })]);
  try {
    await pause.ready();
    await changeMemberRole(leader, projectId, editor.id, "VIEWER");
    pause.release();
    expect(await result).toEqual([expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ status: 403 }) })]);
    expect((await db.comment.findUniqueOrThrow({ where: { id: comment.id } })).text).toBe("Keep original");
    expect(await db.actionLog.count({ where: { targetId: taskId, action: "comment.edited" } })).toBe(0);
  } finally { pause.release(); await result; }
});

it("membership removal committed after preflight denies an in-flight comment delete", async () => {
  const { projectId, taskId } = await fixture();
  const comment = await addComment(editor, taskId, { text: "Keep comment" });
  const pause = pauseBeforeTransaction();
  const result = Promise.allSettled([removeComment(editor, taskId, comment.id)]);
  try {
    await pause.ready();
    await removeMember(leader, projectId, editor.id);
    pause.release();
    expect(await result).toEqual([expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ status: 404 }) })]);
    expect((await db.comment.findUniqueOrThrow({ where: { id: comment.id } })).removedAt).toBeNull();
    expect(await db.actionLog.count({ where: { targetId: taskId, action: "comment.removed" } })).toBe(0);
  } finally { pause.release(); await result; }
});
