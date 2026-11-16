// APL-2684: Include archived search. Membership and the archive flag are separate, so an
// Admin or Super Admin sees archived projects they are not a member of, and a Member does not.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/access";

const db = vi.hoisted(() => ({
  user: { findUniqueOrThrow: vi.fn() },
  organisation: { findMany: vi.fn() },
  contact: { findMany: vi.fn() },
  project: { findMany: vi.fn() },
  task: { findMany: vi.fn() },
  comment: { findMany: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ db }));

import { search } from "@/lib/search";

type Where = Record<string, unknown>;
const argWhere = (fn: { mock: { calls: unknown[][] } }) => (fn.mock.calls.at(-1)?.[0] as { where: Where }).where;

const admin: Actor = { id: "admin-1", orgRole: "ADMIN" };
const superAdmin: Actor = { id: "root-1", orgRole: "SUPER_ADMIN" };
const member: Actor = { id: "member-1", orgRole: "MEMBER" };
const other: Actor = { id: "member-2", orgRole: "MEMBER" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SEARCH_STAGE_A_ENABLED", "false");
  db.user.findUniqueOrThrow.mockResolvedValue({ workspaceId: "ws-1" });
  db.organisation.findMany.mockResolvedValue([]);
  db.contact.findMany.mockResolvedValue([]);
  db.project.findMany.mockResolvedValue([]);
  db.task.findMany.mockResolvedValue([]);
  db.comment.findMany.mockResolvedValue([]);
});
afterEach(() => vi.unstubAllEnvs());

describe("Include archived search (APL-2684)", () => {
  it("keeps idea-only and comment hits inside the same live visible task boundary", async () => {
    vi.stubEnv("FF_TASK_COMMENTS", "true");
    db.comment.findMany.mockResolvedValue([{ taskId: "task-1" }]);
    db.task.findMany.mockResolvedValue([{
      id: "task-1", title: "Review", completedAt: null, isIdea: true,
      assignee: { name: "Lee" }, project: { id: "project-1", name: "Private", archivedAt: null },
    }]);
    const found = await search(member, "secret phrase", false, true);
    const commentWhere = argWhere(db.comment.findMany);
    expect(commentWhere.removedAt).toBeNull();
    expect((commentWhere.task as Where).deletedAt).toBeNull();
    expect((commentWhere.task as Where).isIdea).toBe(true);
    expect(((commentWhere.task as Where).project as Where).members).toEqual({ some: { userId: member.id } });
    expect(((commentWhere.task as Where).project as Where).deletedAt).toBeNull();
    const taskWhere = argWhere(db.task.findMany);
    expect(taskWhere.deletedAt).toBeNull();
    expect(taskWhere.isIdea).toBe(true);
    expect((taskWhere.project as Where).members).toEqual({ some: { userId: member.id } });
    expect(found.tasks.map((t) => t.id)).toEqual(["task-1"]);
    expect(JSON.stringify(found)).not.toContain("secret phrase");
    expect(db.organisation.findMany).not.toHaveBeenCalled();
    expect(db.contact.findMany).not.toHaveBeenCalled();
  });

  it("bounds direct legacy queries before every database search", async () => {
    const long = "b".repeat(400);
    await search(admin, long, false);
    for (const fn of [db.organisation.findMany, db.contact.findMany, db.project.findMany]) {
      expect((argWhere(fn).name as { contains: string }).contains).toHaveLength(200);
    }
    expect(((argWhere(db.task.findMany).title as { contains: string }).contains)).toHaveLength(200);
  });
  it("hides contacts of archived organisations until Include archived is selected", async () => {
    await search(admin, "vault", false);
    expect(argWhere(db.organisation.findMany).archivedAt).toBeNull();
    expect(argWhere(db.contact.findMany).organisation).toEqual({ archivedAt: null });

    await search(admin, "vault", true);
    expect(argWhere(db.organisation.findMany).archivedAt).toBeUndefined();
    expect(argWhere(db.contact.findMany)).not.toHaveProperty("organisation");
  });
  it("shows Admins and Super Admins archived projects they are not members of", async () => {
    for (const user of [admin, superAdmin]) {
      await search(user, "vault", true);
      for (const where of [argWhere(db.project.findMany), argWhere(db.task.findMany).project as Where]) {
        expect(where).not.toHaveProperty("members");
        expect(where).not.toHaveProperty("archivedAt");
      }
      await search(user, "vault", false);
      for (const where of [argWhere(db.project.findMany), argWhere(db.task.findMany).project as Where]) {
        expect(where).not.toHaveProperty("members");
        expect(where.archivedAt).toBeNull();
      }
    }

    const archivedAt = new Date("2026-10-01T00:00:00Z");
    db.project.findMany.mockResolvedValue([{ id: "p-arch", name: "Vault", archivedAt, typeId: "wst_project" }]);
    db.task.findMany.mockResolvedValue([{
      id: "t-arch", title: "Vault task", completedAt: null, isIdea: false, assignee: { name: "Lee" },
      project: { id: "p-arch", name: "Vault", archivedAt },
    }]);
    const found = await search(admin, "vault", true);
    expect(found.projects).toEqual([{ id: "p-arch", name: "Vault", archived: true, type: "PROJECT" }]);
    expect(found.tasks).toEqual([{
      id: "t-arch", title: "Vault task", done: false, isIdea: false, assignee: "Lee",
      project: { id: "p-arch", name: "Vault" }, archived: true,
    }]);
  });

  it("keeps Members to their own projects when Include archived is on", async () => {
    for (const user of [member, other]) {
      for (const includeArchived of [true, false]) {
        await search(user, "vault", includeArchived);
        for (const where of [argWhere(db.project.findMany), argWhere(db.task.findMany).project as Where]) {
          expect(where.members).toEqual({ some: { userId: user.id } });
          if (includeArchived) expect(where).not.toHaveProperty("archivedAt");
          else expect(where.archivedAt).toBeNull();
        }
      }
    }
  });
});
