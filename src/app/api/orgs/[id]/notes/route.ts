import { currentUser } from "@/lib/auth";
import { handle, parseBody } from "@/lib/http";
import { createNote, notesOfOrganisation } from "@/lib/records";
import { noteCreate } from "@/lib/schemas";

type Ctx = { params: Promise<{ id: string }> };
export const GET = handle(async (_r: Request, ctx: Ctx) => Response.json({ notes: await notesOfOrganisation(await currentUser(), (await ctx.params).id) }));
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const me = await currentUser();
  const n = await createNote(me, (await ctx.params).id, await parseBody(req, noteCreate));
  return Response.json({ note: { id: n.id } }, { status: 201 });
});
