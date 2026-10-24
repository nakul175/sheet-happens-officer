import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ access: vi.fn(), transaction: vi.fn(), create: vi.fn(), log: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { $transaction: m.transaction } }));
vi.mock("@/lib/access", () => ({ projectAccess: m.access, requireWrite: vi.fn(), activeMember: vi.fn(async () => ({ role: "LEADER", user: { deactivatedAt: null, emailVerifiedAt: new Date() } })), WORKSTREAM_PROJECT: "wst_project", WORKERS: ["LEADER", "EDITOR"] }));
vi.mock("@/lib/deals", () => ({ ensureNextStep: vi.fn() }));
vi.mock("@/lib/records", () => ({ linksOfTask: vi.fn() }));
vi.mock("@/lib/notify", () => ({ logAction: m.log, notify: vi.fn(), auditTx: vi.fn() }));
import { createTask } from "@/lib/tasks";
import { taskCreate, taskUpdate } from "@/lib/schemas";
import { creationNeedsDue, validTaskDue } from "@/lib/task-creation-policy";
const actor = { id: "actor", orgRole: "MEMBER" as const };
beforeEach(() => {
 vi.clearAllMocks();
 m.access.mockResolvedValue({ project: { id: "project", workspaceId: "ws", typeId: "wst_project" }, role: "LEADER" });
 m.create.mockResolvedValue({ id: "created", title: "Title" });
 m.transaction.mockImplementation(async fn => fn({ section: { findFirst: vi.fn(async () => ({ id: "section" })) }, task: { create: m.create, findFirst: vi.fn(async () => ({ id: "parent", sectionId: "section", parentId: null })) }, projectMember: { findUnique: vi.fn(async () => ({ user: { deactivatedAt: null, emailVerifiedAt: new Date() }, role: "LEADER" })) } }));
});
it.each([undefined, null, ""])("rejects missing due %s before creating a top-level Project/Inbox task", async dueDate => {
 await expect(createTask(actor, "project", { title: "Title", dueDate })).rejects.toMatchObject({ status: 400 });
 expect(m.transaction).not.toHaveBeenCalled(); expect(m.create).not.toHaveBeenCalled();
});
it("creates a real undated Idea atomically and records it in creation history", async () => {
 await createTask(actor, "project", { title: "Title", isIdea: true });
 expect(m.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ isIdea: true, dueDate: null }) }));
 expect(m.log).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "task.created", after: expect.objectContaining({ isIdea: true }) }));
});
it("keeps undated subtasks optional but rejects a subtask pretending to be an Idea", async () => {
 await createTask(actor, "project", { title: "Title", parentId: "parent" });
 expect(m.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ parentId: "parent", dueDate: null, isIdea: false }) }));
 await expect(createTask(actor, "project", { title: "Title", parentId: "parent", isIdea: true })).rejects.toMatchObject({ status: 400 });
});
it("preserves Deal task creation policy", async () => {
 m.access.mockResolvedValue({ project: { id: "deal", workspaceId: "ws", typeId: "wst_deal" }, role: "LEADER" });
 await createTask(actor, "deal", { title: "Title" }); expect(m.create).toHaveBeenCalled();
});
it("accepts a real calendar date without inventing or altering its value", async () => {
 await createTask(actor, "project", { title: "Title", dueDate: "2028-02-29" });
 expect(m.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ dueDate: new Date("2028-02-28T18:30:00Z") }) }));
});
it.each(["2026-02-30", "2026-13-01", "not a date"])("rejects invalid calendar date %s in schema and direct domain creation", async value => {
 expect(taskCreate.safeParse({ title: "Title", dueDate: value }).success).toBe(false);
 await expect(createTask(actor, "project", { title: "Title", dueDate: value })).rejects.toMatchObject({ status: 400 });
});
it("retains legacy edit clearing and optional fields, and validates atomic Idea flag", () => {
 expect(taskUpdate.safeParse({ title: "Renamed" }).success).toBe(true);
 expect(taskUpdate.safeParse({ dueDate: null }).success).toBe(true);
 expect(taskCreate.safeParse({ title: "Idea", isIdea: true }).success).toBe(true);
 expect(taskCreate.safeParse({ title: "Fake", isIdea: "yes" }).success).toBe(false);
 expect(creationNeedsDue("wst_project", {})).toBe(true);
 expect(creationNeedsDue("wst_project", { parentId: "parent" })).toBe(false);
 expect(validTaskDue("2028-02-29")).toBe(true);
});

it("preserves visibility/write authorization before explaining creation policy", async () => {
 m.access.mockRejectedValue(Object.assign(new Error("Project not found"), { status: 404 }));
 await expect(createTask(actor, "private", { title: "Title" })).rejects.toMatchObject({ status: 404 });
 expect(m.transaction).not.toHaveBeenCalled();
});
