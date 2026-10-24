import { currentUser } from "@/lib/auth";
import { handle } from "@/lib/http";
import { notesOfDeal } from "@/lib/records";

export const GET = handle(async (_r: Request, ctx: { params: Promise<{ id: string }> }) =>
  Response.json({ notes: await notesOfDeal(await currentUser(), (await ctx.params).id) }));
