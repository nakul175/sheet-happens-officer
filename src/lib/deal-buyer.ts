import { z } from "zod";
import { db } from "@/lib/db";
import { isAdmin, projectAccess, requireManage, type Actor } from "@/lib/access";
import { requireCrm, WORKSTREAM_DEAL } from "@/lib/crm";
import { ApiError, notFound } from "@/lib/http";
import { logAction } from "@/lib/notify";

export const dealBuyerReplacement = z.object({
  organisationId: z.string().trim().min(1),
  expectedOrganisationId: z.string().trim().min(1),
});

/** Replace a relationship, never the Account record. Existing Leader/Admin management authority only. */
export async function replaceDealBuyer(user: Actor, projectId: string, input: z.infer<typeof dealBuyerReplacement>) {
  requireCrm(user);
  const a = await projectAccess(user, projectId, { write: true });
  requireManage(a);
  if (a.project.typeId !== WORKSTREAM_DEAL) throw new ApiError(400, "Only deals have a Buyer.");
  const parsed = dealBuyerReplacement.safeParse(input);
  if (!parsed.success) throw new ApiError(400, "Choose an existing Buyer and refresh the deal before saving.");
  const { organisationId, expectedOrganisationId } = parsed.data;
  return db.$transaction(async (tx) => {
    // Serialize competing replacements; a stale dialog must never overwrite a newer Buyer.
    await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${projectId} FOR UPDATE`;
    const project = await tx.project.findUnique({ where: { id: projectId }, include: { members: true } });
    if (!project || project.typeId !== WORKSTREAM_DEAL) throw notFound("Deal");
    const member = project.members.find((m) => m.userId === user.id);
    if (!member && !isAdmin(user)) throw notFound("Project");
    if (!isAdmin(user) && member?.role !== "LEADER") throw new ApiError(403, "Only the project Leader or an Admin can do this.");
    if (project.archivedAt) throw new ApiError(409, "This project is archived and read-only.");
    const buyer = await tx.dealParty.findFirst({ where: { projectId, role: "BUYER" }, include: { organisation: { select: { id: true, name: true } } } });
    if (!buyer) throw new ApiError(409, "This deal has no Buyer. Refresh and ask an Admin to inspect it.");
    if (buyer.organisationId !== expectedOrganisationId) throw new ApiError(409, "The Buyer changed since you opened this dialog. Refresh the deal and try again.");
    if (buyer.organisationId === organisationId) return { changed: false };
    // Prevent an Account being archived while this relationship is being selected.
    await tx.$queryRaw`SELECT "id" FROM "Organisation" WHERE "id" = ${organisationId} AND "workspaceId" = ${project.workspaceId} FOR SHARE`;
    const organisation = await tx.organisation.findFirst({ where: { id: organisationId, workspaceId: project.workspaceId } });
    if (!organisation) throw new ApiError(400, "Choose an existing organisation in this workspace.");
    if (organisation.archivedAt) throw new ApiError(409, "That organisation is archived. Choose an active organisation.");
    // Serialize replacements of different deals into the same name+Buyer combination.
    // Use PostgreSQL case-folding to match the database's case-insensitive name lookup.
    // Creation/conversion do not yet take this lock; this does not claim to fix their existing race.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array('sho-deal-buyer', ${project.workspaceId}::text, ${organisationId}::text, lower(${project.name}::text))::text, 0))::text AS locked`;
    // Match creation's name+Buyer duplicate policy; replacement cannot bypass it silently.
    const duplicate = await tx.project.findFirst({ where: { id: { not: projectId }, workspaceId: project.workspaceId, typeId: WORKSTREAM_DEAL, name: { equals: project.name, mode: "insensitive" }, parties: { some: { organisationId, role: "BUYER" } } }, select: { id: true } });
    if (duplicate) throw new ApiError(409, "A deal with this name already exists for that Buyer. Resolve the duplicate before changing Buyer.");
    await tx.dealParty.update({ where: { id: buyer.id }, data: { organisationId } });
    await logAction(tx, {
      actorId: user.id, projectId, targetType: "deal", targetId: projectId, action: "deal.buyer_changed",
      before: { partyId: buyer.id, organisationId: buyer.organisationId, organisation: buyer.organisation.name },
      after: { partyId: buyer.id, organisationId, organisation: organisation.name },
      // No Undo implementation for this action; retain accurate history without offering unsupported Undo.
      primary: false,
    });
    return { changed: true };
  });
}
