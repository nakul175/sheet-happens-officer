import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ user: { findUnique: vi.fn() }, projectMember: { findMany: vi.fn(), findUnique: vi.fn() }, screenSavedView: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), count: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() }, $executeRaw: vi.fn(), $transaction: vi.fn(), projectAccess: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: mocks }));
vi.mock("@/lib/access", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/access")>(), projectAccess: mocks.projectAccess }));
import { deleteScreenView, getScreenView, listScreenViews, saveScreenView } from "@/lib/screen-views";
import { filtersFromQuery, screenFilters, screenViewHref, screenViewInput } from "@/lib/screen-view-state";
const user = { id: "owner", orgRole: "MEMBER" as const };
const admin = { id: "admin", orgRole: "ADMIN" as const };
const input = screenViewInput.parse({ screen: "DEALS", name: "Bids closing", state: { atRisk: true }, scope: "WORKSPACE" });
const row = { ...input, id: "view1", userId: "owner", workspaceId: "w1", user: { id: "owner", name: "Owner" } };
beforeEach(() => {
  vi.resetAllMocks(); vi.unstubAllEnvs();
  mocks.user.findUnique.mockResolvedValue({ workspaceId: "w1" });
  mocks.projectMember.findMany.mockResolvedValue([{ projectId: "visible-project" }]);
  mocks.projectMember.findUnique.mockResolvedValue({ projectId: "visible-project" });
  mocks.screenSavedView.findMany.mockResolvedValue([row]);
  mocks.screenSavedView.findFirst.mockResolvedValue(row);
  mocks.screenSavedView.findUnique.mockResolvedValue(row);
  mocks.screenSavedView.count.mockResolvedValue(0);
  mocks.screenSavedView.create.mockResolvedValue(row);
  mocks.screenSavedView.update.mockResolvedValue(row);
  mocks.projectAccess.mockResolvedValue({ project: { workspaceId: "w1", archivedAt: null } });
  mocks.$transaction.mockImplementation(async fn => fn(mocks));
});
describe("SHO-2594 saved screen views", () => {
  it("validates project scope, strips unknown values and constrains links to known local screens", () => {
    expect(screenViewInput.safeParse({ ...input, scope: "PROJECT", projectId: null }).success).toBe(false);
    expect(screenViewInput.safeParse({ ...input, scope: "WORKSPACE", projectId: "p1" }).success).toBe(false);
    const state = screenFilters.parse({ q: "a&b\n", country: "India", href: "https://evil.test" });
    const href = screenViewHref("ACCOUNTS", state, "v&x");
    expect(href.startsWith("/accounts?")).toBe(true);
    const query = new URL(href, "https://local.test").searchParams;
    expect(query.get("q")).toBe("a&b\n"); expect(query.get("view")).toBe("v&x");
    expect(filtersFromQuery(query)).toEqual(state);
    expect(href).not.toContain("evil.test");
  });
  it("selects private-own, workspace, and current project memberships within one workspace", async () => {
    const r = await listScreenViews(user, "DEALS");
    expect(mocks.screenSavedView.findMany.mock.calls[0][0].where).toEqual({ workspaceId: "w1", screen: "DEALS", OR: [{ scope: "PRIVATE", userId: "owner" }, { scope: "WORKSPACE" }, { scope: "PROJECT", project: { id: { in: ["visible-project"] } } }] });
    expect(r[0]).toMatchObject({ canEdit: true, owner: { id: "owner", name: "Owner" } });
    expect(r[0].href).toContain("atRisk=true");
  });
  it("resolves a named link to the latest visible definition on the requested screen", async () => {
    mocks.screenSavedView.findFirst.mockResolvedValue({ ...row, state: { ...row.state, atRisk: false, stageId: "latest" } });
    expect((await getScreenView(user, "view1", "DEALS")).state.stageId).toBe("latest");
    expect(mocks.screenSavedView.findFirst.mock.calls[0][0].where).toMatchObject({ id: "view1", screen: "DEALS", workspaceId: "w1" });
    mocks.screenSavedView.findFirst.mockResolvedValue(null);
    await expect(getScreenView(user, "hidden", "DEALS")).rejects.toMatchObject({ status: 404 });
  });
  it("requires current project membership even for an Admin's project-shared views", async () => {
    mocks.projectMember.findMany.mockResolvedValue([]);
    await listScreenViews(admin, "REVIEW");
    expect(mocks.screenSavedView.findMany.mock.calls[0][0].where.OR[2]).toEqual({ scope: "PROJECT", project: { id: { in: [] } } });
    mocks.projectMember.findUnique.mockResolvedValue(null);
    await expect(saveScreenView(admin, { ...input, scope: "PROJECT", projectId: "p1" })).rejects.toMatchObject({ status: 404 });
    expect(mocks.screenSavedView.create).not.toHaveBeenCalled();
  });
  it("hides all saved CRM views before querying them when CRM is hidden", async () => {
    vi.stubEnv("CRM_VISIBLE", "off");
    await expect(listScreenViews(user, "DEALS")).rejects.toMatchObject({ status: 404 });
    expect(mocks.screenSavedView.findMany).not.toHaveBeenCalled();
    await expect(saveScreenView(user, input)).rejects.toMatchObject({ status: 404 });
  });
  it("prevents other members editing or deleting a shared view", async () => {
    await expect(saveScreenView({ id: "other", orgRole: "MEMBER" }, input, "view1")).rejects.toMatchObject({ status: 403 });
    await expect(deleteScreenView({ id: "other", orgRole: "MEMBER" }, "view1", true)).rejects.toMatchObject({ status: 403 });
    expect(mocks.screenSavedView.update).not.toHaveBeenCalled();
    expect(mocks.screenSavedView.delete).not.toHaveBeenCalled();
  });
  it("allows an Admin edit without taking ownership and requires shared deletion confirmation", async () => {
    await saveScreenView(admin, input, "view1");
    expect(mocks.screenSavedView.update.mock.calls[0][0].data.userId).toBeUndefined();
    await expect(deleteScreenView(admin, "view1")).rejects.toMatchObject({ status: 409, extra: { needsConfirm: "shared_view" } });
    await deleteScreenView(admin, "view1", true);
    expect(mocks.screenSavedView.delete).toHaveBeenCalledWith({ where: { id: "view1" } });
  });
  it("rechecks sharing inside the workspace lock before deletion", async () => {
    mocks.screenSavedView.findFirst.mockResolvedValue({ ...row, scope: "PRIVATE" });
    mocks.screenSavedView.findUnique.mockResolvedValue(row);
    await expect(deleteScreenView(user, "view1")).rejects.toMatchObject({ status: 409 });
    expect(mocks.screenSavedView.delete).not.toHaveBeenCalled();
  });
  it("checks project access and rejects cross-workspace or archived share targets", async () => {
    const projectInput = screenViewInput.parse({ ...input, scope: "PROJECT", projectId: "p2" });
    mocks.projectAccess.mockResolvedValue({ project: { workspaceId: "w2", archivedAt: null } });
    await expect(saveScreenView(user, projectInput)).rejects.toMatchObject({ status: 404 });
    expect(mocks.screenSavedView.create).not.toHaveBeenCalled();
    mocks.projectAccess.mockResolvedValue({ project: { workspaceId: "w1", archivedAt: new Date() } });
    await expect(saveScreenView(user, projectInput)).rejects.toMatchObject({ status: 404 });
  });
  it("serializes saves and caps shared workspace views across screens at 20", async () => {
    mocks.screenSavedView.count.mockResolvedValue(20);
    await expect(saveScreenView(user, input)).rejects.toMatchObject({ status: 409 });
    expect(mocks.$executeRaw).toHaveBeenCalled();
    expect(mocks.screenSavedView.count.mock.calls[0][0].where).toEqual({ workspaceId: "w1", scope: { not: "PRIVATE" } });
    expect(mocks.screenSavedView.create).not.toHaveBeenCalled();
  });
  it("caps private views at 10 per owner per screen, excluding the edited view", async () => {
    mocks.screenSavedView.count.mockResolvedValue(10);
    await expect(saveScreenView(admin, { ...input, scope: "PRIVATE" }, "view1")).rejects.toMatchObject({ status: 409 });
    expect(mocks.screenSavedView.count.mock.calls[0][0].where).toEqual({ workspaceId: "w1", userId: "owner", screen: "DEALS", scope: "PRIVATE", id: { not: "view1" } });
  });
  it("reports hidden/deleted views as missing and prevents changing their screen", async () => {
    mocks.screenSavedView.findFirst.mockResolvedValueOnce(null);
    await expect(saveScreenView(user, input, "missing")).rejects.toMatchObject({ status: 404 });
    await expect(saveScreenView(user, { ...input, screen: "ACCOUNTS" }, "view1")).rejects.toMatchObject({ status: 400 });
  });
});
