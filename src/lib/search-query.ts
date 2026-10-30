import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { crmVisible, isAdmin, type Actor } from "@/lib/access";
import { SEARCH_LIMIT, SEARCH_MAX_QUERY, searchExcerpt, searchTerms, type SearchHit } from "./search-ranking";

type RankedRow = Omit<SearchHit, "excerpt"> & { document: string };

/** Database-owned ranking, shared by all consumers. Access predicates run before LIMIT. */
export async function rankedSearch(user: Actor, query: string, options: {
  archived?: boolean; tasksOnly?: boolean; projectId?: string; includeDone?: boolean; ideasOnly?: boolean;
} = {}): Promise<SearchHit[]> {
  const phrase = query.trim().slice(0, SEARCH_MAX_QUERY);
  const terms = searchTerms(phrase);
  if (phrase.length < 2 || !terms.length) return [];
  // Re-read current authority; never trust an earlier session's role or workspace.
  const actor = await db.user.findUniqueOrThrow({ where: { id: user.id }, select: { workspaceId: true, orgRole: true, deactivatedAt: true } });
  if (actor.deactivatedAt) return [];
  const current = { id: user.id, orgRole: actor.orgRole };
  const crm = crmVisible(current);
  const projectAccess = Prisma.sql`p."workspaceId" = ${actor.workspaceId}
    AND p."deletedAt" IS NULL
    AND (${!!options.archived} OR p."archivedAt" IS NULL)
    AND (${isAdmin(current)} OR EXISTS (SELECT 1 FROM "ProjectMember" m WHERE m."projectId"=p.id AND m."userId"=${user.id}))
    AND (${crm} OR p."typeId" <> 'wst_deal')
    AND (${options.projectId ?? null}::text IS NULL OR p.id=${options.projectId ?? null})`;
  const sources = [Prisma.sql`
    SELECT t.id, 'TASK'::text AS type, t.title, '/tasks/' || t.id AS href,
      'title'::text AS "matchedField", t.title AS document
    FROM "Task" t JOIN "Project" p ON p.id=t."projectId"
    WHERE ${projectAccess} AND t."workspaceId"=${actor.workspaceId} AND t."deletedAt" IS NULL
      AND (${options.includeDone !== false} OR t."completedAt" IS NULL)
      AND (${!options.ideasOnly} OR t."isIdea")
    UNION ALL
    SELECT t.id, 'TASK', t.title, '/tasks/' || t.id, 'description', COALESCE(t.description,'')
    FROM "Task" t JOIN "Project" p ON p.id=t."projectId"
    WHERE ${projectAccess} AND t."workspaceId"=${actor.workspaceId} AND t."deletedAt" IS NULL
      AND (${options.includeDone !== false} OR t."completedAt" IS NULL)
      AND (${!options.ideasOnly} OR t."isIdea")`];
  if (!options.tasksOnly) {
    sources.push(Prisma.sql`
      SELECT p.id, CASE WHEN p."typeId"='wst_deal' THEN 'DEAL' ELSE 'PROJECT' END,
        p.name, '/projects/' || p.id, 'title', p.name
      FROM "Project" p WHERE ${projectAccess}
      UNION ALL
      SELECT p.id, CASE WHEN p."typeId"='wst_deal' THEN 'DEAL' ELSE 'PROJECT' END,
        p.name, '/projects/' || p.id, 'description', COALESCE(p.description,'')
      FROM "Project" p WHERE ${projectAccess}`);
    if (crm && !options.ideasOnly) sources.push(Prisma.sql`
      SELECT p.id, 'DEAL', p.name, '/projects/' || p.id, 'deal details',
        d."whyPursue" || ' ' || COALESCE(d.need,'') || ' ' || COALESCE(d."serviceLine",'') || ' ' || COALESCE(d."introducedBy",'')
      FROM "DealDetails" d JOIN "Project" p ON p.id=d."projectId"
      WHERE ${projectAccess} AND p."typeId"='wst_deal' AND d."workspaceId"=${actor.workspaceId}
      UNION ALL
      SELECT o.id, 'ORGANISATION', o.name, '/accounts/' || o.id, 'name', o.name
      FROM "Organisation" o WHERE o."workspaceId"=${actor.workspaceId} AND (${!!options.archived} OR o."archivedAt" IS NULL)
      UNION ALL
      SELECT o.id, 'ORGANISATION', o.name, '/accounts/' || o.id, 'organisation details', COALESCE(o.kind,'') || ' ' || COALESCE(o.country,'')
      FROM "Organisation" o WHERE o."workspaceId"=${actor.workspaceId} AND (${!!options.archived} OR o."archivedAt" IS NULL)
      UNION ALL
      SELECT c.id, 'CONTACT', c.name, '/accounts/' || c."organisationId", 'name', c.name
      FROM "Contact" c JOIN "Organisation" o ON o.id=c."organisationId"
      WHERE c."workspaceId"=${actor.workspaceId} AND o."workspaceId"=${actor.workspaceId} AND c."removedAt" IS NULL AND (${!!options.archived} OR o."archivedAt" IS NULL)
      UNION ALL
      SELECT c.id, 'CONTACT', c.name, '/accounts/' || c."organisationId", 'contact details',
        COALESCE(c.role,'') || ' ' || COALESCE(c.email,'') || ' ' || COALESCE(c.phone,'')
      FROM "Contact" c JOIN "Organisation" o ON o.id=c."organisationId"
      WHERE c."workspaceId"=${actor.workspaceId} AND o."workspaceId"=${actor.workspaceId} AND c."removedAt" IS NULL AND (${!!options.archived} OR o."archivedAt" IS NULL)
      UNION ALL
      SELECT n.id, 'NOTE', o.name, '/accounts/' || o.id, 'note', n.text
      FROM "Note" n JOIN "Organisation" o ON o.id=n."organisationId" LEFT JOIN "Project" p ON p.id=n."projectId"
      WHERE n."workspaceId"=${actor.workspaceId} AND o."workspaceId"=${actor.workspaceId} AND n."removedAt" IS NULL
        AND (${!!options.archived} OR o."archivedAt" IS NULL)
        AND (n."projectId" IS NULL OR (${projectAccess}))
      UNION ALL
      SELECT p.id, 'DEAL', p.name, '/projects/' || p.id, 'note', n.text
      FROM "Note" n JOIN "Project" p ON p.id=n."projectId" JOIN "Organisation" o ON o.id=n."organisationId"
      WHERE ${projectAccess} AND p."typeId"='wst_deal' AND n."removedAt" IS NULL
        AND n."workspaceId"=${actor.workspaceId} AND o."workspaceId"=${actor.workspaceId} AND (${!!options.archived} OR o."archivedAt" IS NULL)`);
  }
  const termValues = Prisma.join(terms.map((term) => Prisma.sql`(${term}::text)`));
  const textQuery = Prisma.join(terms.map((term) => Prisma.sql`plainto_tsquery('english', ${term})`), " || ");
  const typos = terms.filter((term) => term.length >= 6);
  // Direct predicates let PostgreSQL push matching into each UNION branch and use
  // the expression indexes in the separately reviewed SQL draft.
  const typoMatch = typos.length
    ? Prisma.join(typos.map((term) => Prisma.sql`lower(document) %> ${term}`), " OR ")
    : Prisma.sql`false`;
  // The local setting belongs only to this transaction/connection, never the shared session.
  const rows = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('pg_trgm.word_similarity_threshold', '0.3', true), set_config('statement_timeout', '2000', true)`;
    return tx.$queryRaw<RankedRow[]>(Prisma.sql`
      WITH terms(word) AS (VALUES ${termValues}), source AS (${Prisma.join(sources, " UNION ALL ")}),
      scored AS (
        SELECT source.*,
          ARRAY(SELECT word FROM terms WHERE to_tsvector('english', document) @@ plainto_tsquery('english', word)
            OR (length(word)>=6 AND word <% lower(document))) AS "matchedWords",
          (CASE WHEN "matchedField" IN ('title','name') AND lower(document)=lower(${phrase}) THEN 100000
            WHEN "matchedField" IN ('title','name') AND strpos(lower(document),lower(${phrase}))>0 THEN 50000 ELSE 0 END
          + 1000 * (SELECT count(*) FROM terms WHERE to_tsvector('english', document) @@ plainto_tsquery('english', word))
          + 100 * (SELECT count(*) FROM terms WHERE length(word)>=6 AND word <% lower(document))
          + ts_rank_cd(to_tsvector('english', document), plainto_tsquery('english', ${phrase})))::double precision AS score
        FROM source
        WHERE to_tsvector('english', document) @@ (${textQuery}) OR (${typoMatch})
      ), coverage AS (
        SELECT type,id,count(DISTINCT word) AS count FROM scored CROSS JOIN LATERAL unnest("matchedWords") AS matched(word) GROUP BY type,id
      ), best AS (
        SELECT DISTINCT ON (type,id) * FROM scored ORDER BY type,id,score DESC,"matchedField",document
      ) SELECT best.id,best.type,best.title,best.href,best."matchedField",best.document,
          (best.score + coverage.count * 1000)::double precision AS score
        FROM best JOIN coverage USING (type,id)
        ORDER BY score DESC,type,id LIMIT ${SEARCH_LIMIT}`);
  });
  return rows.map(({ document, ...hit }) => ({ ...hit, excerpt: searchExcerpt(document, terms) }));
}
