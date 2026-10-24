import { currentUser } from "@/lib/auth";
import { handle, parseBody } from "@/lib/http";
import { getOrganisation, updateOrganisation } from "@/lib/orgs";
import { listContacts, notesOfOrganisation, orgTree, tasksLinkedHere } from "@/lib/records";
import { orgUpdate } from "@/lib/schemas";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle(async (_req: Request, ctx: Ctx) => {
  const me = await currentUser();
  const id = (await ctx.params).id;
  const organisation = await getOrganisation(me, id);
  const [contacts, notes, tasks, tree] = await Promise.all([listContacts(me, id), notesOfOrganisation(me, id), tasksLinkedHere(me, { organisationId: id }), orgTree(me, id)]);
  return Response.json({ organisation: { ...organisation, contacts, notes, tasks, tree } });
});

export const PATCH = handle(async (req: Request, ctx: Ctx) => {
  const me = await currentUser();
  await updateOrganisation(me, (await ctx.params).id, await parseBody(req, orgUpdate));
  return Response.json({ status: "ok" });
});
