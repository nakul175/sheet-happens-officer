import { z } from "zod";
import { currentUser } from "@/lib/auth";
import { handle, parseBody } from "@/lib/http";
import { getPerson, setOrgRole } from "@/lib/team";

// SHO-US-2.2. "SUPER_ADMIN" is not an accepted value, so it fails validation.
const body = z.object({ orgRole: z.enum(["MEMBER", "ADMIN"]) });

export const PATCH = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const me = await currentUser();
  const { orgRole } = await parseBody(req, body);
  await setOrgRole(me, (await ctx.params).id, orgRole);
  return Response.json({ status: "ok" });
});

// SHO-US-15.4.
export const GET = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const me = await currentUser();
  return Response.json({ person: await getPerson(me, (await ctx.params).id) });
});
