// A document link never grants Holy Sheet access, but SHO must still enforce its
// current native write role when saving that link. Disposable PostgreSQL only.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { getOrCreateWorkspace } from "@/lib/workspace";
import { changeDocument } from "@/lib/holy-sheet-links";
import type { Tx } from "@/lib/access";
import { assertLocalFixture } from "./e2e/local-fixture-guard";

const authority = vi.hoisted(() => ({ sessionId: vi.fn(), active: vi.fn() }));
vi.mock("next/server", () => ({ connection: vi.fn() }));
vi.mock("@/lib/auth", () => ({ currentSessionId: authority.sessionId }));
vi.mock("@/lib/central-status", () => ({ centralSessionActive: authority.active }));

const prefix = `holy-link-role-${randomUUID()}`;
const admin = { id: `${prefix}-admin`, orgRole: "ADMIN" as const };
const leader = { id: `${prefix}-leader`, orgRole: "MEMBER" as const };
const viewer = { id: `${prefix}-viewer`, orgRole: "MEMBER" as const };
const subject = "12345678-1234-4234-8234-123456789abc";
const pageId = randomUUID();
const completed: string[] = [];
const transact = db.$transaction.bind(db);
let workspaceId: string, projectId: string, taskId: string, sessionId: string, safe = false;

beforeAll(async () => {
  assertLocalFixture(process.env.DATABASE_URL); safe = true;
  vi.stubEnv("FF_HOLY_SHEET", "1");
  vi.stubEnv("HOLY_SHEET_ORIGIN", "https://holysheet.aplyd.org");
  workspaceId = (await getOrCreateWorkspace()).id;
  for (const actor of [admin, leader, viewer]) {
    await db.user.create({ data: { id: actor.id, workspaceId, name: actor.id, email: `${actor.id}@example.invalid`, passwordHash: "unused", emailVerifiedAt: new Date(), orgRole: actor.orgRole } });
  }
  projectId = (await db.project.create({ data: { workspaceId, name: prefix } })).id;
  await db.projectMember.create({ data: { projectId, userId: leader.id, role: "LEADER" } });
  await db.projectMember.create({ data: { projectId, userId: viewer.id, role: "VIEWER" } });
  const section = await db.section.create({ data: { projectId, name: `${prefix}-section`, position: 0 } });
  taskId = (await db.task.create({ data: { workspaceId, projectId, sectionId: section.id, title: `${prefix}-task`, assigneeId: leader.id, createdById: leader.id } })).id;
  sessionId = (await db.session.create({ data: { userId: admin.id, tokenHash: prefix, expiresAt: new Date(Date.now() + 3_600_000), centralLink: { create: { subject, sessionUid: prefix } } } })).id;
  authority.sessionId.mockResolvedValue(sessionId);
  authority.active.mockResolvedValue(true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (safe) await db.user.update({ where: { id: admin.id }, data: { orgRole: "ADMIN", deactivatedAt: null } });
});

afterAll(async () => {
  if (!safe) return;
  let cleanup = false;
  try {
    await db.session.deleteMany({ where: { id: sessionId } });
    await db.project.deleteMany({ where: { id: projectId } });
    await db.user.deleteMany({ where: { id: { in: [admin.id, leader.id, viewer.id] } } });
    expect(await db.holySheetLink.count({ where: { projectId } })).toBe(0);
    expect(await db.user.count({ where: { id: { in: [admin.id, leader.id, viewer.id] } } })).toBe(0);
    cleanup = true;
  } finally {
    vi.unstubAllEnvs();
    mkdirSync("test-results/holy-sheet-link-role-race", { recursive: true });
    writeFileSync("test-results/holy-sheet-link-role-race/cleanup.json", JSON.stringify({ fixture: prefix, projectId, completed, cleanup }, null, 2));
  }
});

function pauseBeforeWrite() {
  let release!: () => void, arrived = false;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const spy = vi.spyOn(db, "$transaction").mockImplementationOnce((async (callback: (tx: Tx) => Promise<unknown>, options?: Parameters<typeof db.$transaction>[1]) => {
    arrived = true; await held; return transact(callback, options);
  }) as typeof db.$transaction);
  return { ready: async () => { await vi.waitFor(() => expect(arrived).toBe(true), { timeout: 5000 }); spy.mockRestore(); }, release };
}

it("Viewer cannot add or remove project or task document links, with stored state unchanged", async () => {
  const before = await Promise.all([
    db.project.findUniqueOrThrow({ where: { id: projectId } }),
    db.task.findUniqueOrThrow({ where: { id: taskId } }),
    db.holySheetLink.findMany({ where: { projectId } }),
    db.holySheetDefault.findUnique({ where: { projectId } }),
    db.actionLog.findMany({ where: { projectId } }),
    db.auditLog.findMany({ where: { actorId: viewer.id } }),
  ]);
  for (const origin of [{ kind: "projects", id: projectId }, { kind: "tasks", id: taskId }] as const) {
    for (const remove of [false, true]) {
      await expect(changeDocument(viewer, origin, { pageId, subject, remove }))
        .rejects.toMatchObject({ status: 403 });
      expect(await Promise.all([
        db.project.findUniqueOrThrow({ where: { id: projectId } }),
        db.task.findUniqueOrThrow({ where: { id: taskId } }),
        db.holySheetLink.findMany({ where: { projectId } }),
        db.holySheetDefault.findUnique({ where: { projectId } }),
        db.actionLog.findMany({ where: { projectId } }),
        db.auditLog.findMany({ where: { actorId: viewer.id } }),
      ])).toEqual(before);
    }
  }
  completed.push("viewer-document-links-denied");
});

it("denies a former Admin without a project seat after role demotion during picker save", async () => {
  const pause = pauseBeforeWrite();
  const pending = Promise.allSettled([changeDocument(admin, { kind: "projects", id: projectId }, { pageId, subject })]);
  try {
    await pause.ready();
    await db.user.update({ where: { id: admin.id }, data: { orgRole: "MEMBER" } });
    pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ status: 404 }) })]);
    expect(await db.holySheetLink.count({ where: { projectId, pageId } })).toBe(0);
    completed.push("demoted-admin-denied");
  } finally { pause.release(); await pending; }
}, 20_000);

