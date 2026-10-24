import { currentUser } from "@/lib/auth";
import { handle, parseBody } from "@/lib/http";
import { sectionAdd } from "@/lib/schemas";
import { addSection } from "@/lib/sections";

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const me = await currentUser();
  const { name } = await parseBody(req, sectionAdd);
  const s = await addSection(me, (await ctx.params).id, name);
  return Response.json({ section: { id: s.id, name: s.name, position: s.position, isDone: s.isDone } }, { status: 201 });
});
