import { currentUser } from "@/lib/auth";
import { handle, parseBody } from "@/lib/http";
import { getContact, removeContact, updateContact } from "@/lib/records";
import { contactUpdate } from "@/lib/schemas";

type Ctx = { params: Promise<{ id: string }> };
export const GET = handle(async (_r: Request, ctx: Ctx) => Response.json({ contact: await getContact(await currentUser(), (await ctx.params).id) }));
export const PATCH = handle(async (req: Request, ctx: Ctx) => {
  await updateContact(await currentUser(), (await ctx.params).id, await parseBody(req, contactUpdate));
  return Response.json({ status: "ok" });
});
export const DELETE = handle(async (_r: Request, ctx: Ctx) => {
  await removeContact(await currentUser(), (await ctx.params).id);
  return new Response(null, { status: 204 });
});
