import { currentUser } from "@/lib/auth";
import { createDeal, listDeals } from "@/lib/deals";
import { handle, parseBody } from "@/lib/http";
import { dealCreate } from "@/lib/schemas";

export const GET = handle(async (req: Request) => {
  const me = await currentUser();
  const sp = new URL(req.url).searchParams;
  return Response.json({ deals: await listDeals(me, { archived: sp.get("archived") === "true", mine: sp.get("mine") === "true", pipelineId: sp.get("pipelineId") ?? undefined, organisationId: sp.get("organisationId") ?? undefined }) });
});

export const POST = handle(async (req: Request) => {
  const me = await currentUser();
  const deal = await createDeal(me, await parseBody(req, dealCreate));
  return Response.json({ deal: { id: deal.id, name: deal.name } }, { status: 201 });
});
