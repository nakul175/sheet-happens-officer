// SHO-2588: advisory only. No merge or delete operations live here.
import { db } from "@/lib/db";
import { ApiError } from "@/lib/http";
import { isAdmin, type Actor, WORKSTREAM_DEAL, projectAccess } from "@/lib/access";
import { requireCrm } from "@/lib/crm";

export function duplicateThreshold() {
  const value = Number(process.env.DUPLICATE_SIMILARITY_THRESHOLD ?? "0.4");
  return Number.isFinite(value) && value > 0 && value <= 1 ? value : 0.4;
}
export type Duplicate = { id: string; name: string; organisationId?: string };
export async function organisationDuplicates(workspaceId: string, name: string) {
  const rows = await db.$queryRaw<Duplicate[]>`SELECT id, name FROM "Organisation" WHERE "workspaceId" = ${workspaceId} AND similarity(lower(name), lower(${name})) >= ${duplicateThreshold()} ORDER BY similarity(lower(name), lower(${name})) DESC, id LIMIT 6`;
  return rows;
}
export async function organisationDuplicate(workspaceId: string, name: string) { return (await organisationDuplicates(workspaceId, name))[0]; }
export async function contactDuplicates(workspaceId: string, organisationId: string, name: string, email?: string | null) {
  const rows = await db.$queryRaw<Duplicate[]>`SELECT id, name, "organisationId" FROM "Contact" WHERE "workspaceId" = ${workspaceId} AND "removedAt" IS NULL AND ((nullif(${email?.trim() ?? ""}, '') IS NOT NULL AND lower(email) = lower(${email?.trim() ?? ""})) OR ("organisationId" = ${organisationId} AND similarity(lower(name), lower(${name})) >= ${duplicateThreshold()})) ORDER BY id LIMIT 6`;
  return rows;
}
export async function contactDuplicate(workspaceId: string, organisationId: string, name: string, email?: string | null) { return (await contactDuplicates(workspaceId, organisationId, name, email))[0]; }
export async function dealDuplicate(workspaceId: string, name: string) {
  const rows = await db.$queryRaw<Duplicate[]>`SELECT id, name FROM "Project" WHERE "workspaceId" = ${workspaceId} AND "typeId" = ${WORKSTREAM_DEAL} AND similarity(lower(name), lower(${name})) >= ${duplicateThreshold()} ORDER BY similarity(lower(name), lower(${name})) DESC, id LIMIT 1`;
  return rows[0];
}
export function duplicateWarning(kind: string, duplicate: Duplicate, candidates: Duplicate[] = [duplicate]) {
  const matches = candidates.slice(0, 5);
  return new ApiError(409, `Possible duplicate ${kind}: “${duplicate.name}”. Use this one or create anyway.`, { needsConfirm: "duplicate", existingId: duplicate.id, existingName: duplicate.name, organisationId: duplicate.organisationId, matches, truncated: candidates.length > 5 });
}
/** Detection is broad, but identifying fields follow fresh project visibility. */
export async function dealDuplicateWarning(user: Actor, duplicate: Duplicate) {
  try {
    await projectAccess(user, duplicate.id);
    return duplicateWarning("deal", duplicate);
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
    return new ApiError(409, "A possible duplicate deal exists. Create anyway if this is a separate deal.", { needsConfirm: "duplicate" });
  }
}
async function adminWorkspace(user: Actor) {
  requireCrm(user);
  if (!isAdmin(user)) throw new ApiError(403, "Only Admins can review duplicates.");
  return (await db.user.findUniqueOrThrow({ where: { id: user.id }, select: { workspaceId: true } })).workspaceId;
}
export type DuplicatePair = { kind: "organisation" | "contact"; leftId: string; rightId: string; leftName: string; rightName: string; leftOrg: string | null; rightOrg: string | null };
export async function likelyDuplicates(user: Actor) {
  const workspaceId = await adminWorkspace(user);
  return db.$queryRaw<DuplicatePair[]>`
    WITH pairs AS (
      SELECT 'organisation' AS kind, a.id AS "leftId", b.id AS "rightId", a.name AS "leftName", b.name AS "rightName", a.id AS "leftOrg", b.id AS "rightOrg"
      FROM "Organisation" a JOIN "Organisation" b ON a.id < b.id AND a."workspaceId" = b."workspaceId"
      WHERE a."workspaceId" = ${workspaceId} AND similarity(lower(a.name), lower(b.name)) >= ${duplicateThreshold()}
      UNION ALL
      SELECT 'contact', a.id, b.id, a.name, b.name, a."organisationId", b."organisationId"
      FROM "Contact" a JOIN "Contact" b ON a.id < b.id AND a."workspaceId" = b."workspaceId"
      WHERE a."workspaceId" = ${workspaceId} AND a."removedAt" IS NULL AND b."removedAt" IS NULL AND ((nullif(trim(a.email), '') IS NOT NULL AND lower(trim(a.email)) = lower(trim(b.email))) OR (a."organisationId" = b."organisationId" AND similarity(lower(a.name), lower(b.name)) >= ${duplicateThreshold()}))
    ) SELECT p.* FROM pairs p WHERE NOT EXISTS (SELECT 1 FROM "DuplicateDismissal" d WHERE d."workspaceId" = ${workspaceId} AND d.kind = p.kind AND d."leftId" = p."leftId" AND d."rightId" = p."rightId") ORDER BY kind, "leftId", "rightId" LIMIT 200`;
}
export async function dismissDuplicate(user: Actor, kind: "organisation" | "contact", firstId: string, secondId: string) {
  const workspaceId = await adminWorkspace(user);
  if (firstId === secondId) throw new ApiError(400, "Choose two different records.");
  const [leftId, rightId] = [firstId, secondId].sort();
  // Check both records within the actor's workspace before accepting arbitrary ids.
  const count = kind === "organisation" ? await db.organisation.count({ where: { workspaceId, id: { in: [leftId, rightId] } } }) : await db.contact.count({ where: { workspaceId, id: { in: [leftId, rightId] } } });
  if (count !== 2) throw new ApiError(404, "Records not found.");
  await db.$executeRaw`INSERT INTO "DuplicateDismissal" ("workspaceId", kind, "leftId", "rightId", "dismissedById") VALUES (${workspaceId}, ${kind}, ${leftId}, ${rightId}, ${user.id}) ON CONFLICT DO NOTHING`;
}

/** Concierge read only: name existing records instead of proposing an unsupported create. */
export async function findAccountRecords(user: Actor, text: string) {
  requireCrm(user);
  const workspaceId = (await db.user.findUniqueOrThrow({ where: { id: user.id }, select: { workspaceId: true } })).workspaceId;
  return db.$queryRaw<{ kind: string; id: string; name: string; organisationId: string }[]>`
    SELECT 'organisation' AS kind, id, name, id AS "organisationId" FROM "Organisation"
    WHERE "workspaceId" = ${workspaceId} AND (lower(name) = lower(${text}) OR similarity(lower(name), lower(${text})) >= ${duplicateThreshold()})
    UNION ALL
    SELECT 'contact', id, name, "organisationId" FROM "Contact"
    WHERE "workspaceId" = ${workspaceId} AND "removedAt" IS NULL AND (lower(email) = lower(${text}) OR similarity(lower(name), lower(${text})) >= ${duplicateThreshold()})
    LIMIT 10`;
}
