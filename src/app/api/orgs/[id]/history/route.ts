import { currentUser } from "@/lib/auth";
import { handle } from "@/lib/http";
import { organisationHistory } from "@/lib/orgs";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle(async (_req: Request, ctx: Ctx) =>
  Response.json({ items: await organisationHistory(await currentUser(), (await ctx.params).id) }),
);