it("denies an Admin deactivated after the picker preflight", async () => {
  const deactivatedPage = randomUUID(), pause = pauseBeforeWrite();
  const pending = Promise.allSettled([changeDocument(admin, { kind: "projects", id: projectId }, { pageId: deactivatedPage, subject })]);
  try {
    await pause.ready();
    await db.user.update({ where: { id: admin.id }, data: { deactivatedAt: new Date() } });
    pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ status: 404 }) })]);
    expect(await db.holySheetLink.count({ where: { projectId, pageId: deactivatedPage } })).toBe(0);
    completed.push("deactivated-admin-denied");
  } finally { pause.release(); await pending; }
}, 20_000);

it("denies an Editor removed after picker preflight without writing a link or default space", async () => {
  const removedPage = randomUUID();
  const editorSession = await db.session.create({ data: {
    userId: viewer.id, tokenHash: `${prefix}-editor-session`,
    expiresAt: new Date(Date.now() + 3_600_000),
    centralLink: { create: { subject, sessionUid: `${prefix}-editor` } },
  } });
  await db.projectMember.update({ where: { projectId_userId: { projectId, userId: viewer.id } }, data: { role: "EDITOR" } });
  authority.sessionId.mockResolvedValue(editorSession.id);
  const beforeDefault = await db.holySheetDefault.findUnique({ where: { projectId } });
  const pause = pauseBeforeWrite();
  const pending = Promise.allSettled([changeDocument(viewer, { kind: "tasks", id: taskId }, {
    pageId: removedPage, subject, spaceId: `${prefix}-space`, setDefault: true,
  })]);
  try {
    await pause.ready();
    await db.projectMember.delete({ where: { projectId_userId: { projectId, userId: viewer.id } } });
    pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ status: 404 }) })]);
    expect(await db.holySheetLink.count({ where: { projectId, pageId: removedPage } })).toBe(0);
    expect(await db.holySheetDefault.findUnique({ where: { projectId } })).toEqual(beforeDefault);
    completed.push("removed-editor-no-partial-default");
  } finally {
    pause.release(); await pending;
    await db.projectMember.upsert({ where: { projectId_userId: { projectId, userId: viewer.id } }, create: { projectId, userId: viewer.id, role: "VIEWER" }, update: { role: "VIEWER" } });
    await db.session.delete({ where: { id: editorSession.id } });
    authority.sessionId.mockResolvedValue(sessionId);
  }
}, 20_000);

