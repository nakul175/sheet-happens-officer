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
const subject = "12345678-1234-4234-8234-123456789abc";
const pageId = randomUUID();
const completed: string[] = [];
const transact = db.$transaction.bind(db);
let workspaceId: string, projectId: string, sessionId: string, safe = false;

beforeAll(async () => {
  assertLocalFixture(process.env.DATABASE_URL); safe = true;
  vi.stubEnv("FF_HOLY_SHEET", "1");
  vi.stubEnv("HOLY_SHEET_ORIGIN", "https://holysheet.aplyd.org");
  workspaceId = (await getOrCreateWorkspace()).id;
  for (const actor of [admin, leader]) {
    await db.user.create({ data: { id: actor.id, workspaceId, name: actor.id, email: `${actor.id}@example.invalid`, passwordHash: "unused", emailVerifiedAt: new Date(), orgRole: actor.orgRole } });
  }
  projectId = (await db.project.create({ data: { workspaceId, name: prefix } })).id;
  await db.projectMember.create({ data: { projectId, userId: leader.id, role: "LEADER" } });
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
    await db.user.deleteMany({ where: { id: { in: [admin.id, leader.id] } } });
    expect(await db.holySheetLink.count({ where: { projectId } })).toBe(0);
    expect(await db.user.count({ where: { id: { in: [admin.id, leader.id] } } })).toBe(0);
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
