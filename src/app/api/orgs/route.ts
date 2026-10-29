import { currentUser } from "@/lib/auth";
import { handle, parseBody } from "@/lib/http";
import { createOrganisation, listOrganisations } from "@/lib/orgs";
import { orgCreate } from "@/lib/schemas";

export const GET = handle(async (req: Request) => {
  const me = await currentUser();
  const sp = new URL(req.url).searchParams;
  return Response.json({ organisations: await listOrganisations(me, { q: sp.get("q") ?? undefined, kind: sp.get("kind") ?? undefined, country: sp.get("country") ?? undefined, archived: sp.get("archived") === "true" }) });
});

export const POST = handle(async (req: Request) => {
  const me = await currentUser();
  const org = await createOrganisation(me, await parseBody(req, orgCreate));
  return Response.json({ organisation: { id: org.id, name: org.name } }, { status: 201 });
});
