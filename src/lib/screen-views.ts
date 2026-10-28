import { z } from "zod";
import { db } from "@/lib/db";
import { isAdmin, projectAccess, type Actor, type Tx } from "@/lib/access";
import { requireCrm } from "@/lib/crm";
import { ApiError, notFound } from "@/lib/http";
import { screenViewHref, screenFilters, screenViewInput, type ViewScreen } from "@/lib/screen-view-state";
export { screenViewInput } from "@/lib/screen-view-state";
export const PRIVATE_SCREEN_VIEWS = 10, SHARED_WORKSPACE_VIEWS = 20;
async function workspace(user: Actor) {
  requireCrm(user);
  const u = await db.user.findUnique({ where: { id: user.id }, select: { workspaceId: true } });
  if (!u) throw notFound("View");
  return u.workspaceId;
}
async function visibleWhere(user: Actor) {
  const workspaceId = await workspace(user);
  const memberships = await db.projectMember.findMany({ where: { userId: user.id, project: { workspaceId } }, select: { projectId: true } });
  return { workspaceId, OR: [
    { scope: "PRIVATE", userId: user.id }, { scope: "WORKSPACE" },
    { scope: "PROJECT", project: { ...(isAdmin(user) ? {} : { id: { in: memberships.map(m => m.projectId) } }) } },
  ] };
}
const ownerInclude = { user: { select: { id: true, name: true } } } as const;
type ViewRow = { id: string; screen: string; name: string; scope: string; projectId: string | null; state: unknown; user: { id: string; name: string } };
function present(user: Actor, v: ViewRow) {
  const screen = v.screen as ViewScreen;
  return { id: v.id, screen, name: v.name, scope: v.scope, projectId: v.projectId, state: screenFilters.parse(v.state), owner: v.user, canEdit: v.user.id === user.id || isAdmin(user), href: screenViewHref(screen, v.state, v.id) };
}
export async function listScreenViews(user: Actor, screen?: ViewScreen) {
  const rows = await db.screenSavedView.findMany({ where: { ...await visibleWhere(user), ...(screen ? { screen } : {}) }, include: ownerInclude, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  return rows.map(v => present(user, v));
}
export async function getScreenView(user: Actor, id: string, screen: ViewScreen) {
  const v = await db.screenSavedView.findFirst({ where: { ...await visibleWhere(user), id, screen }, include: ownerInclude });
  if (!v) throw notFound("View");
  return present(user, v);
}
async function editable(user: Actor, id: string) {
  const v = await db.screenSavedView.findFirst({ where: { ...await visibleWhere(user), id }, include: ownerInclude });
  if (!v) throw notFound("View");
  if (v.userId !== user.id && !isAdmin(user)) throw new ApiError(403, "Only the owner or an Admin can change this view.");
  return v;
}
export async function assertScreenViewEditable(user: Actor, id: string) { return editable(user, id); }
async function limits(tx: Tx, workspaceId: string, userId: string, screen: ViewScreen, scope: string, except?: string) {
  // Serialize saves and reshares for the whole workspace, so concurrent requests cannot exceed either cap.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}))`;
  const count = await tx.screenSavedView.count({ where: { workspaceId, ...(except ? { id: { not: except } } : {}), ...(scope === "PRIVATE" ? { userId, screen, scope: "PRIVATE" } : { scope: { not: "PRIVATE" } }) } });
  const cap = scope === "PRIVATE" ? PRIVATE_SCREEN_VIEWS : SHARED_WORKSPACE_VIEWS;
  if (count >= cap) throw new ApiError(409, scope === "PRIVATE" ? "You can keep 10 private views per screen. Delete one to save another." : "The workspace can keep 20 shared views. Delete one to share another.");
}
export async function saveScreenView(user: Actor, input: z.infer<typeof screenViewInput>, id?: string) {
  const workspaceId = await workspace(user);
  const previous = id ? await editable(user, id) : null;
  if (previous && previous.screen !== input.screen) throw new ApiError(400, "A view cannot move to another screen.");
  if (input.projectId) {
    const { project } = await projectAccess(user, input.projectId);
    if (project.workspaceId !== workspaceId || project.archivedAt) throw notFound("Project");
  }
  const ownerId = previous?.userId ?? user.id;
  const row = await db.$transaction(async tx => {
    await limits(tx, workspaceId, ownerId, input.screen, input.scope, id);
    const data = { name: input.name, screen: input.screen, scope: input.scope, projectId: input.projectId, state: input.state };
    return id ? tx.screenSavedView.update({ where: { id }, data, include: ownerInclude }) : tx.screenSavedView.create({ data: { ...data, workspaceId, userId: ownerId }, include: ownerInclude });
  });
  return present(user, row);
}
export async function deleteScreenView(user: Actor, id: string, confirmShared = false) {
  const v = await editable(user, id);
  await db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${v.workspaceId}))`;
    // A concurrent reshare may have changed private -> shared while this request waited.
    const current = await tx.screenSavedView.findUnique({ where: { id } });
    if (!current) throw notFound("View");
    if (current.scope !== "PRIVATE" && !confirmShared) throw new ApiError(409, "This view is shared. Delete it for everyone?", { needsConfirm: "shared_view" });
    await tx.screenSavedView.delete({ where: { id } });
  });
}
export async function findScreenViews(user: Actor, name: string) {
  const q = name.trim().toLocaleLowerCase();
  return (await listScreenViews(user)).filter(v => v.name.toLocaleLowerCase().includes(q)).slice(0, 20);
}
