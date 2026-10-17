import { currentUser } from "@/lib/auth";
import { handle, parseBody } from "@/lib/http";
import { createContact, listContacts } from "@/lib/records";
import { contactCreate } from "@/lib/schemas";

type Ctx = { params: Promise<{ id: string }> };
export const GET = handle(async (_r: Request, ctx: Ctx) => Response.json({ contacts: await listContacts(await currentUser(), (await ctx.params).id) }));
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const me = await currentUser();
  const c = await createContact(me, (await ctx.params).id, await parseBody(req, contactCreate));
  return Response.json({ contact: { id: c.id, name: c.name } }, { status: 201 });
});
