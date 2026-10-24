import { currentUser } from "@/lib/auth";
import { createDeal, listDeals } from "@/lib/deals";
import { ApiError, handle, parseBody } from "@/lib/http";
import { dealCreate } from "@/lib/schemas";

export const GET = handle(async (req: Request) => {
  const me = await currentUser();
  const sp = new URL(req.url).searchParams;
  const lifecycle = sp.get("lifecycle") ?? "all";
  if (lifecycle !== "sales" && lifecycle !== "delivery" && lifecycle !== "all") {
    throw new ApiError(400, "Lifecycle must be sales, delivery or all.");
  }
  return Response.json({ deals: await listDeals(me, { archived: sp.get("archived") === "true", mine: sp.get("mine") === "true", pipelineId: sp.get("pipelineId") ?? undefined, lifecycle }) });
});

export const POST = handle(async (req: Request) => {
  const me = await currentUser();
  const deal = await createDeal(me, await parseBody(req, dealCreate));
  return Response.json({ deal: { id: deal.id, name: deal.name } }, { status: 201 });
});
