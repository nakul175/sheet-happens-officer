import { currentUser } from "@/lib/auth";
import { handle, parseBody } from "@/lib/http";
import { archiveOrganisation } from "@/lib/orgs";
import { orgArchive } from "@/lib/schemas";

type Ctx = { params: Promise<{ id: string }> };

export const POST = handle(async (req: Request, ctx: Ctx) => {
  const me = await currentUser();
  const { archive } = await parseBody(req, orgArchive);
  await archiveOrganisation(me, (await ctx.params).id, archive);
  return Response.json({ status: "ok" });
});
