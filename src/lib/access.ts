import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { ApiError, notFound } from "@/lib/http";

export type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0];
export type Role = "VIEWER" | "EDITOR" | "LEADER";
export type OrgRole = "MEMBER" | "ADMIN" | "SUPER_ADMIN";
export type Actor = { id: string; orgRole: OrgRole; name?: string };

export const isAdmin = (u: { orgRole: OrgRole }) => u.orgRole !== "MEMBER";

// The CRM visibility lever (CRM_VISIBLE; documented in crm.ts, which re-exports these). It lives here so
// projectAccess can apply it without an import cycle (crm.ts imports access.ts). Read at call time: a restart is enough.
export type CrmMode = "all" | "admins" | "off";
export const WORKSTREAM_PROJECT = "wst_project";
export const WORKSTREAM_DEAL = "wst_deal";

export function crmMode(): CrmMode {
  const m = (process.env.CRM_VISIBLE ?? "all").trim().toLowerCase();
  return m === "off" || m === "admins" ? m : "all";
}

export function crmVisible(user: Pick<Actor, "orgRole">) {
  const m = crmMode();
  return m === "all" || (m === "admins" && isAdmin(user));
}

/** Project `where` fragment: deals are left out for a person the CRM is hidden from (SHO-BUG-2). Spread it into any project filter. */
export const crmProjectWhere = (user: Pick<Actor, "orgRole">): Prisma.ProjectWhereInput =>
  crmVisible(user) ? {} : { typeId: { not: WORKSTREAM_DEAL } };

/**
 * Loads a project the person may see. Non-members get "not found", never "forbidden"
 * (SHO-US-3.2 AC4). Admins and the Super Admin act as Leader everywhere.
 */
export async function projectAccess(user: Actor, projectId: string, opts: { write?: boolean } = {}) {
  const project = await db.project.findUnique({ where: { id: projectId }, include: { members: true } });
  const member = project?.members.find((m) => m.userId === user.id) ?? null;
  if (!project || (!member && !isAdmin(user))) throw notFound("Project");
  // A hidden CRM looks like it does not exist: a deal, and so every task, section and log row in it, is "not found" (SHO-BUG-2).
  if (project.typeId === WORKSTREAM_DEAL && !crmVisible(user)) throw notFound("Project");
  const role: Role = isAdmin(user) ? "LEADER" : member!.role;
  if (opts.write && project.archivedAt) throw new ApiError(409, "This project is archived and read-only.");
  return { project, role, member, admin: isAdmin(user) };
}
export type Access = Awaited<ReturnType<typeof projectAccess>>;

export function requireWrite(a: Access) {
  if (a.role === "VIEWER") throw new ApiError(403, "Viewers cannot make changes.");
}
export function requireManage(a: Access) {
  if (a.role !== "LEADER") throw new ApiError(403, "Only the project Leader or an Admin can do this.");
}

export const isActive = (u: { deactivatedAt: Date | null; emailVerifiedAt: Date | null }) =>
  !u.deactivatedAt && !!u.emailVerifiedAt;

/** The active person's membership, optionally limited to some roles; null when not eligible. */
export async function activeMember(tx: Tx, projectId: string, userId: string, roles?: Role[]) {
  const m = await tx.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
    include: { user: true },
  });
  if (!m || !isActive(m.user)) return null;
  if (roles && !roles.includes(m.role)) return null;
  return m;
}
export const WORKERS: Role[] = ["LEADER", "EDITOR"];

export async function leaderId(tx: Tx, projectId: string) {
  const l = await tx.projectMember.findFirst({ where: { projectId, role: "LEADER" } });
  if (!l) throw new ApiError(500, "Project has no Leader");
  return l.userId;
}