it("denies a task link after the task moves projects during picker save", async () => {
  const movedPage = randomUUID();
  const original = await db.task.findUniqueOrThrow({ where: { id: taskId }, select: { projectId: true, sectionId: true } });
  const destination = await db.project.create({ data: { workspaceId, name: `${prefix}-destination` } });
  const destinationSection = await db.section.create({ data: { projectId: destination.id, name: `${prefix}-destination-section`, position: 0 } });
  const beforeDefault = await db.holySheetDefault.findUnique({ where: { projectId } });
  const pause = pauseBeforeWrite();
  const pending = Promise.allSettled([changeDocument(admin, { kind: "tasks", id: taskId }, {
    pageId: movedPage, subject, spaceId: `${prefix}-moved-space`, setDefault: true,
  })]);
  try {
    await pause.ready();
    await db.task.update({ where: { id: taskId }, data: { projectId: destination.id, sectionId: destinationSection.id } });
    pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ status: 404 }) })]);
    expect(await db.holySheetLink.count({ where: { pageId: movedPage } })).toBe(0);
    expect(await db.holySheetDefault.findUnique({ where: { projectId } })).toEqual(beforeDefault);
    expect(await db.holySheetDefault.findUnique({ where: { projectId: destination.id } })).toBeNull();
    completed.push("task-move-no-wrong-source-link");
  } finally {
    pause.release(); await pending;
    await db.task.update({ where: { id: taskId }, data: { projectId: original.projectId, sectionId: original.sectionId } });
    await db.project.delete({ where: { id: destination.id } });
  }
}, 20_000);

it("denies a document link when its SHO session is revoked after picker preflight", async () => {
  const revokedPage = randomUUID();
  const beforeDefault = await db.holySheetDefault.findUnique({ where: { projectId } });
  const pause = pauseBeforeWrite();
  const pending = Promise.allSettled([changeDocument(admin, { kind: "projects", id: projectId }, {
    pageId: revokedPage, subject, spaceId: `${prefix}-revoked-space`, setDefault: true,
  })]);
  try {
    await pause.ready();
    await db.session.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });
    pause.release();
    expect(await pending).toEqual([expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ status: 401 }) })]);
    expect(await db.holySheetLink.count({ where: { projectId, pageId: revokedPage } })).toBe(0);
    expect(await db.holySheetDefault.findUnique({ where: { projectId } })).toEqual(beforeDefault);
    completed.push("revoked-session-no-link");
  } finally {
    pause.release(); await pending;
    await db.session.update({ where: { id: sessionId }, data: { revokedAt: null } });
  }
}, 20_000);

it("returns a retryable conflict while the Admin account role is locked", async () => {
  const lockedPage = randomUUID();
  let release!: () => void, reached!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const atLock = new Promise<void>((resolve) => { reached = resolve; });
  const blocker = transact(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${admin.id} FOR UPDATE`;
    reached(); await held;
  });
  const safety = setTimeout(() => release(), 15_000);
  try {
    await atLock;
    await expect(changeDocument(admin, { kind: "projects", id: projectId }, { pageId: lockedPage, subject })).rejects.toMatchObject({ status: 409 });
    expect(await db.holySheetLink.count({ where: { projectId, pageId: lockedPage } })).toBe(0);
  } finally { clearTimeout(safety); release(); await blocker; }
  await changeDocument(admin, { kind: "projects", id: projectId }, { pageId: lockedPage, subject });
  expect(await db.holySheetLink.count({ where: { projectId, pageId: lockedPage } })).toBe(1);
  completed.push("account-lock-retry");
}, 20_000);

it("allows an active Admin to save the same reference once", async () => {
  await changeDocument(admin, { kind: "projects", id: projectId }, { pageId, subject });
  expect(await db.holySheetLink.count({ where: { projectId, pageId } })).toBe(1);
  completed.push("active-admin-control");
});
